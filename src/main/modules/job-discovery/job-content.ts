import {
  parse,
  parseFragment,
  type DefaultTreeAdapterTypes as Tree,
} from 'parse5';
import { WEB_LIMITS, type PageReadResult } from '../../../shared/contracts';

type Node = Tree.Node;
type Element = Tree.Element;
type ContentErrorCode = 'JOB_CONTENT_UNAVAILABLE' | 'JOB_CONTENT_INCOMPLETE';

export class JobContentError extends Error {
  constructor(readonly code: ContentErrorCode) {
    super(code);
  }
}

interface Region {
  element: Element;
  text: string;
  explicit: boolean;
}

const MAX_NODES = 100_000;
const MAX_DEPTH = 128;
const MAX_JSON_POSTINGS = 100;
const MAX_REGIONS = 100;
const EXCLUDED_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'footer',
  'aside',
  'form',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'svg',
]);
const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'main',
  'header',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'ul',
  'ol',
  'br',
  'tr',
  'td',
]);
const UNRELATED_REGION =
  /(?:related|similar|recommended)[-_\s]*(?:jobs?|roles?|positions?)|cookie|consent|newsletter|job[-_\s]*alerts?|application[-_\s]*form/i;
const JOB_REGION =
  /(?:job|posting|vacancy|position)[-_\s]*(?:description|details|content)|(?:description|details)[-_\s]*(?:job|posting)|jobsearch-jobDescriptionText|show-more-less-html__markup/i;
const SECTION_CUES =
  /\b(?:responsibilities|requirements|qualifications|about the role|your role|what you(?:'|’)ll do|what we offer)\b/i;
const JOB_METADATA =
  /(?:job|posting)[-_\s]*(?:title|location|company|salary|employment)|company[-_\s]*name|posting-headline/i;
const METADATA_PROPERTIES = new Set([
  'title',
  'hiringOrganization',
  'jobLocation',
  'employmentType',
  'baseSalary',
]);

const normalize = (text: string) => text.replace(/\s+/gu, ' ').trim();

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function children(node: Node): Tree.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function attribute(node: Element, name: string): string {
  return node.attrs.find((attr) => attr.name === name)?.value ?? '';
}

function regionLabel(node: Element): string {
  return ['id', 'class', 'data-testid', 'aria-label']
    .map((name) => attribute(node, name))
    .join(' ');
}

function isExcluded(node: Element): boolean {
  return (
    EXCLUDED_TAGS.has(node.tagName) ||
    node.attrs.some((attr) => attr.name === 'hidden') ||
    attribute(node, 'aria-hidden').toLowerCase() === 'true' ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(
      attribute(node, 'style'),
    ) ||
    UNRELATED_REGION.test(regionLabel(node))
  );
}

/** Iterative, bounded DOM walk; a budget breach never yields partial evidence. */
function walk(
  root: Node,
  visit: (node: Node) => boolean | void,
  leave?: (node: Node) => void,
): void {
  const stack = [{ node: root, depth: 0, exiting: false }];
  let visited = 0;
  while (stack.length) {
    const { node, depth, exiting } = stack.pop()!;
    if (exiting) {
      leave?.(node);
      continue;
    }

    if (++visited > MAX_NODES || depth > MAX_DEPTH) {
      throw new JobContentError('JOB_CONTENT_INCOMPLETE');
    }
    if (visit(node) === false) continue;

    if (leave) stack.push({ node, depth, exiting: true });
    for (const child of children(node).toReversed()) {
      stack.push({ node: child, depth: depth + 1, exiting: false });
    }
  }
}

function readableText(root: Node): string {
  const parts: string[] = [];
  const separateBlock = (node: Node) => {
    if (isElement(node) && BLOCK_TAGS.has(node.tagName)) parts.push('\n');
  };
  walk(
    root,
    (node) => {
      if (isElement(node) && isExcluded(node)) return false;
      separateBlock(node);
      if (node.nodeName === '#text' && 'value' in node) parts.push(node.value);
    },
    separateBlock,
  );

  return parts.join('').split('\n').map(normalize).filter(Boolean).join('\n');
}

function isExplicitRegion(node: Element): boolean {
  return (
    /(?:^|\/)JobPosting$/.test(attribute(node, 'itemtype')) ||
    JOB_REGION.test(regionLabel(node))
  );
}

function contains(ancestor: Element, node: Element): boolean {
  let parent: Node | null = node;
  while (parent) {
    if (parent === ancestor) return true;
    parent = 'parentNode' in parent ? parent.parentNode : null;
  }
  return false;
}

function roleHeadings(root: Element): Element[] {
  const headings: Element[] = [];
  walk(root, (node) => {
    if (!isElement(node)) return;
    if (isExcluded(node)) return false;
    if (node.tagName === 'h1') headings.push(node);
  });
  return headings;
}

function regionWithMetadata(region: Region): string | null {
  let scope = region.element;
  while (!['main', 'article'].includes(scope.tagName)) {
    const parent = scope.parentNode;
    if (!parent || !isElement(parent) || parent.tagName === 'body') break;
    scope = parent;
  }
  if (roleHeadings(scope).length > 1) return null;

  const parts: string[] = [];
  walk(scope, (node) => {
    if (!isElement(node)) return;
    if (isExcluded(node)) return false;
    if (node === region.element) {
      parts.push(region.text);
      return false;
    }

    const properties = attribute(node, 'itemprop').split(/\s+/);
    const isMetadata =
      node.tagName === 'h1' ||
      properties.some((property) => METADATA_PROPERTIES.has(property)) ||
      JOB_METADATA.test(regionLabel(node));
    if (isMetadata && !contains(node, region.element)) {
      parts.push(readableText(node));
      return false;
    }
  });

  return parts.filter(Boolean).join('\n');
}

function hasSingleRoleHeading(region: Region): boolean {
  const headings = roleHeadings(region.element);
  if (headings.length > 1) return false;
  if (region.explicit) return true;
  if (headings.length !== 1) return false;

  return !/^(?:jobs?|careers?|vacancies|opportunities)\b/i.test(
    readableText(headings[0]),
  );
}

function selectRegion(elements: Element[], visibleText: string): string | null {
  const candidates = elements.filter(
    (element) =>
      isExplicitRegion(element) ||
      ['main', 'article'].includes(element.tagName),
  );
  if (candidates.length > MAX_REGIONS) {
    throw new JobContentError('JOB_CONTENT_INCOMPLETE');
  }

  const regions: Region[] = candidates
    .map((element) => ({
      element,
      explicit: isExplicitRegion(element),
      text: readableText(element),
    }))
    .filter(
      (region) =>
        region.text && (region.explicit || SECTION_CUES.test(region.text)),
    );

  const explicit = regions.filter((region) => region.explicit);
  const eligible = explicit.length ? explicit : regions;
  // Keep a complete explicit posting, including nested description sections.
  // For generic article/main wrappers prefer the narrower article instead.
  const distinct = eligible.filter(
    (region) =>
      !eligible.some(
        (other) =>
          other !== region &&
          (explicit.length
            ? contains(other.element, region.element)
            : contains(region.element, other.element)),
      ),
  );
  if (distinct.length !== 1) return null;

  const selected = distinct[0];
  if (!hasSingleRoleHeading(selected)) return null;

  const content = regionWithMetadata(selected);
  if (!content) return null;
  // The HTML snapshot cannot resolve external CSS. The browser's visible-text
  // capture is the authority: never promote CSS-hidden text into model evidence.
  const isVisible = content
    .split('\n')
    .every((line) => visibleText.includes(normalize(line)));
  return isVisible ? content : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonPostings(scripts: Element[]): Record<string, unknown>[] {
  const postings: Record<string, unknown>[] = [];
  for (const script of scripts) {
    const raw = children(script)
      .flatMap((node) => ('value' in node ? [node.value] : []))
      .join('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }

    const pending: unknown[] = [parsed];
    let visited = 0;
    while (pending.length) {
      if (++visited > MAX_NODES) {
        throw new JobContentError('JOB_CONTENT_INCOMPLETE');
      }
      const value = pending.pop();
      if (Array.isArray(value)) {
        for (const item of value) pending.push(item);
      }
      if (!isRecord(value)) continue;

      const types = Array.isArray(value['@type'])
        ? value['@type']
        : [value['@type']];
      if (
        types.some(
          (type) =>
            type === 'JobPosting' || type === 'https://schema.org/JobPosting',
        )
      ) {
        postings.push(value);
      }
      if (postings.length > MAX_JSON_POSTINGS) {
        throw new JobContentError('JOB_CONTENT_INCOMPLETE');
      }
      if (value['@graph']) pending.push(value['@graph']);
    }
  }
  return postings;
}

function structuredSource(
  scripts: Element[],
  page: PageReadResult,
): string | null {
  const postings = jsonPostings(scripts);
  const matching = postings.filter((posting) => {
    if (typeof posting.title !== 'string' || !posting.title.trim())
      return false;
    const titleMatches = normalize(page.title)
      .toLowerCase()
      .includes(normalize(posting.title).toLowerCase());
    const urlMatches =
      typeof posting.url === 'string' &&
      posting.url.replace(/\/$/, '') === page.url.replace(/\/$/, '');
    return titleMatches || urlMatches;
  });
  if (matching.length !== 1) return null;

  const posting = matching[0];
  if (typeof posting.description !== 'string') return null;
  const description = readableText(parseFragment(posting.description));
  // JSON-LD can be stale or describe another role. Require the entire
  // description to be present in the captured visible text.
  if (!description || !normalize(page.text).includes(normalize(description))) {
    return null;
  }

  const employer = isRecord(posting.hiringOrganization)
    ? posting.hiringOrganization.name
    : null;
  const identity = [posting.title, employer].filter(
    (value): value is string =>
      typeof value === 'string' &&
      normalize(page.text).includes(normalize(value)),
  );
  return [...identity, description].join('\n');
}

/** Select complete job evidence without feeding the surrounding page to AI. */
export function selectJobContent(page: PageReadResult): string {
  if (
    page.truncated.html ||
    page.truncated.text ||
    page.html.length > WEB_LIMITS.maxHtmlBytes
  ) {
    throw new JobContentError('JOB_CONTENT_INCOMPLETE');
  }

  const document = parse(page.html);
  const elements: Element[] = [];
  const scripts: Element[] = [];
  walk(document, (node) => {
    if (!isElement(node)) return;
    if (
      node.tagName === 'script' &&
      attribute(node, 'type').toLowerCase() === 'application/ld+json'
    ) {
      scripts.push(node);
    }
    if (isExcluded(node)) return false;
    elements.push(node);
  });

  const visibleText = normalize(`${page.title}\n${page.text}`);
  const content =
    selectRegion(elements, visibleText) ?? structuredSource(scripts, page);
  if (!content) throw new JobContentError('JOB_CONTENT_UNAVAILABLE');

  return `${page.title.trim()}\n${content}`.trim();
}

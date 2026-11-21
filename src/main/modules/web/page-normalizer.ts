import { parse, type DefaultTreeAdapterTypes as Tree } from 'parse5';
import {
  WEB_LIMITS,
  type StructuredBlock,
  type StructuredPage,
} from '../../../shared/contracts/web';

type Node = Tree.Node;
type Element = Tree.Element;
type Link = { text: string; href: string };
type ListItem = { text: string; links?: Link[] };
type RefKind = 'scripts' | 'stylesheets';
type PageSnapshot = { url: string; title: string; html: string };

/** Pending emission work: either a node still to walk or a finished block. */
type WorkItem =
  | { node: Node; depth: number }
  | { block: StructuredBlock; depth: number };

/** Tags whose content is never part of the readable page. */
const HIDDEN_TAGS = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'nav',
  'header',
  'footer',
  'aside',
  'form',
  'iframe',
  'svg',
]);

/** Allowance over `maxHtmlBytes` for markup the reader adds around a capped page. */
const HTML_SLACK_CHARS = 1024;

/** Shared node-visit budget for the document and emission walks. */
const MAX_VISITS = 100_000;

/** Per-container node budget for text extraction and nested-list scans. */
const MAX_TEXT_NODES = 20_000;

const MAX_DEPTH = 128;

const DISPLAY_NONE_STYLE = /(?:^|;)\s*display\s*:\s*none\b/i;

const HEADING_TAG = /^h[1-6]$/;

function isElement(node: Node): node is Element {
  return 'tagName' in node;
}

function childrenOf(node: Node): Tree.ChildNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}

function attr(node: Element, name: string): string | undefined {
  return node.attrs.find((a) => a.name === name)?.value;
}

function isExcluded(node: Element): boolean {
  return (
    HIDDEN_TAGS.has(node.tagName) ||
    attr(node, 'hidden') !== undefined ||
    attr(node, 'aria-hidden')?.toLowerCase() === 'true' ||
    DISPLAY_NONE_STYLE.test(attr(node, 'style') ?? '')
  );
}

function isList(node: Element): boolean {
  return node.tagName === 'ol' || node.tagName === 'ul';
}

function isStylesheetLink(node: Element): boolean {
  const rel = (attr(node, 'rel') ?? '').toLowerCase().split(/\s+/);

  return node.tagName === 'link' && rel.includes('stylesheet');
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function textValue(node: Node): string {
  return (node as Tree.TextNode).value;
}

/**
 * Pure, adapter-independent transformation of a bounded neutral DOM snapshot.
 *
 * Every limit that drops content sets `truncated`; the serialized result never
 * exceeds `WEB_LIMITS.maxStructuredBytes`.
 */
export function normalizePage(snapshot: PageSnapshot): StructuredPage {
  // parse5 repairs ordinary malformed HTML and decodes entities; a genuinely
  // unparseable/over-budget input is reported as an error by the service.
  const oversized =
    snapshot.html.length > WEB_LIMITS.maxHtmlBytes + HTML_SLACK_CHARS;
  if (!snapshot.html.trim() || oversized) {
    throw new Error('Invalid page snapshot');
  }

  return new PageNormalizer(snapshot).run(parse(snapshot.html));
}

/** Single-use state holder for one {@link normalizePage} call. */
class PageNormalizer {
  private readonly result: StructuredPage;
  private visits = 0;

  constructor(snapshot: PageSnapshot) {
    this.result = {
      schemaVersion: 1,
      url: snapshot.url,
      title: snapshot.title,
      scripts: [],
      stylesheets: [],
      content: { blocks: [] },
      truncated: false,
    };
  }

  run(document: Node): StructuredPage {
    const root = this.collectDocument(document);
    this.emitBlocks(root);

    return this.result;
  }

  /**
   * Walk the whole document once: collect script/stylesheet references (even
   * when main/article later wins) and choose the content root.
   */
  private collectDocument(document: Node): Element {
    const regions: Element[] = [];
    let body: Element | undefined;
    const stack: { node: Node; depth: number }[] = [
      { node: document, depth: 0 },
    ];

    while (stack.length) {
      const { node, depth } = stack.pop()!;
      if (!this.spendVisit() || depth > MAX_DEPTH) {
        this.result.truncated = true;
        continue;
      }

      if (isElement(node)) {
        this.collectRefs(node);
        if (isExcluded(node)) continue;

        if (node.tagName === 'body') body = node;
        if (node.tagName === 'main' || node.tagName === 'article') {
          regions.push(node);
        }
      }

      for (const child of childrenOf(node).toReversed()) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }

    return selectContentRoot(regions, body);
  }

  private collectRefs(node: Element): void {
    if (node.tagName === 'script') this.addRef('scripts', attr(node, 'src'));
    if (isStylesheetLink(node)) this.addRef('stylesheets', attr(node, 'href'));
  }

  /** Depth-first emission of blocks from the chosen content root. */
  private emitBlocks(root: Element): void {
    const work: WorkItem[] = [{ node: root, depth: 0 }];

    while (work.length) {
      const entry = work.pop()!;
      if ('block' in entry) {
        this.addBlock(entry.block);
        continue;
      }

      const { node, depth } = entry;
      if (!this.spendVisit() || depth > MAX_DEPTH) {
        this.result.truncated = true;
        continue;
      }

      if (isElement(node)) {
        if (isExcluded(node)) continue;
        if (this.emitElement(node, depth, work)) continue;
      }

      // Generic containers preserve content; loose text is emitted as a paragraph.
      if (node.nodeName === '#text') {
        const text = this.bounded(collapseWhitespace(textValue(node)));
        if (text) this.addBlock({ type: 'paragraph', text });
      } else {
        for (const child of childrenOf(node).toReversed()) {
          work.push({ node: child, depth: depth + 1 });
        }
      }
    }
  }

  /** Emit a block-level element; returns false for generic containers. */
  private emitElement(node: Element, depth: number, work: WorkItem[]): boolean {
    const tag = node.tagName;

    if (HEADING_TAG.test(tag)) {
      this.emitHeading(node);
      return true;
    }

    if (tag === 'p') {
      this.emitParagraph(node);
      return true;
    }

    if (isList(node)) {
      for (const segment of this.listSegments(node, depth).toReversed()) {
        work.push(segment);
      }
      return true;
    }

    if (tag === 'table') {
      this.emitTable(node);
      return true;
    }

    if (tag === 'a' && attr(node, 'href')) {
      this.emitLink(node);
      return true;
    }

    return false;
  }

  private emitHeading(node: Element): void {
    const { text } = this.textOf(node);
    if (!text) return;

    const id = attr(node, 'id');
    this.addBlock({
      type: 'heading',
      level: Number(node.tagName[1]),
      ...(id ? { id: this.bounded(id) } : {}),
      text,
    });
  }

  private emitParagraph(node: Element): void {
    const { text, links } = this.textOf(node);
    if (!text) return;

    this.addBlock({
      type: 'paragraph',
      text,
      ...(links.length ? { links } : {}),
    });
  }

  private emitLink(node: Element): void {
    const text = this.bounded(collapseWhitespace(this.flatText(node)));
    if (!text) return;

    this.addBlock({
      type: 'link',
      text,
      href: this.bounded(attr(node, 'href')!, WEB_LIMITS.maxUrlChars),
    });
  }

  /**
   * Split a list into ordered segments. A list item owns its own text, while
   * nested lists are emitted separately (in document order) and interrupt the
   * parent list into consecutive list blocks.
   */
  private listSegments(node: Element, depth: number): WorkItem[] {
    const ordered = node.tagName === 'ol';
    const segments: WorkItem[] = [];
    let items: ListItem[] = [];
    let count = 0;

    const flush = (): void => {
      if (items.length) {
        segments.push({ block: { type: 'list', ordered, items }, depth });
      }
      items = [];
    };

    const listItems = childrenOf(node).filter(
      (child): child is Element => isElement(child) && child.tagName === 'li',
    );

    for (const li of listItems) {
      if (isExcluded(li)) continue;

      if (++count > WEB_LIMITS.maxStructuredItems) {
        this.result.truncated = true;
        break;
      }

      const { text, links } = this.textOf(li, true);
      if (text) items.push({ text, ...(links.length ? { links } : {}) });

      for (const nested of this.nestedLists(li)) {
        flush();
        segments.push({ node: nested, depth: depth + 1 });
      }
    }

    flush();

    return segments;
  }

  /** Visible nested lists within a list item, in document order. */
  private nestedLists(li: Element): Element[] {
    const found: Element[] = [];
    const descendants: Node[] = [...childrenOf(li)].reverse();
    let seen = 0;

    while (descendants.length) {
      if (++seen > MAX_TEXT_NODES) {
        this.result.truncated = true;
        break;
      }

      const child = descendants.pop()!;
      if (!isElement(child) || isExcluded(child)) continue;

      if (isList(child)) {
        found.push(child);
      } else {
        for (const descendant of childrenOf(child).toReversed()) {
          descendants.push(descendant);
        }
      }
    }

    return found;
  }

  /** Table cells own table text; rows and cells are capped. */
  private emitTable(table: Element): void {
    const rows: string[][] = [];
    const pending: Node[] = [table];

    while (pending.length) {
      const node = pending.pop()!;
      if (!isElement(node) || isExcluded(node)) continue;

      if (node.tagName !== 'tr') {
        for (const child of childrenOf(node).toReversed()) pending.push(child);
        continue;
      }

      if (rows.length >= WEB_LIMITS.maxStructuredRows) {
        this.result.truncated = true;
        break;
      }

      rows.push(this.rowCells(node));
    }

    if (rows.length) this.addBlock({ type: 'table', rows });
  }

  private rowCells(row: Element): string[] {
    const cells = childrenOf(row).filter(
      (cell): cell is Element =>
        isElement(cell) &&
        (cell.tagName === 'td' || cell.tagName === 'th') &&
        !isExcluded(cell),
    );
    if (cells.length > WEB_LIMITS.maxStructuredCells) {
      this.result.truncated = true;
    }

    return cells
      .slice(0, WEB_LIMITS.maxStructuredCells)
      .map((cell) => this.textOf(cell).text);
  }

  /**
   * Visible text of a container plus the links it owns. Anchor text still
   * participates in the container text. With `omitLists`, nested lists are
   * skipped because they are emitted separately.
   */
  private textOf(
    node: Node,
    omitLists = false,
  ): { text: string; links: Link[] } {
    const parts: string[] = [];
    const links: Link[] = [];
    const pending: { node: Node; depth: number }[] = [{ node, depth: 0 }];
    let seen = 0;

    while (pending.length) {
      const current = pending.pop()!;
      if (++seen > MAX_TEXT_NODES || current.depth > MAX_DEPTH) {
        this.result.truncated = true;
        break;
      }

      const item = current.node;
      if (item.nodeName === '#text') {
        parts.push(textValue(item));
        continue;
      }

      if (isElement(item)) {
        const isNestedList = omitLists && item !== node && isList(item);
        if (isExcluded(item) || isNestedList) continue;

        if (item.tagName === 'a' && attr(item, 'href')) {
          this.collectLink(item, links);
        }
      }

      for (const child of childrenOf(item).toReversed()) {
        pending.push({ node: child, depth: current.depth + 1 });
      }
    }

    return { text: this.bounded(collapseWhitespace(parts.join(''))), links };
  }

  private collectLink(anchor: Element, links: Link[]): void {
    const linkText = collapseWhitespace(this.flatText(anchor));
    if (!linkText) return;

    if (links.length >= WEB_LIMITS.maxStructuredItems) {
      this.result.truncated = true;
      return;
    }

    links.push({
      text: this.bounded(linkText),
      href: this.bounded(attr(anchor, 'href')!, WEB_LIMITS.maxUrlChars),
    });
  }

  /** Raw concatenated visible text, ignoring structure. */
  private flatText(node: Node): string {
    const parts: string[] = [];
    const pending: Node[] = [node];
    let seen = 0;

    while (pending.length) {
      const current = pending.pop()!;
      if (++seen > MAX_TEXT_NODES) {
        this.result.truncated = true;
        break;
      }

      if (current.nodeName === '#text') {
        parts.push(textValue(current));
      } else if (!isElement(current) || !isExcluded(current)) {
        for (const child of childrenOf(current).toReversed()) {
          pending.push(child);
        }
      }
    }

    return parts.join('');
  }

  private spendVisit(): boolean {
    if (++this.visits > MAX_VISITS) {
      this.result.truncated = true;
      return false;
    }

    return true;
  }

  private bounded(
    value: string,
    max: number = WEB_LIMITS.maxStructuredTextChars,
  ): string {
    if (value.length > max) this.result.truncated = true;

    return value.slice(0, max);
  }

  private fitsByteBudget(): boolean {
    const bytes = new TextEncoder().encode(JSON.stringify(this.result)).length;

    return bytes <= WEB_LIMITS.maxStructuredBytes;
  }

  private addBlock(block: StructuredBlock): void {
    const { blocks } = this.result.content;
    if (blocks.length >= WEB_LIMITS.maxStructuredBlocks) {
      this.result.truncated = true;
      return;
    }

    blocks.push(block);
    if (!this.fitsByteBudget()) {
      blocks.pop();
      this.result.truncated = true;
    }
  }

  private addRef(kind: RefKind, value?: string): void {
    if (!value) return;

    const refs = this.result[kind];
    const overLimit =
      value.length > WEB_LIMITS.maxUrlChars ||
      refs.length >= WEB_LIMITS.maxStructuredRefs;
    if (overLimit) {
      this.result.truncated = true;
      return;
    }

    if (refs.includes(value)) return;

    refs.push(value);
    if (!this.fitsByteBudget()) {
      refs.pop();
      this.result.truncated = true;
    }
  }
}

/** One unambiguous main wins; otherwise a single article; otherwise body. */
function selectContentRoot(regions: Element[], body?: Element): Element {
  const mains = regions.filter((region) => region.tagName === 'main');
  const articles = regions.filter((region) => region.tagName === 'article');

  if (mains.length === 1) return mains[0];
  if (articles.length === 1) return articles[0];
  if (!body) throw new Error('No document body');

  return body;
}

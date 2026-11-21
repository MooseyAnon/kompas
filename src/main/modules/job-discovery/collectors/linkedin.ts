import { parse } from 'parse5';
import {
  JOB_DISCOVERY_LIMITS,
  type PageReadResult,
} from '../../../../shared/contracts';
import {
  extractStructuredCollection,
  listingIdentity,
  safeUrl,
  type CandidateObservation,
} from './shared';
import { descendants, htmlAttr, htmlText, type HtmlElement } from './dom';

const MAX_DOCUMENT_NODES = 100_000;
const MAX_CARD_NODES = 3_000;
const MAX_TITLE_CHARS = 400;
const MAX_FIELD_CHARS = 200;
const MAX_POSTING_AGE_CHARS = 100;

function hasClass(node: HtmlElement, className: string): boolean {
  return (htmlAttr(node, 'class') ?? '').split(/\s+/).includes(className);
}

function extractLinkedInCards(
  html: string,
  origin: URL,
): { foundCards: boolean; items: CandidateObservation[] } {
  const cards = descendants(parse(html), MAX_DOCUMENT_NODES).filter(
    (node) => node.tagName === 'div' && hasClass(node, 'base-search-card'),
  );

  const items: CandidateObservation[] = [];
  for (const card of cards.slice(
    0,
    JOB_DISCOVERY_LIMITS.maxInspectedCandidates,
  )) {
    const nodes = descendants(card, MAX_CARD_NODES);
    const field = (tag: string, className: string, max: number) => {
      const node = nodes.find(
        (entry) => entry.tagName === tag && hasClass(entry, className),
      );
      return node ? htmlText(node, max) : null;
    };

    const link = nodes.find(
      (node) => node.tagName === 'a' && hasClass(node, 'base-card__full-link'),
    );
    const url =
      link && safeUrl(htmlAttr(link, 'href') ?? '', origin.toString());
    const identity = url && listingIdentity(url);
    if (identity?.provider !== 'linkedin' || !url) continue;

    const title = field('h3', 'base-search-card__title', MAX_TITLE_CHARS);
    const company = field('h4', 'base-search-card__subtitle', MAX_FIELD_CHARS);
    if (!title || !company) continue;

    items.push({
      ...identity,
      discoveredUrl: url.toString(),
      collectionUrl: origin.toString(),
      title,
      company,
      location: field('span', 'job-search-card__location', MAX_FIELD_CHARS),
      postingAge: field(
        'time',
        'job-search-card__listdate',
        MAX_POSTING_AGE_CHARS,
      ),
    });
  }

  return { foundCards: cards.length > 0, items };
}

export function extractLinkedInCollection(
  page: PageReadResult,
  origin: URL,
): CandidateObservation[] {
  if (page.html.trim()) {
    const cards = extractLinkedInCards(page.html, origin);
    if (cards.foundCards) return cards.items;
  }

  return extractStructuredCollection(page, origin, 'linkedin');
}

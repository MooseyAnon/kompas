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
import { descendants, htmlAttr, htmlText } from './dom';

const MAX_DOCUMENT_NODES = 100_000;
const MAX_CARD_NODES = 3_000;
const MAX_TITLE_CHARS = 400;
const MAX_FIELD_CHARS = 200;

/**
 * Indeed's card DOM keeps the employer and location separate; its generic text
 * blocks do not.
 */
function extractIndeedCards(
  html: string,
  origin: URL,
): { foundCards: boolean; items: CandidateObservation[] } {
  const cards = descendants(parse(html), MAX_DOCUMENT_NODES).filter(
    (node) =>
      node.tagName === 'div' &&
      /(?:^|\s)cardOutline(?:\s|$)/.test(htmlAttr(node, 'class') ?? '') &&
      /(?:^|\s)tapItem(?:\s|$)/.test(htmlAttr(node, 'class') ?? ''),
  );

  const items: CandidateObservation[] = [];
  for (const card of cards.slice(
    0,
    JOB_DISCOVERY_LIMITS.maxInspectedCandidates,
  )) {
    const nodes = descendants(card, MAX_CARD_NODES);
    const link = nodes.find(
      (node) =>
        node.tagName === 'a' &&
        /(?:^|\s)jcs-JobTitle(?:\s|$)/.test(htmlAttr(node, 'class') ?? ''),
    );
    const url =
      link && safeUrl(htmlAttr(link, 'href') ?? '', origin.toString());
    const identity = url && listingIdentity(url);
    if (
      !link ||
      !url ||
      identity?.provider !== 'indeed' ||
      htmlAttr(link, 'data-jk')?.toLowerCase() !== identity.key
    )
      continue;

    const title = htmlText(link, MAX_TITLE_CHARS);
    if (!title) continue;

    const field = (testId: string) => {
      const node = nodes.find(
        (entry) => htmlAttr(entry, 'data-testid') === testId,
      );
      return node ? htmlText(node, MAX_FIELD_CHARS) : null;
    };

    items.push({
      ...identity,
      discoveredUrl: url.toString(),
      collectionUrl: origin.toString(),
      title,
      company: field('company-name'),
      location: field('text-location'),
      postingAge: null,
    });
  }

  return { foundCards: cards.length > 0, items };
}

export function extractIndeedCollection(
  page: PageReadResult,
  origin: URL,
): CandidateObservation[] {
  if (page.html.trim()) {
    const cards = extractIndeedCards(page.html, origin);
    if (cards.foundCards) return cards.items;
  }

  return extractStructuredCollection(page, origin, 'indeed');
}

import type { PageReadResult } from '../../../shared/contracts';
import type { WebService } from '../web/web.service';

type SmokeWeb = Pick<WebService, 'search' | 'readPage' | 'searchProgress'>;
type SearchOptions = Parameters<WebService['search']>[1];

const COLLECTION_URL = 'https://uk.linkedin.com/jobs/search/';
const LISTING_URL = 'https://uk.linkedin.com/jobs/view/software-intern-7654321';
const OTHER_LISTING_URL =
  'https://uk.linkedin.com/jobs/view/data-analyst-7654322';
const CANONICAL_URL = 'https://boards.greenhouse.io/acme/jobs/3456789';
const SLOW_SEARCH_DELAY_MS = 8000;

function canonicalPage(): PageReadResult {
  return {
    requestedUrl: CANONICAL_URL,
    url: CANONICAL_URL,
    title: 'Software Intern - Acme',
    status: 200,
    html: '<main>Job</main>',
    text:
      'Acme seeks a Software Intern in London. Responsibilities include ' +
      'developing software, testing TypeScript applications and collaborating ' +
      'with colleagues. Requirements include TypeScript and clear ' +
      'communication with the engineering team.',
    providerId: 'smoke',
    browserId: 'smoke',
    truncated: { html: false, text: false },
  };
}

/** Explicit packaged-smoke-only Discovery adapter; no live site or model required. */
export function discoverySmokeWeb(includeSibling = false): SmokeWeb {
  const page = canonicalPage();
  let searching = 0;

  return {
    search: async (query, options) => {
      searching++;
      try {
        if (query.includes('Data Analyst')) {
          await waitUnlessAborted(SLOW_SEARCH_DELAY_MS, options);
        }

        const isCanonicalQuery =
          query.includes('Acme') || (includeSibling && query.includes('Beta'));
        return {
          providerId: 'smoke',
          results: [
            {
              title: 'Software Intern',
              url: isCanonicalQuery ? CANONICAL_URL : COLLECTION_URL,
              rank: 1,
            },
          ],
        };
      } finally {
        searching--;
      }
    },
    readPage: async (url) =>
      url === COLLECTION_URL ? collectionPage(page, includeSibling) : page,
    searchProgress: () => ({
      queueLength: 0,
      position: null,
      state: searching ? ('running' as const) : ('idle' as const),
      waitingMs: 0,
      nextEligibleAt: null,
    }),
  };
}

function waitUnlessAborted(delayMs: number, options: SearchOptions) {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    options?.signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function collectionPage(
  page: PageReadResult,
  includeSibling: boolean,
): PageReadResult {
  return {
    ...page,
    requestedUrl: COLLECTION_URL,
    url: COLLECTION_URL,
    title: 'Jobs',
    html: '',
    text: '',
    structured: {
      schemaVersion: 1,
      url: COLLECTION_URL,
      title: 'Jobs',
      scripts: [],
      stylesheets: [],
      truncated: false,
      content: {
        blocks: [
          {
            type: 'list' as const,
            ordered: false,
            items: [
              listItem('Software Intern', 'Acme', LISTING_URL),
              ...(includeSibling
                ? [listItem('Data Analyst', 'Beta', OTHER_LISTING_URL)]
                : []),
            ],
          },
        ],
      },
    },
  };
}

function listItem(title: string, company: string, href: string) {
  return {
    text: `${title} ${company} London`,
    links: [
      { text: title, href },
      {
        text: company,
        href: `https://www.linkedin.com/company/${company.toLowerCase()}`,
      },
    ],
  };
}

import { classifyExternalUrl } from './url-safety';

const LINKEDIN_HOST = /(^|\.)linkedin\.com$/;
const INDEED_HOST = /(^|\.)indeed\.com$/;
const LINKEDIN_JOB_PATH = /^\/jobs\/view\/(?:[^/]*-)?(\d{6,})\/?$/i;
const INDEED_JOB_PATH = /^\/(?:rc\/clk|viewjob)\/?$/i;
const INDEED_JOB_KEY = /^[a-f0-9]{16}$/i;

/** Conservative identity for a public job URL. Unknown query keys are significant. */
export function jobReference(raw: string): string | null {
  if (!classifyExternalUrl(raw).ok) return null;

  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();

    const boardId = jobBoardReference(url, host);
    if (boardId) return boardId;

    return `url:${canonicalUrl(url, host)}`;
  } catch {
    return null;
  }
}

/** Stable job-board posting id (LinkedIn job id, Indeed `jk`), if present. */
function jobBoardReference(url: URL, host: string): string | null {
  if (LINKEDIN_HOST.test(host)) {
    const id = LINKEDIN_JOB_PATH.exec(url.pathname)?.[1];
    if (id) return `linkedin:${id}`;
  }

  if (INDEED_HOST.test(host) && INDEED_JOB_PATH.test(url.pathname)) {
    const key = url.searchParams.get('jk');
    if (key && INDEED_JOB_KEY.test(key)) return `indeed:${key.toLowerCase()}`;
  }

  return null;
}

/** Drop fragments and tracking keys, sort the query and trim a trailing slash. */
function canonicalUrl(url: URL, host: string): string {
  url.hash = '';
  for (const key of Array.from(url.searchParams.keys())) {
    if (isTrackingKey(key, host)) url.searchParams.delete(key);
  }

  url.searchParams.sort();
  url.pathname = url.pathname.replace(/\/$/, '') || '/';

  return url.toString();
}

function isTrackingKey(key: string, host: string): boolean {
  return (
    /^utm_/i.test(key) ||
    (LINKEDIN_HOST.test(host) && /^trk$/i.test(key)) ||
    (INDEED_HOST.test(host) && /^bb$/i.test(key))
  );
}

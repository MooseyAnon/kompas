import type {
  BrowserInfo,
  WebBrowserId,
} from '../../../../../shared/contracts';

/** Raw search item scraped from a results page before normalization. */
export interface RawSearchItem {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * Outcome of running the versioned in-page search extraction. `empty` means the
 * results region was present but held no items (a valid no-results page, which
 * must NOT trigger fallback); `challenge` means the engine presented an
 * anti-automation / CAPTCHA wall; `layout` means the expected results region
 * was absent (a likely layout change — treated as a retryable provider error).
 */
export interface SearchExtraction {
  status: 'ok' | 'empty' | 'challenge' | 'layout';
  items: RawSearchItem[];
}

/** A live, navigated page. The caller reads what it needs then calls `close()`. */
export interface PageHandle {
  readonly browserId: WebBrowserId;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly status: number | null;
  title(): Promise<string>;
  /** Serialized rendered DOM (`page.content()`), not the initial network body. */
  content(): Promise<string>;
  /** Best-effort human-visible text of the page body. */
  visibleText(): Promise<string>;
  /** Run the versioned search-results extraction in the page. */
  extractSearch(): Promise<SearchExtraction>;
  close(): Promise<void>;
}

export interface OpenPageOptions {
  signal: AbortSignal;
  /** Absolute `Date.now()` millisecond deadline shared with the caller. */
  deadline: number;
  /** Full settling wait after `domcontentloaded`; cancellation/deadline aborts the open. */
  settleMs?: number;
  /** Smoke-only: permit loopback request URLs. Never set on production IPC. */
  allowLoopback?: boolean;
}

/** Diagnostic browser inventory plus the browser the adapter would select. */
export interface BrowserInventory {
  browsers: BrowserInfo[];
  selectedId?: WebBrowserId;
}

/**
 * Engine seam isolating all Playwright/browser-process concerns from the
 * adapter. Production uses {@link createPlaywrightEngine}; tests inject a
 * deterministic fake. The adapter never imports `playwright-core` directly.
 */
export interface BrowserEngine {
  /**
   * Discover installed browsers. When `verifyLaunch` is true, supported
   * browsers are actually launched (and reused until idle shutdown) to report
   * `launchVerified`.
   */
  inventory(options?: { verifyLaunch?: boolean }): Promise<BrowserInventory>;
  /** Open an independent page in the shared context and navigate (SSRF-guarded). */
  open(url: string, options: OpenPageOptions): Promise<PageHandle>;
  /** Close any running browser and reject future opens. */
  shutdown?(): Promise<void>;
}

import type {
  DiscoveryCandidate,
  DiscoveryRun,
  SearchResult,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import { isWebError } from '../web/web.error';
import type { WebService } from '../web/web.service';
import { classifyExternalUrl } from '../web/url-safety';
import {
  candidateRoleTitle,
  verifyJobDescription,
  type Verification,
} from './jd-verifier';
import type { DiscoveryRunsRepository } from './runs.repository';

const MAX_QUERY_LENGTH = 256;
const MAX_RESULTS_PER_SEARCH = 20;
const AUTHORITY_RANK_WEIGHT = 0.01;
const EXCEPTIONAL_IDENTITY_CONFIDENCE = 0.84;
const EXCEPTIONAL_FIELD_SCORE = 0.95;
const CHALLENGE_TITLE_PATTERN = /captcha|verify you are human|unusual traffic/i;
const SOURCE_AUTHORITY_RANK = {
  employer: 3,
  ats: 2,
  job_board: 1,
  aggregator: 0,
};

type ResolutionReason = DiscoveryCandidate['resolutionReason'];

interface BestMatch {
  url: string;
  resultId: string;
  evidence: Verification['evidence'] & { captureId: string };
  rank: number;
}

/** Mutable per-candidate state shared by the resolution steps. */
interface ResolutionContext {
  run: DiscoveryRun;
  candidate: DiscoveryCandidate;
  deadline: number;
  signal: AbortSignal;
  requireRunning: boolean;
  available: () => boolean;
  record: (
    reason: ResolutionReason,
    evidence?: object | null,
    url?: string | null,
    resultId?: string,
  ) => void;
  seen: Set<string>;
  // Only the current winner is retained; raw pages already live in captures.
  best: BestMatch | undefined;
  reason: ResolutionReason;
}

/** `next` moves on, `stop` ends this search, `accepted` ends the candidate. */
type ResultOutcome = 'next' | 'stop' | 'accepted';

type PageRead = Awaited<ReturnType<Pick<WebService, 'readPage'>['readPage']>>;

function requisitionId(candidate: DiscoveryCandidate): string | undefined {
  if (candidate.provider !== 'greenhouse') return undefined;

  return /\/jobs\/(\d+)\/?$/.exec(candidate.sourceKey)?.[1];
}

function queries(candidate: DiscoveryCandidate, run: DiscoveryRun): string[] {
  if (!candidate.company) return [];

  const roleTitle = candidateRoleTitle(
    candidate.title,
    candidate.company,
    candidate.location,
  );
  const mandatory = `${roleTitle} ${candidate.company}`;
  if (mandatory.length > MAX_QUERY_LENGTH) return [];

  const optional = [
    candidate.location,
    run.configSnapshot.intent.targetYear,
    requisitionId(candidate),
  ];
  let base = mandatory;
  for (const term of optional) {
    if (term && `${base} ${term}`.length <= MAX_QUERY_LENGTH)
      base += ` ${term}`;
  }

  const alternative = `${mandatory} careers`;

  return [base, alternative].filter(
    (value, index, all) =>
      value.length <= MAX_QUERY_LENGTH && all.indexOf(value) === index,
  );
}

function stoppedReason(signal: AbortSignal): ResolutionReason {
  return signal.aborted ? 'cancelled' : 'deadline_reached';
}

function isChallengePage(page: PageRead): boolean {
  return (
    page.status === 403 ||
    page.status === 429 ||
    CHALLENGE_TITLE_PATTERN.test(page.title)
  );
}

function isExceptionalMatch(evidence: Verification['evidence']): boolean {
  return (
    evidence.identityConfidence >= EXCEPTIONAL_IDENTITY_CONFIDENCE &&
    evidence.scores.title >= EXCEPTIONAL_FIELD_SCORE &&
    evidence.scores.company >= EXCEPTIONAL_FIELD_SCORE
  );
}

/** Explicit resolution of previously admitted identities; no new admissions. */
export class CanonicalResolver {
  private readonly active = new Map<string, AbortController>();

  constructor(
    private readonly repo: DiscoveryRunsRepository,
    private readonly web: Pick<WebService, 'search' | 'readPage'>,
    private readonly clock: () => Date,
  ) {}

  cancel(id: string): void {
    this.active.get(id)?.abort();
  }

  isActive(): boolean {
    return this.active.size > 0;
  }

  isActiveRun(id: string): boolean {
    return this.active.has(id);
  }

  async resolve(run: DiscoveryRun, sourceId?: string): Promise<void> {
    if (run.status === 'running' || (run.status === 'cancelled' && !sourceId))
      throw new AppError(
        'CONFLICT',
        'Finish discovery before resolving candidates.',
      );
    if (this.active.size > 0 || this.repo.hasRunning())
      throw new AppError('CONFLICT', 'Resolution already in progress.');
    const candidates = sourceId
      ? [this.repo.admitted(run.id, sourceId)]
      : this.repo
          .candidates(run.id)
          .filter((item) => item.resolutionAttempts === 0);
    if (candidates.some((item) => !item))
      throw new AppError('NOT_FOUND', 'Candidate not found in this run.');
    if (
      sourceId &&
      candidates[0]!.resolutionAttempts >=
        1 + run.configSnapshot.run.maxTransientRetries
    )
      throw new AppError('CONFLICT', 'Resolution retry limit reached.');
    if (sourceId && candidates[0]!.canonicalUrl)
      throw new AppError('CONFLICT', 'Candidate is already resolved.');
    // A first resolution belongs to the original run deadline; an explicit retry
    // starts a fresh, equally bounded window after restart.
    const deadline = sourceId
      ? this.clock().getTime() + run.configSnapshot.run.deadlineMs
      : Date.parse(run.startedAt) + run.configSnapshot.run.deadlineMs;
    if (!sourceId && this.clock().getTime() >= deadline)
      throw new AppError(
        'CONFLICT',
        'Run deadline reached. Resolve a candidate explicitly.',
      );
    const controller = new AbortController();
    this.active.set(run.id, controller);
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - this.clock().getTime()),
    );
    try {
      for (const candidate of candidates) {
        if (controller.signal.aborted || this.clock().getTime() >= deadline)
          break;
        if (!candidate) continue;
        const claimed = this.repo.claimResolution(run.id, candidate.sourceId);
        if (!claimed) continue;
        await this.resolveCandidate(run, claimed, deadline, controller.signal);
      }
    } finally {
      clearTimeout(timer);
      this.active.delete(run.id);
    }
  }

  /**
   * Coordinator-owned path: same verifier and attempt budget, shared run
   * deadline.
   */
  async resolveWithinRun(
    run: DiscoveryRun,
    sourceId: string,
    deadline: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      signal.aborted ||
      this.clock().getTime() >= deadline ||
      this.repo.get(run.id)?.status !== 'running'
    )
      return;
    const claimed = this.repo.claimResolution(run.id, sourceId);
    if (claimed)
      await this.resolveCandidate(run, claimed, deadline, signal, true);
  }

  private async resolveCandidate(
    run: DiscoveryRun,
    candidate: DiscoveryCandidate,
    deadline: number,
    signal: AbortSignal,
    requireRunning = false,
  ): Promise<void> {
    const ctx = this.createContext(
      run,
      candidate,
      deadline,
      signal,
      requireRunning,
    );

    if (!ctx.available()) {
      ctx.record(stoppedReason(signal));
      return;
    }
    if (!candidate.company) {
      ctx.record('missing_company');
      return;
    }
    if (queries(candidate, run).length === 0) {
      ctx.record('query_too_long');
      return;
    }

    const searches = queries(candidate, run).slice(
      0,
      run.configSnapshot.run.maxTargetedSearchesPerCandidate,
    );
    for (const [index, query] of searches.entries()) {
      if (!ctx.available()) break;

      const outcome = await this.runTargetedSearch(ctx, index, query);
      if (outcome === 'accepted') return;
      if (outcome === 'stop') break;
    }

    this.finishCandidate(ctx);
  }

  private createContext(
    run: DiscoveryRun,
    candidate: DiscoveryCandidate,
    deadline: number,
    signal: AbortSignal,
    requireRunning: boolean,
  ): ResolutionContext {
    const available = () =>
      !signal.aborted &&
      this.clock().getTime() < deadline &&
      (!requireRunning || this.repo.get(run.id)?.status === 'running');

    const record = (
      reason: ResolutionReason,
      evidence: object | null = null,
      url: string | null = null,
      resultId?: string,
    ) =>
      this.repo.resolutionResult(
        run.id,
        candidate.sourceId,
        reason,
        evidence,
        url,
        this.clock().toISOString(),
        requireRunning,
        resultId,
      );

    return {
      run,
      candidate,
      deadline,
      signal,
      requireRunning,
      available,
      record,
      seen: new Set<string>(),
      best: undefined,
      reason: 'no_match',
    };
  }

  /** Runs one search; `stop` ends the candidate's search loop. */
  private async runTargetedSearch(
    ctx: ResolutionContext,
    index: number,
    query: string,
  ): Promise<ResultOutcome> {
    this.repo.resolutionProgress(ctx.run.id, 'targetedSearches');
    const searchId = this.repo.beginResolutionSearch(
      ctx.run.id,
      ctx.candidate.sourceId,
      index + 1,
      query,
      this.clock().toISOString(),
    );

    const results = await this.searchResults(ctx, searchId, query);
    if (results === 'stop' || results === 'next') return results;

    const outcome = await this.readResults(ctx, searchId, results);
    if (outcome === 'accepted') return outcome;

    this.repo.settleResolutionResults(searchId, 'stopped');

    return 'next';
  }

  /** Returns the results, or the loop outcome when the search is incomplete. */
  private async searchResults(
    ctx: ResolutionContext,
    searchId: string,
    query: string,
  ): Promise<SearchResult[] | 'next' | 'stop'> {
    let results: SearchResult[];
    try {
      const response = await this.web.search(query, {
        signal: ctx.signal,
        ownerId: ctx.run.id,
        deadline: ctx.deadline,
      });
      results = response.results;
    } catch (error) {
      return this.recordSearchFailure(ctx, searchId, error);
    }

    if (!ctx.available()) {
      this.repo.finishResolutionSearch(
        searchId,
        'cancelled',
        null,
        this.clock().toISOString(),
      );
      return 'stop';
    }

    this.repo.finishResolutionSearch(
      searchId,
      'completed',
      null,
      this.clock().toISOString(),
    );

    return results;
  }

  private recordSearchFailure(
    ctx: ResolutionContext,
    searchId: string,
    error: unknown,
  ): 'next' | 'stop' {
    const wasCancelled =
      !ctx.available() || (isWebError(error) && error.code === 'CANCELLED');
    this.repo.finishResolutionSearch(
      searchId,
      wasCancelled ? 'cancelled' : 'failed',
      isWebError(error) ? error.code : 'WEB_FAILED',
      this.clock().toISOString(),
    );
    if (!ctx.available()) return 'stop';

    const isRateLimited = isWebError(error) && error.code === 'RATE_LIMITED';
    if (ctx.requireRunning && isRateLimited)
      this.repo.appendDiagnostic(
        ctx.run.id,
        'WEB_RATE_LIMITED',
        this.clock().toISOString(),
      );
    ctx.reason = 'page_unavailable';

    return 'next';
  }

  /** Screens and reads each result; `stop` ends only this search. */
  private async readResults(
    ctx: ResolutionContext,
    searchId: string,
    results: SearchResult[],
  ): Promise<ResultOutcome> {
    const topResults = results.slice(0, MAX_RESULTS_PER_SEARCH);
    const resultIds = this.repo.addResolutionResults(
      searchId,
      topResults.map((result) => result.url),
    );
    const maxReads = ctx.run.configSnapshot.run.maxPagesPerTargetedSearch;
    const unique = new Set(ctx.seen);
    let reads = 0;

    for (const [position, { url }] of topResults.entries()) {
      const resultId = resultIds[position];
      if (!ctx.available()) {
        this.repo.settleResolutionResults(searchId, 'stopped');
        return 'stop';
      }
      if (!this.admitResult(resultId, url, unique, reads >= maxReads)) continue;

      ctx.seen.add(url);
      reads++;
      this.repo.resolutionProgress(ctx.run.id, 'targetedPagesRead');
      this.repo.resolutionResultDecision(resultId, 'reading');

      const outcome = await this.readResult(ctx, searchId, resultId, url);
      if (outcome !== 'next') return outcome;
    }

    return 'next';
  }

  /** Records why a result is not opened; returns true when it may be read. */
  private admitResult(
    resultId: string,
    url: string,
    unique: Set<string>,
    budgetSpent: boolean,
  ): boolean {
    if (!classifyExternalUrl(url).ok) {
      this.repo.resolutionResultDecision(resultId, 'not_opened', 'policy');
      return false;
    }
    if (unique.has(url)) {
      this.repo.resolutionResultDecision(resultId, 'not_opened', 'duplicate');
      return false;
    }

    unique.add(url);
    if (budgetSpent) {
      this.repo.resolutionResultDecision(resultId, 'not_opened', 'budget');
      return false;
    }

    return true;
  }

  private async readResult(
    ctx: ResolutionContext,
    searchId: string,
    resultId: string,
    url: string,
  ): Promise<ResultOutcome> {
    try {
      const page = await this.web.readPage(url, { signal: ctx.signal });
      if (!ctx.available()) return this.interruptRead(searchId, resultId);

      return this.evaluatePage(ctx, searchId, resultId, page);
    } catch (error) {
      if (!ctx.available()) return this.interruptRead(searchId, resultId);

      ctx.reason = 'page_unavailable';
      this.repo.resolutionResultDecision(
        resultId,
        'read_failed',
        isWebError(error) ? error.code : 'WEB_FAILED',
      );

      return 'next';
    }
  }

  private interruptRead(searchId: string, resultId: string): 'stop' {
    this.repo.resolutionResultDecision(resultId, 'interrupted');
    this.repo.settleResolutionResults(searchId, 'stopped');

    return 'stop';
  }

  private evaluatePage(
    ctx: ResolutionContext,
    searchId: string,
    resultId: string,
    page: PageRead,
  ): ResultOutcome {
    if (isChallengePage(page)) {
      this.reject(ctx, resultId, 'page_unavailable');
      if (ctx.requireRunning)
        this.repo.appendDiagnostic(
          ctx.run.id,
          'WEB_CHALLENGE',
          this.clock().toISOString(),
        );
      return 'next';
    }
    // Structured JSON may omit refs or long blocks while the raw JD remains
    // complete.
    if (page.truncated.html || page.truncated.text) {
      this.reject(ctx, resultId, 'page_truncated');
      return 'next';
    }
    if (!classifyExternalUrl(page.url).ok) {
      this.reject(ctx, resultId, 'page_unavailable');
      return 'next';
    }

    const captureId = this.repo.capture(
      ctx.candidate,
      page,
      this.clock().toISOString(),
    );
    if (!captureId) {
      this.reject(ctx, resultId, 'capture_too_large');
      return 'next';
    }

    const verdict = verifyJobDescription(
      page,
      ctx.candidate,
      requisitionId(ctx.candidate),
    );
    if (verdict.kind !== 'job_description') {
      this.reject(ctx, resultId, verdict.reason);
      return 'next';
    }

    this.considerMatch(ctx, resultId, page.url, {
      ...verdict.evidence,
      captureId,
    });
    // Exact role, employer, location and body evidence suffice for an
    // exceptional match even when no requisition ID was discovered.
    if (isExceptionalMatch(verdict.evidence)) {
      this.recordBest(ctx);
      this.repo.settleResolutionResults(searchId, 'accepted_earlier');
      return 'accepted';
    }

    return 'next';
  }

  private reject(
    ctx: ResolutionContext,
    resultId: string,
    reason: ResolutionReason,
  ): void {
    ctx.reason = reason;
    this.repo.resolutionResultDecision(resultId, 'rejected', reason);
  }

  /** Keeps the highest-ranked verified page and rejects the other one. */
  private considerMatch(
    ctx: ResolutionContext,
    resultId: string,
    url: string,
    evidence: BestMatch['evidence'],
  ): void {
    const rank =
      evidence.identityConfidence +
      SOURCE_AUTHORITY_RANK[evidence.sourceAuthority] * AUTHORITY_RANK_WEIGHT;
    const best = ctx.best;

    if (best && rank <= best.rank) {
      this.repo.resolutionResultDecision(resultId, 'rejected');
      return;
    }

    // A valid but lower-ranked page has no verification failure reason.
    if (best) this.repo.resolutionResultDecision(best.resultId, 'rejected');
    ctx.best = { url, resultId, evidence, rank };
  }

  private recordBest(ctx: ResolutionContext): void {
    const best = ctx.best;
    if (best) ctx.record('verified', best.evidence, best.url, best.resultId);
  }

  private finishCandidate(ctx: ResolutionContext): void {
    if (ctx.best) {
      if (ctx.available()) {
        this.recordBest(ctx);
        return;
      }
      this.repo.resolutionResultDecision(ctx.best.resultId, 'interrupted');
    }

    ctx.record(ctx.available() ? ctx.reason : stoppedReason(ctx.signal));
  }
}

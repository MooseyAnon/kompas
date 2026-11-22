import { z } from 'zod';
import { createHash } from 'node:crypto';
import {
  discoveryRunIdInput,
  discoveryRunListInput,
  discoveryRunStartInput,
  discoverySourceInput,
  discoveryDecideInput,
  discoveryTrackInput,
  opportunityApplyInput,
  discoveryReviewSchema,
  type DiscoveryReview,
  type DiscoveryRun,
  type DiscoveryCandidate,
  type DiscoveryCapture,
  type DiscoveryMatch,
  type DiscoveryWorkflowState,
  type PageReadResult,
  type ResolutionDiagnostics,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { WebService } from '../web/web.service';
import { isWebError } from '../web/web.error';
import {
  classifyHit,
  collectionProvider,
  directCandidate,
  extractCollection,
} from './collection';
import { planQueries } from './query-planner';
import { DiscoveryRunsRepository } from './runs.repository';
import type { SavedSearchesService } from './saved-searches.service';
import { DiscoveryIdentityService } from './identity.service';
import { CanonicalResolver } from './canonical-resolver';
import { JdExtractionService } from './jd-extraction.service';
import type { JdInference } from './jd-extraction';
import type { JdExtraction } from '../../../shared/contracts';
import { matchRequiredSkills, skillKey, sortMatches } from './skill-matcher';
import { assessSnapshot } from './handoff-snapshot';
import type { ApplicationsService } from '../applications/applications.service';

/** An Identity-owned, read-only seam; Discovery never queries profile tables. */
export interface ConfirmedSkillReader {
  listConfirmedSkills(): string[];
  getProfile(): { location: string | null };
}

type DiscoveryWeb = Pick<WebService, 'search' | 'readPage'>;

type TrackingApplications = Pick<
  ApplicationsService,
  'create' | 'findByDiscoveryOpportunity' | 'findByJobReference' | 'get'
>;

type DiagnosticCode = DiscoveryRun['diagnostics'][number]['code'];

type RunBudget = DiscoveryRun['configSnapshot']['run'];

type CandidateObservation = Parameters<DiscoveryIdentityService['observe']>[1];

type SearchHit = Awaited<ReturnType<WebService['search']>>['results'][number];

type WorkflowStep = 'resolution' | 'extraction' | 'matching';

type WorkflowProgress = {
  submitted: number;
  settled: number;
  steps: Map<string, WorkflowStep>;
};

type WorkflowEvidence = ReturnType<
  DiscoveryRunsRepository['workflowEvidence']
>[number];

type CandidateWorkflow = DiscoveryWorkflowState['candidates'][number];

type MatchContext = {
  skills: string[] | null;
  location: string | null;
  fingerprint: string | null;
};

/** Shared mutable state for one collection pass over a run's query plan. */
interface CollectionContext {
  run: DiscoveryRun;
  budget: RunBudget;
  controller: AbortController;
  web: DiscoveryWeb;
  deadline: number;
  onAdmitted?: (candidate: DiscoveryCandidate) => void;
  diagnostics: DiagnosticCode[];
  successes: number;
  searchCalls: number;
}

type CollectionOptions = {
  controller: AbortController;
  web: DiscoveryWeb;
  onAdmitted: (candidate: DiscoveryCandidate) => void;
};

type CollectionOutcome = {
  run: DiscoveryRun;
  successes: number;
  failures: number;
};

/** Per-run state for the resolve → extract → match pipeline of admitted candidates. */
interface WorkflowContext {
  run: DiscoveryRun;
  deadline: number;
  controller: AbortController;
  resolver: CanonicalResolver;
  progress: WorkflowProgress;
  candidateFailures: number;
}

/** Facts used to project one candidate's workflow state. */
interface CandidateFacts {
  run: DiscoveryRun;
  candidate: DiscoveryCandidate;
  fact: WorkflowEvidence;
  active: WorkflowStep | undefined;
  verified: boolean;
  ready: boolean;
  currentMatch: boolean;
  retryAllowed: boolean;
}

/** Diagnostics recorded by a single collection pass. */
const MAX_COLLECTION_DIAGNOSTICS = 20;

/** Diagnostics exposed in the workflow-state projection. */
const MAX_REPORTED_DIAGNOSTICS = 20;

const CHALLENGE_TITLE = /captcha|verify you are human|unusual traffic/i;

const HTTP_FORBIDDEN = 403;

const HTTP_TOO_MANY_REQUESTS = 429;

const HTTP_ERROR_MIN = 400;

const IDLE_SEARCH_PROGRESS = {
  queueLength: 0,
  position: null,
  state: 'idle' as const,
  waitingMs: 0,
  nextEligibleAt: null,
};

function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success)
    throw new AppError('INVALID_INPUT', 'Invalid discovery run request.');

  return result.data;
}

function runDeadline(run: DiscoveryRun): number {
  return Date.parse(run.startedAt) + run.configSnapshot.run.deadlineMs;
}

function emptyRunStats(queriesPlanned: number): DiscoveryRun['stats'] {
  return {
    queriesPlanned,
    collectionPagesRead: 0,
    inspectedCandidates: 0,
    newCandidates: 0,
    targetedSearches: 0,
    targetedPagesRead: 0,
    extractions: 0,
    transientRetries: 0,
  };
}

/** A verified candidate is tracked by its canonical URL, otherwise by where it was found. */
function jobReferenceUrl(
  candidate: DiscoveryCandidate,
  verified: boolean,
): string {
  return verified ? candidate.canonicalUrl! : candidate.discoveredUrl;
}

function candidateBudgetReached(
  stats: DiscoveryRun['stats'],
  budget: RunBudget,
): boolean {
  return (
    stats.newCandidates >= budget.maxNewCandidates ||
    stats.inspectedCandidates >= budget.maxInspectedCandidates
  );
}

function isChallengePage(page: PageReadResult): boolean {
  return (
    page.status === HTTP_FORBIDDEN ||
    page.status === HTTP_TOO_MANY_REQUESTS ||
    CHALLENGE_TITLE.test(page.title)
  );
}

function isBlockedPage(page: PageReadResult, provider: string): boolean {
  const httpError = page.status !== null && page.status >= HTTP_ERROR_MIN;
  const lacksContent =
    !page.html.trim() && (page.structured?.truncated || !page.structured);

  return (
    httpError ||
    collectionProvider(page.url) !== provider ||
    page.truncated.html ||
    !!lacksContent
  );
}

function skillsFingerprint(skills: string[] | null): string | null {
  if (skills === null) return null;

  const keys = [...new Set(skills.map(skillKey).filter(Boolean))].sort();

  return createHash('sha256').update(JSON.stringify(keys)).digest('hex');
}

/** Attempts allowed per step: the initial attempt plus the transient retry budget. */
function maxStepAttempts(run: DiscoveryRun): number {
  return 1 + run.configSnapshot.run.maxTransientRetries;
}

function resolutionStatus(
  facts: CandidateFacts,
): CandidateWorkflow['resolution']['status'] {
  const { run, candidate, fact, active } = facts;

  if (facts.verified) return 'succeeded';
  if (active === 'resolution') return 'active';
  if (fact.errorCode === 'INTERRUPTED') return 'interrupted';

  const failed =
    fact.outcome === 'unresolved' ||
    (fact.outcome === 'failed' && !!candidate.resolutionReason);
  if (failed) return 'failed';

  return run.status === 'running' ? 'pending' : 'skipped';
}

function resolutionReason(
  facts: CandidateFacts,
  status: CandidateWorkflow['resolution']['status'],
) {
  const { run, candidate, fact } = facts;

  if (facts.verified || facts.active === 'resolution') return null;
  if (fact.errorCode === 'INTERRUPTED') return 'INTERRUPTED';
  if (fact.errorCode === 'CANCELLED') return 'cancelled';
  if (status === 'failed') return candidate.resolutionReason;
  if (run.status === 'running') return null;

  return run.status.toUpperCase();
}

function resolutionStep(facts: CandidateFacts) {
  const status = resolutionStatus(facts);
  const { candidate } = facts;

  return {
    status,
    attempts: candidate.resolutionAttempts,
    reason: resolutionReason(facts, status),
    retryAvailable:
      facts.retryAllowed &&
      !facts.verified &&
      candidate.resolutionAttempts < maxStepAttempts(facts.run),
  };
}

function extractionStatus(
  facts: CandidateFacts,
): CandidateWorkflow['extraction']['status'] {
  const { fact } = facts;

  if (facts.ready) return 'succeeded';
  if (facts.active === 'extraction') return 'active';
  if (fact.extractionError === 'INTERRUPTED') return 'interrupted';
  if (fact.extractionStatus === 'failed') return 'failed';

  return facts.verified && facts.run.status === 'running'
    ? 'pending'
    : 'skipped';
}

function extractionStep(facts: CandidateFacts) {
  const { fact, verified, ready } = facts;
  const missingReason = verified ? 'NO_EXTRACTION' : 'NO_VERIFIED_JD';

  return {
    status: extractionStatus(facts),
    reason: ready
      ? null
      : fact.extractionError === 'RESOURCE_LIMIT'
        ? (fact.extractionDiagnostics[0] ?? fact.extractionError)
        : (fact.extractionError ?? missingReason),
    retryAvailable:
      facts.retryAllowed &&
      verified &&
      !ready &&
      fact.extractionAttempts < maxStepAttempts(facts.run),
    omittedFields: ready ? fact.extractionDiagnostics : [],
  };
}

function matchStatus(
  facts: CandidateFacts,
): CandidateWorkflow['match']['status'] {
  if (facts.currentMatch) return 'succeeded';
  if (facts.active === 'matching') return 'active';

  return facts.ready && facts.run.status === 'running' ? 'pending' : 'skipped';
}

function matchStep(facts: CandidateFacts) {
  const { match } = facts.fact;
  const current = facts.currentMatch ? match : null;

  let reason;
  if (current) reason = current.reason;
  else reason = facts.ready ? 'MATCH_NOT_CURRENT' : 'NO_EXTRACTION';

  let freshness = null;
  if (match) freshness = current ? 'unknown_skills' : 'stale_extraction';

  return {
    status: matchStatus(facts),
    reason,
    retryAvailable: false, // Refresh matches is explicit, but not an attempt-limited retry.
    freshness,
    computedAt: current ? current.computedAt : null,
  };
}

function candidateWorkflow(facts: CandidateFacts): CandidateWorkflow {
  const { candidate } = facts;

  return {
    opportunityId: candidate.id,
    sourceId: candidate.sourceId,
    provider: candidate.provider,
    title: candidate.title,
    resolution: resolutionStep(facts),
    extraction: extractionStep(facts),
    match: matchStep(facts),
  } as CandidateWorkflow;
}

function workflowCounts(candidates: CandidateWorkflow[]) {
  const count = (predicate: (item: CandidateWorkflow) => boolean) =>
    candidates.filter(predicate).length;

  return {
    admitted: candidates.length,
    verified: count((item) => item.resolution.status === 'succeeded'),
    jdReady: count((item) => item.extraction.status === 'succeeded'),
    matched: count((item) => item.match.status === 'succeeded'),
    failed: count(
      (item) =>
        item.resolution.status === 'failed' ||
        item.extraction.status === 'failed',
    ),
  };
}

function earliest(times: Array<string | null>): string | null {
  return times.filter((at): at is string => at !== null).sort()[0] ?? null;
}

/** Only timestamps observed during this run's lifetime count as run milestones. */
function withinRun(
  run: DiscoveryRun,
  at: string | null,
  observed: string,
): string | null {
  const inRun =
    !!at &&
    at >= observed &&
    at >= run.startedAt &&
    (!run.finishedAt || at <= run.finishedAt);

  return inRun ? at : null;
}

function workflowMilestones(run: DiscoveryRun, evidence: WorkflowEvidence[]) {
  const jdReadyAt = (item: WorkflowEvidence) =>
    item.extractionStatus === 'extracted'
      ? withinRun(run, item.extractionAt, item.observedAt)
      : null;

  const matchedAt = (item: WorkflowEvidence) => {
    const currentMatch =
      item.match &&
      item.extractionStatus === 'extracted' &&
      item.match.extractionId === item.extractionId;

    return currentMatch
      ? withinRun(run, item.match!.computedAt, item.observedAt)
      : null;
  };

  return {
    firstAdmittedAt: earliest(evidence.map((item) => item.observedAt)),
    firstVerifiedAt: earliest(
      evidence.map((item) => withinRun(run, item.verifiedAt, item.observedAt)),
    ),
    firstJdReadyAt: earliest(evidence.map(jdReadyAt)),
    firstMatchedAt: earliest(evidence.map(matchedAt)),
  };
}

function webDiagnostic(error: unknown): DiagnosticCode {
  if (!isWebError(error)) return 'WEB_FAILED';
  if (error.code === 'RATE_LIMITED') return 'WEB_RATE_LIMITED';
  if (error.code === 'NAVIGATION_FAILED') return 'WEB_CHALLENGE';

  const unavailable =
    error.code === 'BROWSER_UNAVAILABLE' ||
    error.code === 'PROVIDER_UNAVAILABLE' ||
    error.code === 'NO_CAPABLE_PROVIDER';
  if (unavailable) return 'WEB_UNAVAILABLE';

  return 'WEB_FAILED';
}

function isTransientWebError(error: unknown): boolean {
  return isWebError(error) && error.retryable && error.code !== 'RATE_LIMITED';
}

export class DiscoveryRunsService {
  private readonly extraction: JdExtractionService;

  private resolution: CanonicalResolver | null = null;

  private readonly active = new Map<string, AbortController>();

  private readonly workflows = new Set<string>();

  private readonly workflowProgress = new Map<string, WorkflowProgress>();

  constructor(
    private readonly repo: DiscoveryRunsRepository,
    private readonly searches: SavedSearchesService,
    private readonly clock: () => Date = () => new Date(),
    private readonly web?: DiscoveryWeb &
      Partial<Pick<WebService, 'searchProgress'>>,
    private readonly identity = new DiscoveryIdentityService(repo),
    inference?: JdInference,
    private readonly profile?: ConfirmedSkillReader,
    private readonly applications?: TrackingApplications,
  ) {
    this.extraction = new JdExtractionService(
      repo,
      inference,
      clock,
      () => !!this.resolver?.isActive(),
    );
  }

  isActive(): boolean {
    return (
      this.active.size > 0 ||
      this.workflows.size > 0 ||
      !!this.resolver?.isActive() ||
      this.extraction.isActive()
    );
  }

  reviews(raw: z.input<typeof discoveryRunIdInput>): DiscoveryReview[] {
    const { id } = parse(discoveryRunIdInput, raw);
    this.get({ id });

    return this.repo
      .candidates(id)
      .map((candidate) => this.review(id, candidate.sourceId));
  }

  decide(raw: z.input<typeof discoveryDecideInput>): DiscoveryReview {
    const { id, sourceId, decision } = parse(discoveryDecideInput, raw);
    this.requireCandidate(id, sourceId);

    if (this.repo.review(id, sourceId)?.applicationId)
      throw new AppError(
        'CONFLICT',
        'This opportunity is already tracked as an application.',
      );

    this.repo.decide(id, sourceId, decision, this.clock().toISOString());

    return this.review(id, sourceId);
  }

  /** Synchronous main-process coordination; the unique Applications correlation survives a link failure. */
  track(
    raw: z.input<typeof discoveryTrackInput>,
    allowDuplicate = false,
  ): DiscoveryReview {
    const { id, sourceId, confirmUnverified, withoutSnapshot } = parse(
      discoveryTrackInput,
      raw,
    );
    const candidate = this.requireCandidate(id, sourceId);
    if (!this.applications)
      throw new AppError('CONFLICT', 'Application tracking is unavailable.');

    let existing = this.applications.findByDiscoveryOpportunity(candidate.id);
    const state = this.repo.review(id, sourceId)!;

    if (state.applicationId) {
      // Verify the link through the Applications service rather than trusting a foreign ID.
      this.applications.get(state.applicationId);
      return this.review(id, sourceId);
    }

    existing ??= this.createTrackedApplication(
      this.applications,
      id,
      candidate,
      state.decision,
      { confirmUnverified, withoutSnapshot, allowDuplicate },
    );

    this.repo.linkApplication(
      id,
      sourceId,
      existing.application.id,
      this.clock().toISOString(),
    );

    const linked = this.review(id, sourceId);
    if (linked.applicationId !== existing.application.id)
      throw new AppError(
        'CONFLICT',
        'Application link could not be saved. Retry to recover it.',
      );

    return linked;
  }

  applyPreview(opportunityId: string) {
    const source = this.repo.handoffSource(opportunityId);
    if (!source) throw new AppError('NOT_FOUND', 'Opportunity not found.');

    const candidate = this.requireCandidate(source.id, source.sourceId);
    const state = this.repo.review(source.id, source.sourceId)!;
    const existing =
      this.applications?.findByDiscoveryOpportunity(opportunityId);
    const assessment = this.assessCandidateSnapshot(source.id, candidate);
    const verified = !!this.repo.verifiedCapture(source.id, source.sourceId);
    const linked = !!existing || !!state.applicationId;

    return {
      applicationId: existing?.application.id ?? state.applicationId,
      unverified: !verified,
      snapshot: assessment.status,
      manualMatchId: linked
        ? null
        : (this.applications?.findByJobReference(
            jobReferenceUrl(candidate, verified),
          )?.id ?? null),
      dismissed: state.decision === 'dismissed',
    };
  }

  apply(raw: z.input<typeof opportunityApplyInput>): string {
    const {
      opportunityId,
      allowDuplicate,
      confirmUnverified,
      withoutSnapshot,
    } = parse(opportunityApplyInput, raw);

    const source = this.repo.handoffSource(opportunityId);
    if (!source) throw new AppError('NOT_FOUND', 'Opportunity not found.');

    return this.track(
      { ...source, confirmUnverified, withoutSnapshot },
      allowDuplicate,
    ).applicationId!;
  }

  preview(raw: z.input<typeof discoveryRunStartInput>): string[] {
    const { savedSearchId } = parse(discoveryRunStartInput, raw);

    return planQueries(this.searches.requireActive(savedSearchId).config);
  }

  start(raw: z.input<typeof discoveryRunStartInput>): DiscoveryRun {
    const { savedSearchId } = parse(discoveryRunStartInput, raw);

    return this.repo.transaction(() => {
      const { config } = this.searches.requireActive(savedSearchId);

      const busy =
        this.repo.hasRunning() ||
        this.active.size > 0 ||
        this.resolver?.isActive() ||
        this.extraction.isActive();
      if (busy) {
        throw new AppError(
          'CONFLICT',
          'Finish or cancel the running discovery run first.',
        );
      }

      const snapshot = structuredClone(config);
      const plan = planQueries(snapshot);
      const id = crypto.randomUUID();
      this.repo.insert(
        id,
        savedSearchId,
        snapshot,
        plan,
        emptyRunStats(plan.length),
        this.clock().toISOString(),
      );

      return this.get({ id });
    });
  }

  get(raw: z.input<typeof discoveryRunIdInput>): DiscoveryRun {
    const { id } = parse(discoveryRunIdInput, raw);
    const item = this.repo.get(id);
    if (!item) throw new AppError('NOT_FOUND', 'Discovery run not found.');

    return item;
  }

  searchProgress(raw: z.input<typeof discoveryRunIdInput>) {
    const { id } = parse(discoveryRunIdInput, raw);
    this.get({ id }); // Profile-scoped before inspecting any in-memory queue state.

    return {
      operationActive: this.active.has(id) || !!this.resolver?.isActiveRun(id),
      ...(this.web?.searchProgress?.(id) ?? IDLE_SEARCH_PROGRESS),
    };
  }

  /** Passive projection: no scheduling, matching, status change or evidence writes. */
  workflowState(
    raw: z.input<typeof discoveryRunIdInput>,
  ): DiscoveryWorkflowState {
    const { id } = parse(discoveryRunIdInput, raw);
    const run = this.get({ id });
    const live = this.workflowProgress.get(id);
    const search = this.searchProgress({ id });
    const evidence = this.repo.workflowEvidence(id);
    const candidates = this.repo
      .candidates(id)
      .map((candidate) =>
        candidateWorkflow(this.candidateFacts(run, candidate, evidence, live)),
      );

    return {
      id,
      status: run.status,
      workActive: this.isWorkflowRunActive(id),
      discovery: {
        planned: run.queryPlan.length,
        submitted: live?.submitted ?? null,
        settled: live?.settled ?? null,
        search,
      },
      activeSteps: live
        ? [...live.steps].map(([sourceId, step]) => ({ sourceId, step }))
        : [],
      counts: workflowCounts(candidates),
      milestones: workflowMilestones(run, evidence),
      diagnostics: run.diagnostics.slice(0, MAX_REPORTED_DIAGNOSTICS),
      candidates,
    };
  }

  list(raw: z.input<typeof discoveryRunListInput> = {}) {
    const { limit, cursor } = parse(discoveryRunListInput, raw);

    return this.repo.list(limit, cursor);
  }

  cancel(raw: z.input<typeof discoveryRunIdInput>): DiscoveryRun {
    const { id } = parse(discoveryRunIdInput, raw);
    this.get({ id });

    const cancelled = this.repo.cancel(id, this.clock().toISOString());
    if (cancelled && this.workflows.has(id))
      this.repo.cancelWorkflowAttempts(id, this.clock().toISOString());
    if (cancelled) this.workflowProgress.get(id)?.steps.clear();

    this.active.get(id)?.abort();
    this.resolver?.cancel(id);
    this.extraction.cancel(id);

    return this.get({ id });
  }

  candidates(raw: z.input<typeof discoveryRunIdInput>): DiscoveryCandidate[] {
    const { id } = parse(discoveryRunIdInput, raw);
    this.get({ id });

    return this.repo.candidates(id);
  }

  async resolve(
    raw: z.input<typeof discoveryRunIdInput>,
  ): Promise<DiscoveryCandidate[]> {
    const { id } = parse(discoveryRunIdInput, raw);
    const run = this.get({ id });
    this.assertNoWorkflow();

    await this.requireResolver().resolve(run);

    return this.candidates({ id });
  }

  async retryResolution(
    raw: z.input<typeof discoverySourceInput>,
  ): Promise<DiscoveryCandidate> {
    const { id, sourceId } = parse(discoverySourceInput, raw);
    const run = this.get({ id });
    this.assertNoWorkflow();

    await this.requireResolver().resolve(run, sourceId);

    return this.repo.admitted(id, sourceId)!;
  }

  captures(raw: z.input<typeof discoverySourceInput>): DiscoveryCapture[] {
    const { id, sourceId } = parse(discoverySourceInput, raw);
    this.get({ id });

    const items = this.repo.captures(id, sourceId);
    if (!items)
      throw new AppError('NOT_FOUND', 'Candidate not found in this run.');

    return items;
  }

  resolutionDiagnostics(
    raw: z.input<typeof discoverySourceInput>,
  ): ResolutionDiagnostics {
    const { id, sourceId } = parse(discoverySourceInput, raw);
    const candidate = this.requireCandidate(id, sourceId);

    return this.repo.resolutionDiagnostics(candidate);
  }

  extractions(raw: z.input<typeof discoverySourceInput>): JdExtraction[] {
    const { id, sourceId } = parse(discoverySourceInput, raw);
    this.get({ id });

    return this.extraction.list(id, sourceId);
  }

  matches(raw: z.input<typeof discoveryRunIdInput>): DiscoveryMatch[] {
    const { id } = parse(discoveryRunIdInput, raw);
    this.get({ id });

    return sortMatches(this.repo.matches(id));
  }

  /** Explicit local-only recomputation; never calls Web or Inference. */
  refreshMatches(raw: z.input<typeof discoveryRunIdInput>): DiscoveryMatch[] {
    const { id } = parse(discoveryRunIdInput, raw);
    this.get({ id });
    const context = this.matchContext();

    return this.repo.transaction(() => {
      for (const candidate of this.repo.candidates(id)) {
        const extraction = this.repo.currentExtraction(id, candidate.sourceId);
        this.repo.saveMatch(
          id,
          candidate.sourceId,
          this.computeMatch(context, candidate, extraction),
        );
      }

      return this.matches({ id });
    });
  }

  async extract(
    raw: z.input<typeof discoveryRunIdInput>,
  ): Promise<JdExtraction[]> {
    const { id } = parse(discoveryRunIdInput, raw);
    this.assertNoWorkflow();

    return this.extraction.extract(this.get({ id }));
  }

  async retryExtraction(
    raw: z.input<typeof discoverySourceInput>,
  ): Promise<JdExtraction[]> {
    const { id, sourceId } = parse(discoverySourceInput, raw);
    this.assertNoWorkflow();

    return this.extraction.extract(this.get({ id }), sourceId);
  }

  /** Accept one main-owned execution; the IPC reply does not wait for network/model work. */
  executeWorkflow(raw: z.input<typeof discoveryRunIdInput>): {
    accepted: true;
  } {
    const { id } = parse(discoveryRunIdInput, raw);
    const run = this.get({ id });
    if (this.workflows.has(id)) return { accepted: true };

    if (run.status !== 'running' || this.isActive())
      throw new AppError('CONFLICT', 'Discovery run cannot be executed again.');
    if (!this.web)
      throw new AppError('CONFLICT', 'Web discovery is unavailable.');

    const deadline = runDeadline(run);
    if (this.clock().getTime() >= deadline)
      throw new AppError('CONFLICT', 'Discovery run deadline reached.');

    const controller = new AbortController();
    this.workflows.add(id);
    this.active.set(id, controller);
    this.workflowProgress.set(id, {
      submitted: 0,
      settled: 0,
      steps: new Map(),
    });

    // Catch at the ownership boundary: no unhandled detached background rejection.
    void this.runWorkflow(run, deadline, controller)
      .catch(() => this.failWorkflow(id, controller))
      .finally(() => this.releaseWorkflow(id));

    return { accepted: true };
  }

  /** Explicit, one-shot discovery step. A stage-013.2 plan is never replayed after restart. */
  async execute(
    raw: z.input<typeof discoveryRunIdInput>,
  ): Promise<DiscoveryRun> {
    return (await this.collect(raw)).run;
  }

  // ---- Review and tracking helpers ----

  private requireCandidate(id: string, sourceId: string): DiscoveryCandidate {
    this.get({ id });

    const candidate = this.repo.admitted(id, sourceId);
    if (!candidate)
      throw new AppError('NOT_FOUND', 'Candidate not found in this run.');

    return candidate;
  }

  private assessCandidateSnapshot(
    runId: string,
    candidate: DiscoveryCandidate,
  ) {
    const { sourceId } = candidate;

    return assessSnapshot(
      candidate,
      this.repo.verifiedCapture(runId, sourceId),
      !!this.repo.currentExtraction(runId, sourceId),
    );
  }

  private review(id: string, sourceId: string): DiscoveryReview {
    const candidate = this.requireCandidate(id, sourceId);
    const state = this.repo.review(id, sourceId)!;
    const assessment = this.assessCandidateSnapshot(id, candidate);
    const applicationSnapshotCaptured =
      !!state.applicationId &&
      !!this.applications?.get(state.applicationId).snapshot;

    return discoveryReviewSchema.parse({
      opportunityId: candidate.id,
      sourceId,
      ...state,
      applicationSnapshotCaptured,
      snapshot: assessment.status,
    });
  }

  /** Enforces the tracking preconditions, then creates the application record. */
  private createTrackedApplication(
    applications: TrackingApplications,
    runId: string,
    candidate: DiscoveryCandidate,
    decision: DiscoveryReview['decision'],
    flags: {
      confirmUnverified?: boolean;
      withoutSnapshot?: boolean;
      allowDuplicate: boolean;
    },
  ) {
    const verified = !!this.repo.verifiedCapture(runId, candidate.sourceId);

    if (decision === 'dismissed')
      throw new AppError(
        'CONFLICT',
        'Restore the dismissed opportunity before tracking.',
      );
    if (!verified && !flags.confirmUnverified)
      throw new AppError(
        'CONFLICT',
        'Confirm the unverified source URL before tracking.',
      );

    const assessment = this.assessCandidateSnapshot(runId, candidate);
    const snapshotAvailable = assessment.status === 'available';
    if (!snapshotAvailable && !flags.withoutSnapshot)
      throw new AppError(
        'CONFLICT',
        'The verified JD cannot fit a complete application snapshot. ' +
          'Choose tracking without a snapshot.',
      );
    if (snapshotAvailable && flags.withoutSnapshot)
      throw new AppError(
        'INVALID_INPUT',
        'A complete verified JD is available; capture it when tracking.',
      );

    const jobUrl = jobReferenceUrl(candidate, verified);
    const manual = applications.findByJobReference(jobUrl);
    if (manual && !flags.allowDuplicate)
      throw new AppError(
        'CONFLICT',
        'An application with this exact job reference already exists. ' +
          'Choose whether to open it or create a separate application.',
      );

    return applications.create(
      {
        companyName: candidate.company ?? 'Employer not specified',
        roleTitle: candidate.title.slice(0, 200),
        location: candidate.location,
        jobUrl,
        initialStage: { stageLabel: 'Pending', stageKind: 'saved' },
        ...(assessment.status === 'available'
          ? { snapshot: assessment.snapshot }
          : {}),
      },
      candidate.id,
    );
  }

  // ---- Resolution, matching and workflow-state helpers ----

  private get resolver(): CanonicalResolver | null {
    if (!this.web) return null;

    // Lazily created once per service instance so concurrent calls share the guard.
    return (this.resolution ??= new CanonicalResolver(
      this.repo,
      this.web,
      this.clock,
    ));
  }

  private requireResolver(): CanonicalResolver {
    const resolver = this.resolver;
    if (!resolver)
      throw new AppError('CONFLICT', 'Web resolution is unavailable.');

    return resolver;
  }

  private assertNoWorkflow(): void {
    if (this.workflows.size)
      throw new AppError('CONFLICT', 'Discovery workflow is in progress.');
  }

  private isWorkflowRunActive(id: string): boolean {
    return (
      this.workflows.has(id) ||
      this.active.has(id) ||
      !!this.resolver?.isActiveRun(id) ||
      this.extraction.isActiveRun(id)
    );
  }

  private candidateFacts(
    run: DiscoveryRun,
    candidate: DiscoveryCandidate,
    evidence: WorkflowEvidence[],
    live: WorkflowProgress | undefined,
  ): CandidateFacts {
    const fact = evidence.find((item) => item.sourceId === candidate.sourceId)!;
    const verified = !!candidate.canonicalUrl && !!fact.verifiedAt;
    const ready = verified && fact.extractionStatus === 'extracted';
    const currentMatch =
      !!fact.match && ready && fact.match.extractionId === fact.extractionId;
    const retryAllowed =
      run.status !== 'running' && !this.isActive() && !this.repo.hasRunning();

    return {
      run,
      candidate,
      fact,
      active: live?.steps.get(candidate.sourceId),
      verified,
      ready,
      currentMatch,
      retryAllowed,
    };
  }

  private matchContext(): MatchContext {
    let skills: string[] | null = null;
    let location: string | null = null;

    if (this.profile) {
      try {
        skills = this.profile.listConfirmedSkills();
        location = this.profile.getProfile().location;
      } catch (error) {
        if (!(error instanceof AppError && error.code === 'NOT_FOUND'))
          throw error;
      }
    }

    return { skills, location, fingerprint: skillsFingerprint(skills) };
  }

  private computeMatch(
    context: MatchContext,
    candidate: DiscoveryCandidate,
    extraction: JdExtraction | null,
  ): DiscoveryMatch {
    return matchRequiredSkills({
      opportunityId: candidate.id,
      extractionId: extraction?.id ?? null,
      jd: extraction?.jd ?? null,
      confirmedSkills: context.skills,
      profileLocation: context.location,
      fingerprint: context.fingerprint,
      computedAt: this.clock().toISOString(),
    });
  }

  private refreshCandidateMatch(id: string, sourceId: string): void {
    const candidate = this.repo.admitted(id, sourceId);
    const extraction = this.repo.currentExtraction(id, sourceId);
    if (!candidate || !extraction || this.get({ id }).status !== 'running')
      return;

    this.repo.saveMatch(
      id,
      sourceId,
      this.computeMatch(this.matchContext(), candidate, extraction),
    );
  }

  // ---- Background workflow ----

  private failWorkflow(id: string, controller: AbortController): void {
    controller.abort();
    if (this.get({ id }).status !== 'running') return;

    this.repo.cancelWorkflowAttempts(id, this.clock().toISOString());
    this.repo.appendDiagnostic(
      id,
      'EXECUTION_FAILED',
      this.clock().toISOString(),
    );
    this.repo.finish(id, 'failed', this.clock().toISOString());
  }

  private releaseWorkflow(id: string): void {
    this.workflows.delete(id);
    this.active.delete(id);
    this.workflowProgress.delete(id);
  }

  private async runWorkflow(
    run: DiscoveryRun,
    deadline: number,
    controller: AbortController,
  ): Promise<void> {
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(0, deadline - this.clock().getTime()),
    );
    const web = this.scopedWeb(run);
    const context: WorkflowContext = {
      run,
      deadline,
      controller,
      resolver: new CanonicalResolver(this.repo, web, this.clock),
      progress: this.workflowProgress.get(run.id)!,
      candidateFailures: 0,
    };

    // Candidates are processed strictly one at a time, in admission order.
    let pending = Promise.resolve();

    try {
      const collected = await this.collect(
        { id: run.id },
        {
          controller,
          web,
          onAdmitted: (candidate) => {
            pending = pending.then(() =>
              this.advanceCandidate(context, candidate.sourceId),
            );
          },
        },
      );
      await pending;

      this.finishWorkflowRun(context, collected);
    } finally {
      clearTimeout(timer);
    }
  }

  private isWorkflowAvailable(context: WorkflowContext): boolean {
    return (
      !context.controller.signal.aborted &&
      this.clock().getTime() < context.deadline &&
      this.get({ id: context.run.id }).status === 'running'
    );
  }

  /** Resolve, extract and match one admitted candidate; failures are counted, not thrown. */
  private async advanceCandidate(
    context: WorkflowContext,
    sourceId: string,
  ): Promise<void> {
    if (!this.isWorkflowAvailable(context)) return;

    const { run, deadline, controller, progress } = context;
    const { id } = run;

    try {
      const verified = await this.ensureWorkflowStep(
        context,
        sourceId,
        'resolution',
        () => !!this.repo.verifiedCapture(id, sourceId),
        () =>
          context.resolver.resolveWithinRun(
            run,
            sourceId,
            deadline,
            controller.signal,
          ),
      );
      if (!verified) return;

      const extracted = await this.ensureWorkflowStep(
        context,
        sourceId,
        'extraction',
        () => !!this.repo.currentExtraction(id, sourceId),
        () =>
          this.extraction.extractWithinRun(
            run,
            sourceId,
            deadline,
            controller.signal,
          ),
      );
      if (!extracted) return;

      progress.steps.set(sourceId, 'matching');
      this.refreshCandidateMatch(id, sourceId);
    } catch {
      if (this.isWorkflowAvailable(context)) context.candidateFailures++;
    } finally {
      progress.steps.delete(sourceId);
    }
  }

  /**
   * Runs `work` unless the step's result already exists. Returns whether the
   * pipeline may continue; a missing result after the step counts as a failure.
   */
  private async ensureWorkflowStep(
    context: WorkflowContext,
    sourceId: string,
    step: 'resolution' | 'extraction',
    isDone: () => boolean,
    work: () => Promise<unknown>,
  ): Promise<boolean> {
    if (!isDone()) {
      context.progress.steps.set(sourceId, step);
      await work();
      context.progress.steps.delete(sourceId);
    }

    if (!this.isWorkflowAvailable(context)) return false;

    if (!isDone()) {
      context.candidateFailures++;
      return false;
    }

    return true;
  }

  private finishWorkflowRun(
    context: WorkflowContext,
    collected: CollectionOutcome,
  ): void {
    const { id } = context.run;
    if (this.get({ id }).status !== 'running') return;

    if (!this.isWorkflowAvailable(context))
      this.repo.appendDiagnostic(
        id,
        'DEADLINE_REACHED',
        this.clock().toISOString(),
      );

    const deadlineFailure = this.isWorkflowAvailable(context) ? 0 : 1;
    const failures =
      context.candidateFailures + collected.failures + deadlineFailure;
    const extractedCandidates = this.repo
      .candidates(id)
      .filter(
        (candidate) => !!this.repo.currentExtraction(id, candidate.sourceId),
      ).length;
    const successes = collected.successes + extractedCandidates;

    let status: 'completed' | 'partial' | 'failed' = 'completed';
    if (failures) status = successes ? 'partial' : 'failed';

    this.repo.finish(id, status, this.clock().toISOString());
  }

  /** One Web search lane (Web owns its FIFO) and one read lane for a two-operation run. */
  private scopedWeb(run: DiscoveryRun): DiscoveryWeb {
    const web = this.web!;
    let held = false;
    const waiters: Array<() => void> = [];

    const withPermit = async <T>(work: () => Promise<T>): Promise<T> => {
      if (held) await new Promise<void>((resolve) => waiters.push(resolve));
      held = true;

      try {
        return await work();
      } finally {
        held = false;
        waiters.shift()?.();
      }
    };

    const singleLane = run.configSnapshot.run.maxConcurrentWebOperations === 1;

    return {
      search: (query, options) =>
        singleLane
          ? withPermit(() => web.search(query, options))
          : web.search(query, options),
      readPage: (url, options) => withPermit(() => web.readPage(url, options)),
    };
  }

  // ---- Collection ----

  /**
   * Runs the query plan and admits candidates. With `options` it is a step of a
   * background workflow (caller owns controller, timer and run completion);
   * without, it is a standalone one-shot execution that finishes the run itself.
   */
  private async collect(
    raw: z.input<typeof discoveryRunIdInput>,
    options?: CollectionOptions,
  ): Promise<CollectionOutcome> {
    const { id } = parse(discoveryRunIdInput, raw);
    const run = this.get({ id });
    if (run.status !== 'running' || (!options && this.isActive()))
      throw new AppError('CONFLICT', 'Discovery run cannot be executed again.');
    if (!this.web)
      throw new AppError('CONFLICT', 'Web discovery is unavailable.');

    const controller = options?.controller ?? new AbortController();
    if (!options) this.active.set(id, controller);

    const deadline = runDeadline(run);
    const timer = options
      ? null
      : setTimeout(
          () => controller.abort(),
          Math.max(0, deadline - this.clock().getTime()),
        );

    const context: CollectionContext = {
      run,
      budget: run.configSnapshot.run,
      controller,
      web: options?.web ?? this.web,
      deadline,
      onAdmitted: options?.onAdmitted,
      diagnostics: [],
      successes: 0,
      searchCalls: 0,
    };

    try {
      await this.collectQueries(context, !!options);
    } catch {
      this.diagnose(context, 'EXECUTION_FAILED');
    } finally {
      if (timer) clearTimeout(timer);
      if (!options) {
        this.active.delete(id);
        this.finishStandaloneCollection(context);
      }
    }

    return {
      run: this.get({ id }),
      successes: context.successes,
      failures: context.diagnostics.length,
    };
  }

  private async collectQueries(
    context: CollectionContext,
    yieldBetweenQueries: boolean,
  ): Promise<void> {
    const { run, budget } = context;
    const { maxQueries } = run.configSnapshot.query;

    // Sequential Web calls are intentionally below the snapshot concurrency ceiling (1 <= 2).
    for (const query of run.queryPlan.slice(0, maxQueries)) {
      if (!this.isCollecting(context)) break;
      if (context.searchCalls >= maxQueries) break;
      if (candidateBudgetReached(this.get({ id: run.id }).stats, budget)) break;

      let results;
      try {
        results = (await this.searchWithRetry(context, query)).results;
        if (!this.isCollecting(context)) break;
        context.successes++;
      } catch (error) {
        if (!this.isCollecting(context)) break;
        this.diagnose(context, webDiagnostic(error));
        continue;
      }

      for (const hit of results) {
        if (!this.isCollecting(context)) break;

        const stats = this.get({ id: run.id }).stats;
        if (candidateBudgetReached(stats, budget)) break;

        // Only collection pages are awaited, so listing hits add no extra ticks.
        const pending = this.collectHit(context, hit, stats);
        if (pending !== 'next' && (await pending) === 'stop') break;
      }

      // Give the first candidate a FIFO turn before submitting the next broad search.
      if (yieldBetweenQueries) await Promise.resolve();
    }
  }

  /** Admits a direct listing hit, or reads a collection hit; 'stop' ends the hit loop. */
  private collectHit(
    context: CollectionContext,
    hit: SearchHit,
    stats: DiscoveryRun['stats'],
  ): 'next' | Promise<'stop' | 'next'> {
    const kind = classifyHit(hit);
    if (kind === 'individual_listing') {
      const candidate = directCandidate(hit);
      if (candidate) this.admit(context, candidate);
      return 'next';
    }

    const canReadCollection =
      kind === 'job_collection' &&
      context.budget.maxCollectionPages > stats.collectionPagesRead;
    if (!canReadCollection) return 'next';

    return this.collectFromPage(context, hit.url);
  }

  /** Reads one job-collection page and admits its listings; 'stop' ends the hit loop. */
  private async collectFromPage(
    context: CollectionContext,
    url: string,
  ): Promise<'stop' | 'next'> {
    const { collectionProviders } = context.run.configSnapshot.sources;
    const provider = collectionProvider(url);
    if (!provider || !collectionProviders.includes(provider)) return 'next';

    try {
      const page = await this.readWithRetry(context, url);
      if (!this.isCollecting(context)) return 'stop';

      if (isChallengePage(page)) {
        this.diagnose(context, 'WEB_CHALLENGE');
        return 'next';
      }

      if (isBlockedPage(page, provider)) {
        this.diagnose(context, 'PAGE_BLOCKED');
        return 'next';
      }

      context.successes++;
      this.admitCollection(
        context,
        extractCollection(page, collectionProviders),
      );
    } catch (error) {
      if (!this.isCollecting(context)) return 'stop';
      this.diagnose(context, webDiagnostic(error));
    }

    return 'next';
  }

  private admitCollection(
    context: CollectionContext,
    candidates: CandidateObservation[],
  ): void {
    for (const candidate of candidates) {
      if (!this.isCollecting(context)) break;

      const stats = this.get({ id: context.run.id }).stats;
      if (candidateBudgetReached(stats, context.budget)) break;

      this.admit(context, candidate);
    }
  }

  private admit(
    context: CollectionContext,
    candidate: CandidateObservation,
  ): void {
    const admitted = this.identity.observe(
      context.run.id,
      candidate,
      this.clock().toISOString(),
    );
    if (admitted) context.onAdmitted?.(admitted);
  }

  private searchWithRetry(context: CollectionContext, query: string) {
    const { run, budget, controller, deadline } = context;
    const { id } = run;

    const attempt = () => {
      context.searchCalls++;
      const progress = this.workflowProgress.get(id);
      if (progress) progress.submitted++;

      return context.web
        .search(query, { signal: controller.signal, ownerId: id, deadline })
        .finally(() => {
          if (progress) progress.settled++;
        });
    };

    const canRetry = () =>
      budget.maxTransientRetries > this.get({ id }).stats.transientRetries &&
      context.searchCalls < run.configSnapshot.query.maxQueries &&
      this.isCollecting(context);

    return this.withTransientRetry(id, attempt, canRetry);
  }

  private readWithRetry(
    context: CollectionContext,
    url: string,
  ): Promise<PageReadResult> {
    const { budget, controller } = context;
    const { id } = context.run;

    const attempt = () => {
      const stats = this.get({ id }).stats;
      if (stats.collectionPagesRead >= budget.maxCollectionPages)
        throw new AppError('CONFLICT', 'Collection read budget reached.');

      stats.collectionPagesRead++;
      this.repo.updateProgress(id, stats);

      return context.web.readPage(url, { signal: controller.signal });
    };

    const canRetry = () => {
      if (!this.isCollecting(context)) return false;

      const stats = this.get({ id }).stats;

      return (
        budget.maxTransientRetries > stats.transientRetries &&
        stats.collectionPagesRead < budget.maxCollectionPages
      );
    };

    return this.withTransientRetry(id, attempt, canRetry);
  }

  /** Retries once on a transient, non-rate-limit Web error when budget allows. */
  private async withTransientRetry<T>(
    id: string,
    attempt: () => Promise<T>,
    canRetry: () => boolean,
  ): Promise<T> {
    try {
      return await attempt();
    } catch (error) {
      if (!isTransientWebError(error) || !canRetry()) throw error;

      const stats = this.get({ id }).stats;
      stats.transientRetries++;
      this.repo.updateProgress(id, stats);

      return attempt();
    }
  }

  private isCollecting(context: CollectionContext): boolean {
    return (
      this.get({ id: context.run.id }).status === 'running' &&
      !context.controller.signal.aborted &&
      this.clock().getTime() < context.deadline
    );
  }

  private diagnose(context: CollectionContext, code: DiagnosticCode): void {
    if (context.diagnostics.length >= MAX_COLLECTION_DIAGNOSTICS) return;

    context.diagnostics.push(code);
    this.repo.appendDiagnostic(
      context.run.id,
      code,
      this.clock().toISOString(),
    );
  }

  private finishStandaloneCollection(context: CollectionContext): void {
    const { id } = context.run;
    if (this.get({ id }).status !== 'running') return;

    const expired =
      this.clock().getTime() >= context.deadline ||
      context.controller.signal.aborted;
    if (expired) this.diagnose(context, 'DEADLINE_REACHED');

    let status: 'completed' | 'partial' | 'failed' = 'completed';
    if (context.diagnostics.length)
      status = context.successes ? 'partial' : 'failed';

    this.repo.finish(id, status, this.clock().toISOString());
  }
}

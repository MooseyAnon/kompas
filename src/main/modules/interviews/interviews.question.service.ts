import {
  INTERVIEW_QUESTION_PROMPT_VERSION,
  interviewQuestionProvenanceSchema,
  type ApprovedOrProvisionalBar,
  type GenerationRequestInput,
  type GenerationResult,
  type InterviewQuestionProvenance,
  type InterviewQuestionsGenerateOutput,
  type InterviewQuestionsPreviewClearOutput,
  type InterviewQuestionsPreviewGetOutput,
  type InterviewQuestionView,
  type InterviewSession,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { TelemetryService } from '../telemetry/telemetry.service';
import type {
  InterviewsRepository,
  PreviewRecord,
} from './interviews.repository';
import {
  buildProvisionalBar,
  buildQuestionMessages,
  buildRepairMessage,
  questionResponseFormat,
  validateGeneratedQuestion,
  type QuestionRubric,
  type ValidatedQuestion,
} from './interviews.question-prompt';
import {
  collectConfirmedFacts,
  newId,
  now,
  parseBar,
  recordTelemetry,
  sessionNotFound,
  shorten,
  type InterviewsIdentityReader,
  type InterviewsInferenceClient,
  type TelemetryDetail,
  type TelemetryOutcome,
} from './interviews.shared';

/**
 * Narrow, in-process view of the core inference service the interviews domain
 * depends on. Injected via core wiring so the domain never touches the worker,
 * provider adapters or renderer IPC. Structurally satisfied by `InferenceService`.
 */
export interface InterviewInferenceClient extends InterviewsInferenceClient {}

/**
 * Read-only identity context the interviews domain is allowed to see. Exposes
 * only the minimal typed reads needed to ground a question — never raw document
 * text or a generic profile dump. Structurally satisfied by `IdentityService`.
 */
export interface IdentityContextReader extends InterviewsIdentityReader {}

export interface InterviewQuestionServiceDeps {
  repository: InterviewsRepository;
  identity: IdentityContextReader;
  inference?: InterviewInferenceClient;
  telemetry?: TelemetryService;
}

/** Full provenance persisted in `interview_questions.source_json`. */
interface StoredProvenance extends InterviewQuestionProvenance {
  schemaVersion: 1;
  inferenceRequestId: string;
}

/** Upper bound on a rubric criterion description shown in the preview. */
const RUBRIC_SUMMARY_MAX_CHARS = 200;

/**
 * Owns grounded single-question generation and the reversible draft preview for
 * a `draft` interview session. It collects a minimal approved context, freezes a
 * clearly-labelled provisional benchmark before presenting, generates exactly
 * one structurally-validated primary question + rubric through the shared
 * provider-neutral inference service, and persists it idempotently. No answering,
 * scoring, coaching or multi-question flow happens here.
 */
export class InterviewQuestionService {
  private readonly repository: InterviewsRepository;
  private readonly identity: IdentityContextReader;
  private readonly inference?: InterviewInferenceClient;
  private readonly telemetry?: TelemetryService;
  /** Per-session in-flight guard against concurrent generation. */
  private readonly generating = new Set<string>();

  constructor(deps: InterviewQuestionServiceDeps) {
    this.repository = deps.repository;
    this.identity = deps.identity;
    this.inference = deps.inference;
    this.telemetry = deps.telemetry;
  }

  isActive(): boolean {
    return this.generating.size > 0;
  }

  /** The current preview question (or null) and frozen bar for a session. */
  getPreview(sessionId: string): InterviewQuestionsPreviewGetOutput {
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    const preview = this.repository.getPreview(sessionId);

    return {
      question: preview
        ? this.publicQuestion(session, this.toView(preview))
        : null,
      bar: this.isUnpublishedQuickFire(session)
        ? null
        : parseBar(session.barSnapshot),
    };
  }

  /** Discard a draft's preview atomically. Safe only for an unanswered draft. */
  clearPreview(sessionId: string): InterviewQuestionsPreviewClearOutput {
    const startedAt = now();
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    if (session.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        'Only an unstarted draft preview can be cleared.',
      );
    }

    if (this.repository.hasRoundActivity(sessionId)) {
      throw new AppError(
        'CONFLICT',
        'This interview already has answers or reviews and cannot be reset.',
      );
    }

    const cleared = this.repository.clearPreview(sessionId, now());
    this.record('questions.preview.clear', startedAt, 'success', {
      cleared,
    });

    return { cleared };
  }

  /**
   * Generate (or return the existing) single primary preview question for a
   * draft. Repeated clicks and concurrent calls never create a second primary
   * question in the same draft slot.
   */
  async generate(sessionId: string): Promise<InterviewQuestionsGenerateOutput> {
    const startedAt = now();
    const session = this.repository.getSession(sessionId);
    if (!session) {
      throw sessionNotFound();
    }

    if (session.status !== 'draft') {
      throw new AppError(
        'CONFLICT',
        'Questions can only be generated for an unstarted draft.',
      );
    }

    // Idempotent: a preview already exists — return it without regenerating.
    const existing = this.repository.getPreview(sessionId);
    if (existing) {
      return this.previewOutput(session, existing);
    }

    if (this.generating.has(sessionId)) {
      throw new AppError(
        'CONFLICT',
        'A question is already being generated for this draft.',
      );
    }

    this.generating.add(sessionId);
    try {
      // Re-check after acquiring the in-flight guard.
      const raced = this.repository.getPreview(sessionId);
      if (raced) {
        return this.previewOutput(session, raced);
      }

      return await this.generateAndPersist(session, startedAt);
    } catch (error) {
      this.record('questions.generate', startedAt, 'failure', {
        errorCode: error instanceof AppError ? error.code : 'INTERNAL',
      });
      throw error;
    } finally {
      this.generating.delete(sessionId);
    }
  }

  // --- internals ------------------------------------------------------------

  /** Quick-fire benchmarks and rubrics stay hidden until publication. */
  private isUnpublishedQuickFire(session: InterviewSession): boolean {
    return (
      session.method === 'quick_fire' &&
      !this.repository.getPublication(session.id)
    );
  }

  private publicSession(session: InterviewSession): InterviewSession {
    return this.isUnpublishedQuickFire(session)
      ? { ...session, barSnapshot: null }
      : session;
  }

  private publicQuestion(
    session: InterviewSession,
    question: InterviewQuestionView,
  ): InterviewQuestionView {
    return this.isUnpublishedQuickFire(session)
      ? { ...question, rubricSummary: null }
      : question;
  }

  private previewOutput(
    session: InterviewSession,
    preview: PreviewRecord,
  ): InterviewQuestionsGenerateOutput {
    return {
      session: this.publicSession(session),
      question: this.publicQuestion(session, this.toView(preview)),
    };
  }

  /** Freeze a provisional bar, generate one validated question and save it. */
  private async generateAndPersist(
    session: InterviewSession,
    startedAt: string,
  ): Promise<InterviewQuestionsGenerateOutput> {
    const sessionId = session.id;
    const { providerId, modelId } = await this.resolveModel();

    const bar = buildProvisionalBar({
      subject: session.subject,
      target: session.targetSnapshot,
      careerTargetId: session.careerTargetId,
    });
    const baseMessages = buildQuestionMessages({
      subject: session.subject,
      target: session.targetSnapshot,
      facts: collectConfirmedFacts(this.identity),
      bar,
      excludeQuestions: [],
      guidance: session.additionalGuidance,
    });

    const { validated, requestId, retried } = await this.runGeneration(
      providerId,
      modelId,
      baseMessages,
    );

    const provenance: StoredProvenance = {
      schemaVersion: 1,
      origin: 'generated',
      providerId,
      modelId,
      promptVersion: INTERVIEW_QUESTION_PROMPT_VERSION,
      inferenceRequestId: requestId,
      sourceBasis: validated.sourceBasis,
      validation: 'passed',
      generatedAt: now(),
    };
    this.persistPreview(sessionId, validated, provenance, bar);

    const saved = this.repository.getPreview(sessionId);
    const freshSession = this.repository.getSession(sessionId);
    if (!saved || !freshSession) {
      throw new AppError('INTERNAL');
    }

    this.record('questions.generate', startedAt, 'success', {
      providerId,
      modelId,
      promptVersion: INTERVIEW_QUESTION_PROMPT_VERSION,
      hasTarget: session.careerTargetId !== null,
      retried,
      validation: 'passed',
    });

    return this.previewOutput(freshSession, saved);
  }

  private async resolveModel(): Promise<{
    providerId: string;
    modelId: string;
  }> {
    if (!this.inference) {
      throw new AppError(
        'CONFLICT',
        'Local AI is not configured. Open Local AI settings to set it up.',
      );
    }

    const snapshot = await this.inference.getSettingsSnapshot();
    const { providerId, modelId } = snapshot.settings;
    if (!providerId || !modelId) {
      throw new AppError(
        'CONFLICT',
        'Select an installed local model in Local AI settings before ' +
          'generating a question.',
      );
    }

    const resolved = snapshot.resolvedModel;
    if (!resolved || !resolved.installed || resolved.locality !== 'local') {
      throw new AppError(
        'CONFLICT',
        'The selected local model is not available. Open Local AI settings ' +
          'to pick an installed local model.',
      );
    }

    return { providerId, modelId };
  }

  private async runGeneration(
    providerId: string,
    modelId: string,
    baseMessages: GenerationRequestInput['messages'],
  ): Promise<{
    validated: ValidatedQuestion;
    requestId: string;
    retried: boolean;
  }> {
    const first = await this.callGenerate(providerId, modelId, baseMessages);
    if (first.status === 'completed') {
      const validation = validateGeneratedQuestion(first.output);
      if (validation.ok) {
        return {
          validated: validation.value,
          requestId: first.requestId,
          retried: false,
        };
      }
    } else {
      this.failIfUnrepairable(first);
    }

    // At most one bounded repair attempt for a structural/semantic failure.
    const repairMessages = [...baseMessages, buildRepairMessage()];
    const second = await this.callGenerate(providerId, modelId, repairMessages);
    if (second.status === 'completed') {
      const validation = validateGeneratedQuestion(second.output);
      if (validation.ok) {
        return {
          validated: validation.value,
          requestId: second.requestId,
          retried: true,
        };
      }
    } else {
      this.failIfUnrepairable(second);
    }

    throw new AppError(
      'CONFLICT',
      'The local model returned an unusable response. Please try again.',
    );
  }

  private async callGenerate(
    providerId: string,
    modelId: string,
    messages: GenerationRequestInput['messages'],
  ): Promise<GenerationResult> {
    if (!this.inference) {
      throw new AppError('CONFLICT', 'Local AI is not configured.');
    }
    return this.inference.generate({
      callerModule: 'interviews',
      execution: { priority: 'interactive' },
      providerId,
      modelId,
      messages,
      thinking: false,
      responseFormat: questionResponseFormat,
      toolNames: [],
    });
  }

  /** Throw a safe, actionable error for failures that a retry cannot fix. */
  private failIfUnrepairable(result: GenerationResult): void {
    if (result.status === 'completed') {
      return;
    }
    if (result.status === 'cancelled') {
      throw new AppError(
        'CONFLICT',
        'Question generation was cancelled. Please try again.',
      );
    }
    const code = result.error?.code;
    // Structural output problems are the only retryable failures here.
    if (code === 'INVALID_SCHEMA' || code === 'INVALID_RESPONSE') {
      return;
    }
    throw new AppError(
      'CONFLICT',
      messageForFailure(
        code === 'RETRIES_EXHAUSTED' ? result.lastErrorCode : code,
      ),
    );
  }

  private persistPreview(
    sessionId: string,
    validated: ValidatedQuestion,
    provenance: StoredProvenance,
    bar: ApprovedOrProvisionalBar,
  ): void {
    try {
      this.repository.insertPreview({
        sessionId,
        roundId: newId(),
        questionId: newId(),
        questionText: validated.question,
        competency: validated.competency,
        rubric: validated.rubric,
        source: provenance,
        bar,
        now: now(),
      });
    } catch (error) {
      // A concurrent insert won the unique slot: treat as idempotent success.
      if (this.repository.getPreview(sessionId)) {
        return;
      }
      throw error instanceof AppError ? error : new AppError('INTERNAL');
    }
  }

  private toView(preview: PreviewRecord): InterviewQuestionView {
    const rubric = parseRubric(preview.rubricJson);
    const provenance = parseProvenance(preview.sourceJson);

    return {
      id: preview.questionId,
      roundId: preview.roundId,
      question: preview.questionText,
      competency: preview.competency ?? 'general',
      createdAt: preview.createdAt,
      rubricSummary: rubric
        ? rubric.criteria.map((c) =>
            shorten(c.description, RUBRIC_SUMMARY_MAX_CHARS),
          )
        : null,
      provenance,
    };
  }

  private record(
    operation: string,
    startedAt: string,
    outcome: TelemetryOutcome,
    detail: TelemetryDetail,
  ): void {
    recordTelemetry(this.telemetry, operation, startedAt, outcome, detail);
  }
}

function messageForFailure(code: string | undefined): string {
  switch (code) {
    case 'PROVIDER_UNAVAILABLE':
    case 'WORKER_UNAVAILABLE':
    case 'WORKER_EXITED':
      return (
        'The local model is not reachable. Open Local AI settings to check ' +
        'it is running.'
      );
    case 'MODEL_NOT_FOUND':
      return (
        'The selected model is not installed. Open Local AI settings to pick ' +
        'an installed local model.'
      );
    case 'CAPABILITY_UNSUPPORTED':
      return (
        'The selected model cannot produce structured output. Pick a ' +
        'different local model in Local AI settings.'
      );
    case 'TIMEOUT':
      return 'The local model timed out. Please try again.';
    case 'OVER_CAPACITY':
    case 'LIMIT_EXCEEDED':
      return 'The local model is busy. Please try again in a moment.';
    default:
      return 'Question generation failed. Please try again.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStoredRubric(value: unknown): value is QuestionRubric {
  return isRecord(value) && Array.isArray(value.criteria);
}

function parseRubric(json: string | null): QuestionRubric | null {
  if (!json) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(json);

    return isStoredRubric(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseProvenance(json: string | null): InterviewQuestionProvenance {
  const fallback: InterviewQuestionProvenance = {
    origin: 'generated',
    providerId: 'unknown',
    modelId: 'unknown',
    promptVersion: INTERVIEW_QUESTION_PROMPT_VERSION,
    sourceBasis: 'model_general_knowledge',
    validation: 'passed',
    generatedAt: new Date(0).toISOString(),
  };
  if (!json) {
    return fallback;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return fallback;
    }

    // Pick only the public fields; the stored row also carries internal ids.
    const result = interviewQuestionProvenanceSchema.safeParse({
      origin: parsed.origin,
      providerId: parsed.providerId,
      modelId: parsed.modelId,
      promptVersion: parsed.promptVersion,
      sourceBasis: parsed.sourceBasis,
      validation: parsed.validation,
      generatedAt: parsed.generatedAt,
    });

    return result.success ? result.data : fallback;
  } catch {
    return fallback;
  }
}

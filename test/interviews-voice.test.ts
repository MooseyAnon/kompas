import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage, type Storage } from '../src/main/core/storage';
import { createDispatcher, type Dispatcher } from '../src/main/ipc/dispatcher';
import { JsonlLogger } from '../src/main/modules/telemetry/jsonl-log';
import { TelemetryRepository } from '../src/main/modules/telemetry/telemetry.repository';
import { TelemetryService } from '../src/main/modules/telemetry/telemetry.service';
import { AudioRepository } from '../src/main/modules/audio/audio.repository';
import { RecordingService } from '../src/main/modules/audio/audio.service';
import { createAudioModule } from '../src/main/modules/audio/audio.module';
import { TranscriptionRepository } from '../src/main/modules/audio/stt/transcription.repository';
import { TranscriptionService } from '../src/main/modules/audio/stt/transcription.service';
import type {
  ProviderProbe,
  RecordingSource,
  TranscriptionOptions,
  TranscriptionOutcome,
  TranscriptionProvider,
} from '../src/main/modules/audio/stt/transcription-provider';
import { InterviewsRepository } from '../src/main/modules/interviews/interviews.repository';
import { InterviewsService } from '../src/main/modules/interviews/interviews.service';
import { InterviewQuestionService } from '../src/main/modules/interviews/interviews.question.service';
import { InterviewReviewService } from '../src/main/modules/interviews/interviews.review.service';
import { InterviewSessionService } from '../src/main/modules/interviews/interviews.session.service';
import { InterviewVoiceService } from '../src/main/modules/interviews/interviews.voice.service';
import { InterviewAudioCoordinator } from '../src/main/modules/interviews/interviews.audio';
import { createInterviewsModule } from '../src/main/modules/interviews/interviews.module';
import type {
  GenerationRequestInput,
  GenerationResult,
  InferenceSettingsGetOutput,
  JsonValue,
  ModelDescriptor,
  ResponseEnvelope,
  SttFailureCode,
  Target,
} from '../src/shared/contracts';
import {
  AUDIO_MAX_CHUNK_BYTES,
  AUDIO_SAMPLE_RATE,
} from '../src/shared/contracts';

// --- deterministic inference fake (question/review/coach) -------------------

type Task = 'question' | 'review' | 'coach';

function detectTask(request: GenerationRequestInput): Task {
  const format = request.responseFormat;
  if (format && format.type === 'json_schema') {
    const props = format.schema.properties;
    if ('criterionIds' in props) {
      return 'review';
    }
    if ('diagnosis' in props) {
      return 'coach';
    }
  }
  return 'question';
}

function criterionIdsFrom(request: GenerationRequestInput): string[] {
  const text = request.messages.map((m) => m.content).join('\n');
  const ids: string[] = [];
  const pattern = /id "([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    ids.push(match[1]);
  }
  return ids;
}

const SCENARIOS = [
  'how feudal land tenure shaped military obligations',
  'why monastic scriptoria preserved classical knowledge',
  'how guild apprenticeship regulated urban craft quality',
  'what triggered the growth of market towns and fairs',
  'how the Black Death reshaped rural labour relations',
  'why pilgrimage routes influenced regional economies',
  'how coinage debasement affected trust in trade',
  'what role cathedral building played in civic identity',
  'how marriage alliances stabilised competing dynasties',
  'why charters constrained the power of lords over towns',
  'how crop rotation changed village food security',
  'what made maritime republics dominate Mediterranean trade',
];

function fakeQuestion(kind: string, n: number): JsonValue {
  const scenario = SCENARIOS[n % SCENARIOS.length];
  return {
    question: `${kind} ${n}: discuss ${scenario}, and weigh the key factors involved.`,
    competency: 'historical analysis',
    criteria: [
      `Explains ${scenario} with accurate detail`,
      'Weighs competing factors and evidence',
    ],
    sourceBasis: 'model_general_knowledge',
  };
}

function localModel(): ModelDescriptor {
  return {
    providerId: 'mock',
    id: 'mock-static',
    displayName: 'mock-static',
    locality: 'local',
    installed: true,
    sizeBytes: null,
    parameterSize: null,
    quantization: null,
    contextLength: null,
    capabilities: {
      text: 'supported',
      streaming: 'supported',
      structuredOutput: 'supported',
      tools: 'unsupported',
    },
  };
}

class FakeInference {
  reviewScore = 80;
  private counter = 0;

  async getSettingsSnapshot(): Promise<InferenceSettingsGetOutput> {
    return {
      settings: {
        mode: 'local_only',
        providerId: 'mock',
        modelId: 'mock-static',
        generationTimeoutMs: null,
        updatedAt: new Date().toISOString(),
      },
      resolvedModel: localModel(),
      warnings: [],
    };
  }

  async generate(request: GenerationRequestInput): Promise<GenerationResult> {
    const task = detectTask(request);
    const base = {
      requestId: request.requestId ?? crypto.randomUUID(),
      providerId: request.providerId,
      modelId: request.modelId,
      toolCalls: [],
      usage: null,
    };
    return {
      ...base,
      status: 'completed',
      output: this.outputFor(task, request),
    };
  }

  private outputFor(task: Task, request: GenerationRequestInput): JsonValue {
    if (task === 'review') {
      const ids = criterionIdsFrom(request);
      return {
        criterionIds: ids,
        scores: ids.map(() => this.reviewScore),
        evidence: ids.map(() => ''),
        rationales: ids.map(() => 'Assessed against the criterion.'),
        strengths: ['Addresses the question'],
        gaps: ['Needs more concrete reasoning'],
        needsMoreEvidence: false,
      };
    }
    if (task === 'coach') {
      return {
        diagnosis: 'The answer lacks justified trade-offs.',
        advice: ['State requirements first.', 'Name two concrete trade-offs.'],
        workedExample: 'A stronger answer weighs reliability against cost.',
        reassessmentFocus: 'Justifying trade-offs',
      };
    }
    const joined = request.messages.map((m) => m.content).join('\n');
    const kind = joined.includes('## Original question')
      ? 'Follow-up'
      : joined.includes('materially different scenario')
        ? 'Reassessment'
        : 'Primary';
    return fakeQuestion(kind, this.counter++);
  }
}

// --- non-whisper STT fake ---------------------------------------------------

class FakeProvider implements TranscriptionProvider {
  readonly id = 'fake-stt';
  constructor(
    private readonly behaviour:
      | { kind: 'text'; text: string }
      | { kind: 'empty' }
      | { kind: 'fail'; code: SttFailureCode },
  ) {}

  async probe(): Promise<ProviderProbe> {
    return {
      providerId: this.id,
      engine: 'fake-engine',
      available: true,
      offline: true,
      engineVersion: 'fake-1.0',
      model: {
        id: 'fake-model',
        displayName: 'Fake model',
        variant: 'tiny',
        multilingual: false,
        bytes: 123,
      },
      reason: null,
      locales: ['auto'],
    };
  }

  async transcribe(
    _source: RecordingSource,
    _options: TranscriptionOptions,
    _signal: AbortSignal,
  ): Promise<TranscriptionOutcome> {
    if (this.behaviour.kind === 'fail') {
      return { status: 'failed', code: this.behaviour.code };
    }
    const text = this.behaviour.kind === 'empty' ? '' : this.behaviour.text;
    return {
      status: 'completed',
      text,
      segments: text ? [{ startMs: 0, endMs: 500, text: text.trim() }] : null,
      languageDetected: 'en',
      engineVersion: 'fake-1.0',
      modelId: 'fake-model',
      durationMs: 5,
    };
  }
}

// --- harness ----------------------------------------------------------------

let workDir: string;
let jsonlPath: string;
let storage: Storage;
let telemetry: TelemetryService;
let recording: RecordingService;
let stt: TranscriptionService;
let dispatcher: Dispatcher;
let fakeInference: FakeInference;
let sttBehaviour: FakeProvider['behaviour'] = { kind: 'text', text: '' };

function buildDispatcher(): Dispatcher {
  recording = new RecordingService({
    repository: new AudioRepository(storage.db),
    fileStore: storage.audioFileStore,
    stagingDir: storage.audioStagingDir,
    telemetry,
  });
  recording.reconcile();
  stt = new TranscriptionService({
    repository: new TranscriptionRepository(storage.db),
    recordings: recording,
    providers: [new FakeProvider(sttBehaviour)],
    defaultProviderId: 'fake-stt',
    telemetry,
    timeoutMs: 5_000,
  });
  const coordinator = new InterviewAudioCoordinator({
    getReadyRecordingId: (id) => {
      try {
        return recording.get(id).id;
      } catch {
        return null;
      }
    },
    getTranscriptRecordingId: (id) => {
      try {
        return stt.getTranscript(id).recordingId;
      } catch {
        return null;
      }
    },
  });

  const identity = {
    getTarget: (): Target | null => null,
    listExperiences: () => [],
  };
  const repository = new InterviewsRepository(storage.db);
  fakeInference = new FakeInference();
  const interviewsService = new InterviewsService({
    repository,
    targets: identity,
    telemetry,
  });
  const questions = new InterviewQuestionService({
    repository,
    identity,
    inference: fakeInference,
    telemetry,
  });
  const reviews = new InterviewReviewService({
    repository,
    identity,
    inference: fakeInference,
    audio: coordinator,
    telemetry,
  });
  const sessions = new InterviewSessionService({
    repository,
    reviews,
    identity,
    inference: fakeInference,
    telemetry,
  });
  const voice = new InterviewVoiceService({
    repository,
    audio: coordinator,
    telemetry,
  });
  return createDispatcher([
    createInterviewsModule(
      interviewsService,
      questions,
      reviews,
      sessions,
      voice,
    ),
    createAudioModule(recording, stt),
  ]);
}

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-ivoice-'));
  jsonlPath = path.join(workDir, 'app.jsonl');
  storage = openStorage(workDir);
  telemetry = new TelemetryService({
    repository: new TelemetryRepository(storage.db),
    logger: new JsonlLogger(jsonlPath),
  });
  sttBehaviour = {
    kind: 'text',
    text: 'spoken draft answer about trade and towns',
  };
  dispatcher = buildDispatcher();
});

afterEach(() => {
  storage.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function send<T = unknown>(
  module: 'interviews' | 'audio',
  action: string,
  payload: unknown,
  active: Dispatcher = dispatcher,
): Promise<ResponseEnvelope<T>> {
  return active.dispatch({
    requestId: crypto.randomUUID(),
    module,
    version: 1,
    action,
    payload,
  }) as Promise<ResponseEnvelope<T>>;
}

function ok<T>(response: ResponseEnvelope<T>): T {
  if (!response.ok) {
    throw new Error(
      `expected ok, got ${response.error.code}: ${response.error.message}`,
    );
  }
  return response.data;
}

function expectError(response: ResponseEnvelope<unknown>, code: string): void {
  expect(response.ok).toBe(false);
  if (!response.ok) {
    expect(response.error.code).toBe(code);
  }
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface ProgressOut {
  phase: string | null;
  operationStatus: 'idle' | 'running' | 'failed' | 'cancelled';
  questionCount: number;
  answeredCount: number;
  reviewedCount: number;
}

async function waitIdle(sessionId: string): Promise<ProgressOut> {
  for (let i = 0; i < 500; i += 1) {
    const p = ok<ProgressOut>(
      await send('interviews', 'sessions.progress', { sessionId }),
    );
    if (p.operationStatus !== 'running') {
      return p;
    }
    await tick();
  }
  throw new Error('operation did not settle');
}

interface AdvanceOut {
  session: { id: string; status: string; phase: string | null };
  currentQuestion: { id: string; roundId: string; question: string } | null;
  phase: string | null;
  progressId: string | null;
}

async function createSession(
  method: 'quick_fire' | 'deep_loop',
  questionCount?: number,
): Promise<string> {
  const payload: Record<string, unknown> = {
    method,
    subject: 'medieval european history',
  };
  if (method === 'quick_fire') {
    payload.questionCount = questionCount ?? 5;
  }
  const data = ok<{ session: { id: string } }>(
    await send('interviews', 'sessions.create', payload),
  );
  return data.session.id;
}

/** Capture a real recording from a synthetic PCM tone; returns its opaque id. */
async function makeRecording(): Promise<string> {
  const begin = ok<{ captureId: string; token: string }>(
    await send('audio', 'capture.begin', {}),
  );
  const samples = 8_000;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    pcm.writeInt16LE(
      Math.round(Math.sin((i / AUDIO_SAMPLE_RATE) * 2 * Math.PI * 440) * 8000),
      i * 2,
    );
  }
  let seq = 0;
  for (let off = 0; off < pcm.length; off += AUDIO_MAX_CHUNK_BYTES) {
    ok(
      await send('audio', 'capture.append', {
        captureId: begin.captureId,
        token: begin.token,
        sequence: seq,
        chunk: pcm
          .subarray(off, off + AUDIO_MAX_CHUNK_BYTES)
          .toString('base64'),
      }),
    );
    seq += 1;
  }
  const done = ok<{ recording: { id: string } }>(
    await send('audio', 'capture.complete', {
      captureId: begin.captureId,
      token: begin.token,
    }),
  );
  return done.recording.id;
}

/** Record + transcribe; returns the recording id and the original transcript. */
async function recordAndTranscribe(): Promise<{
  recordingId: string;
  transcriptId: string;
  transcriptText: string;
}> {
  const recordingId = await makeRecording();
  const started = ok<{ job: { id: string } }>(
    await send('audio', 'stt.jobs.start', { recordingId }),
  );
  await stt.whenSettled(started.job.id);
  const job = ok<{ job: { status: string; transcriptId: string | null } }>(
    await send('audio', 'stt.jobs.get', { jobId: started.job.id }),
  );
  expect(job.job.status).toBe('succeeded');
  const transcriptId = job.job.transcriptId as string;
  const transcript = ok<{ transcript: { text: string } }>(
    await send('audio', 'stt.transcripts.get', { transcriptId }),
  );
  return {
    recordingId,
    transcriptId,
    transcriptText: transcript.transcript.text,
  };
}

// --- tests ------------------------------------------------------------------

describe('Stage 008.3 — spoken interview answers', () => {
  it('quick-fire (5) with mixed voice/text answers reviews privately as answers arrive', async () => {
    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);

    for (let i = 0; i < 5; i += 1) {
      const adv = ok<AdvanceOut>(
        await send('interviews', 'sessions.advance', { sessionId }),
      );
      const q = adv.currentQuestion;
      expect(q).not.toBeNull();
      const questionId = (q as NonNullable<AdvanceOut['currentQuestion']>).id;

      if (i % 2 === 0) {
        // Voice answer: record, transcribe, edit, submit the edited text.
        const { recordingId, transcriptId } = await recordAndTranscribe();
        const edited = `Edited voice answer ${i} weighing concrete trade-offs and evidence.`;
        ok(
          await send('interviews', 'answers.submit', {
            sessionId,
            questionId,
            answerText: edited,
            audio: { recordingId, transcriptId },
          }),
        );
        // The committed answer carries the edited text, not the raw transcript.
        const audio = ok<{
          audio: { recordingId: string; transcriptId: string | null } | null;
        }>(
          await send('interviews', 'answers.audio.get', {
            sessionId,
            questionId,
          }),
        );
        expect(audio.audio?.recordingId).toBe(recordingId);
        expect(audio.audio?.transcriptId).toBe(transcriptId);
      } else {
        ok(
          await send('interviews', 'answers.submit', {
            sessionId,
            questionId,
            answerText: `Typed answer ${i} with reasoning and trade-offs discussed.`,
          }),
        );
      }
    }

    const progress = await waitIdle(sessionId);
    expect(progress.answeredCount).toBe(5);
    expect(progress.reviewedCount).toBe(5);

    const tx = ok<{ items: Array<{ type: string; text: string | null }> }>(
      await send('interviews', 'sessions.transcript', { sessionId }),
    );
    const answerTurns = tx.items.filter((t) => t.type === 'answer');
    expect(tx.items.some((turn) => turn.type === 'review')).toBe(false);
    expect(answerTurns).toHaveLength(5);
    // The transcript shows the submitted (edited) text, never the raw STT text.
    expect(
      answerTurns.some((t) => t.text?.startsWith('Edited voice answer 0')),
    ).toBe(true);
  });

  it('quick-fire (10) completes entirely by voice', async () => {
    const sessionId = await createSession('quick_fire', 10);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    for (let i = 0; i < 10; i += 1) {
      const adv = ok<AdvanceOut>(
        await send('interviews', 'sessions.advance', { sessionId }),
      );
      const questionId = (
        adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
      ).id;
      const { recordingId, transcriptId } = await recordAndTranscribe();
      ok(
        await send('interviews', 'answers.submit', {
          sessionId,
          questionId,
          answerText: `Voice answer ${i} with concrete, evidenced reasoning throughout.`,
          audio: { recordingId, transcriptId },
        }),
      );
    }
    const progress = await waitIdle(sessionId);
    expect(progress.answeredCount).toBe(10);
    expect(progress.reviewedCount).toBe(10);
  });

  it('deep loop: voice primary + follow-up, review, coaching + reassessment', async () => {
    fakeInference.reviewScore = 10; // force a fail so coaching/reassessment unlock
    const sessionId = await createSession('deep_loop');

    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const first = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const primaryId = (
      first.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;
    const primaryRound = (
      first.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).roundId;

    const primary = await recordAndTranscribe();
    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId: primaryId,
        answerText:
          'Spoken primary answer, later edited for clarity and trade-offs.',
        audio: {
          recordingId: primary.recordingId,
          transcriptId: primary.transcriptId,
        },
      }),
    );

    // Follow-up question, answered by voice as well.
    ok(await send('interviews', 'sessions.advance', { sessionId }));
    await waitIdle(sessionId);
    const followAdv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const followId = (
      followAdv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;
    expect(followId).not.toBe(primaryId);
    const follow = await recordAndTranscribe();
    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId: followId,
        answerText: 'Spoken follow-up answer with additional concrete detail.',
        audio: {
          recordingId: follow.recordingId,
          transcriptId: follow.transcriptId,
        },
      }),
    );

    // Ready for review.
    const ready = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    expect(ready.phase).toBe('awaiting_review');
    const reviewed = ok<{ review: { decision: string } }>(
      await send('interviews', 'reviews.run', {
        sessionId,
        roundId: primaryRound,
      }),
    );
    expect(reviewed.review.decision).toBe('fail');

    // Coaching then a linked reassessment question.
    ok(
      await send('interviews', 'coaching.run', {
        sessionId,
        roundId: primaryRound,
      }),
    );
    const reassess = ok<{ roundId: string }>(
      await send('interviews', 'reassessment.generate', {
        sessionId,
        failedRoundId: primaryRound,
      }),
    );
    expect(reassess.roundId).not.toBe(primaryRound);

    // Both committed voice answers remain linked to the right questions.
    const primaryAudio = ok<{ audio: { recordingId: string } | null }>(
      await send('interviews', 'answers.audio.get', {
        sessionId,
        questionId: primaryId,
      }),
    );
    expect(primaryAudio.audio?.recordingId).toBe(primary.recordingId);
    const followAudio = ok<{ audio: { recordingId: string } | null }>(
      await send('interviews', 'answers.audio.get', {
        sessionId,
        questionId: followId,
      }),
    );
    expect(followAudio.audio?.recordingId).toBe(follow.recordingId);
  });

  it('empty/failed transcription falls back to a typed answer, keeping the saved recording', async () => {
    sttBehaviour = { kind: 'empty' };
    dispatcher = buildDispatcher();

    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;

    // Recording succeeds; transcription produces no text.
    const recordingId = await makeRecording();
    const started = ok<{ job: { id: string } }>(
      await send('audio', 'stt.jobs.start', { recordingId }),
    );
    await stt.whenSettled(started.job.id);
    const job = ok<{ job: { status: string; transcriptId: string | null } }>(
      await send('audio', 'stt.jobs.get', { jobId: started.job.id }),
    );
    // An empty transcript is a completed, retryable result — the user types.
    expect(job.job.status).toBe('succeeded');

    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText:
          'Typed because speech was unclear, still linking the recording.',
        audio: { recordingId },
      }),
    );
    // The recording is retained and still replayable.
    const open = ok<{ token: string }>(
      await send('audio', 'playback.open', { id: recordingId }),
    );
    ok(
      await send('audio', 'playback.close', {
        id: recordingId,
        token: open.token,
      }),
    );
  });

  it('saves and recovers a crash-safe voice draft, then clears it on submit', async () => {
    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;

    const recordingId = await makeRecording();
    ok(
      await send('interviews', 'answers.draft.save', {
        sessionId,
        questionId,
        recordingId,
        draftText: 'Half-written spoken answer in progress.',
      }),
    );

    // Simulate relaunch with a fresh dispatcher over the same storage.
    dispatcher = buildDispatcher();
    const restored = ok<{
      draft: { recordingId: string | null; draftText: string | null } | null;
    }>(
      await send('interviews', 'answers.draft.get', { sessionId, questionId }),
    );
    expect(restored.draft?.recordingId).toBe(recordingId);
    expect(restored.draft?.draftText).toBe(
      'Half-written spoken answer in progress.',
    );
    // The saved recording still replays after restart.
    const open = ok<{ token: string }>(
      await send('audio', 'playback.open', { id: recordingId }),
    );
    ok(
      await send('audio', 'playback.close', {
        id: recordingId,
        token: open.token,
      }),
    );

    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: 'Final edited spoken answer with trade-offs and evidence.',
        audio: { recordingId },
      }),
    );
    // The draft is consumed by the commit.
    const afterSubmit = ok<{ draft: unknown | null }>(
      await send('interviews', 'answers.draft.get', { sessionId, questionId }),
    );
    expect(afterSubmit.draft).toBeNull();
  });

  it('is idempotent against a double submit (no second answer, no second link)', async () => {
    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;
    const { recordingId, transcriptId } = await recordAndTranscribe();

    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: 'The one and only committed spoken answer with reasoning.',
        audio: { recordingId, transcriptId },
      }),
    );
    expectError(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: 'A racing duplicate that must be rejected.',
        audio: { recordingId, transcriptId },
      }),
      'CONFLICT',
    );

    const audioRows = storage.db
      .prepare(
        'SELECT COUNT(*) AS n FROM interview_answer_audio WHERE question_id = ?',
      )
      .get(questionId) as { n: number };
    expect(audioRows.n).toBe(1);
    const answerRows = storage.db
      .prepare(
        'SELECT COUNT(*) AS n FROM interview_answers WHERE question_id = ?',
      )
      .get(questionId) as { n: number };
    expect(answerRows.n).toBe(1);
  });

  it('fails closed on forged, cross-session and mismatched audio/transcript ids', async () => {
    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;

    // A fabricated recording id is rejected and commits nothing.
    expectError(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: 'Trying to attach a recording that does not exist here.',
        audio: { recordingId: crypto.randomUUID() },
      }),
      'NOT_FOUND',
    );

    // A real recording but a transcript that belongs to a different recording.
    const a = await recordAndTranscribe();
    const b = await recordAndTranscribe();
    expectError(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: 'Mismatched transcript must not bind to another recording.',
        audio: { recordingId: a.recordingId, transcriptId: b.transcriptId },
      }),
      'INVALID_INPUT',
    );

    // A forged transcript id is rejected.
    expectError(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: 'Forged transcript id must be rejected before committing.',
        audio: {
          recordingId: a.recordingId,
          transcriptId: crypto.randomUUID(),
        },
      }),
      'NOT_FOUND',
    );

    // No answer was committed by any of the rejected attempts.
    const answerRows = storage.db
      .prepare(
        'SELECT COUNT(*) AS n FROM interview_answers WHERE question_id = ?',
      )
      .get(questionId) as { n: number };
    expect(answerRows.n).toBe(0);

    // Draft save also fails closed on a forged recording id.
    expectError(
      await send('interviews', 'answers.draft.save', {
        sessionId,
        questionId,
        recordingId: crypto.randomUUID(),
      }),
      'NOT_FOUND',
    );
  });

  it('rejects a draft/audio read for a question from another session', async () => {
    const sessionA = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId: sessionA }));
    await waitIdle(sessionA);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId: sessionA }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;

    const sessionB = await createSession('quick_fire', 5);
    // The question belongs to session A, not B.
    expectError(
      await send('interviews', 'answers.draft.get', {
        sessionId: sessionB,
        questionId,
      }),
      'NOT_FOUND',
    );
  });

  it('the immutable raw transcript is preserved and distinct from the edited answer', async () => {
    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;

    const { recordingId, transcriptId, transcriptText } =
      await recordAndTranscribe();
    const edited =
      'A deliberately edited answer that differs from the transcript.';
    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: edited,
        audio: { recordingId, transcriptId },
      }),
    );

    // The source transcript is untouched by the edit.
    const transcript = ok<{ transcript: { text: string } }>(
      await send('audio', 'stt.transcripts.get', { transcriptId }),
    );
    expect(transcript.transcript.text).toBe(transcriptText);
    expect(transcript.transcript.text).not.toBe(edited);

    // The stored answer text equals the edited text.
    const answer = storage.db
      .prepare(
        'SELECT answer_text FROM interview_answers WHERE question_id = ?',
      )
      .get(questionId) as { answer_text: string };
    expect(answer.answer_text).toBe(edited);
  });

  it('typed-only answers still work with no audio wired at all', async () => {
    // A review service with no audio coordinator still commits typed answers.
    const repository = new InterviewsRepository(storage.db);
    const identity = {
      getTarget: (): Target | null => null,
      listExperiences: () => [],
    };
    const reviews = new InterviewReviewService({
      repository,
      identity,
      inference: fakeInference,
    });
    const sessions = new InterviewSessionService({
      repository,
      reviews,
      identity,
      inference: fakeInference,
    });
    const voice = new InterviewVoiceService({ repository });
    const svc = new InterviewsService({ repository, targets: identity });
    const questions = new InterviewQuestionService({
      repository,
      identity,
      inference: fakeInference,
    });
    const textOnly = createDispatcher([
      createInterviewsModule(svc, questions, reviews, sessions, voice),
    ]);

    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }, textOnly));
    await waitIdleOn(sessionId, textOnly);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }, textOnly),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;
    ok(
      await send(
        'interviews',
        'answers.submit',
        {
          sessionId,
          questionId,
          answerText:
            'A typed answer in a build without the audio coordinator.',
        },
        textOnly,
      ),
    );
    // Attaching audio in a build without a coordinator fails closed.
    const adv2 = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }, textOnly),
    );
    const q2 = (
      adv2.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;
    expectError(
      await send(
        'interviews',
        'answers.submit',
        {
          sessionId,
          questionId: q2,
          answerText:
            'This one tries to attach audio with no coordinator present.',
          audio: { recordingId: crypto.randomUUID() },
        },
        textOnly,
      ),
      'INVALID_INPUT',
    );
  });

  it('keeps audio bytes, transcript and edited answer out of telemetry and logs', async () => {
    const sessionId = await createSession('quick_fire', 5);
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const adv = ok<AdvanceOut>(
      await send('interviews', 'sessions.advance', { sessionId }),
    );
    const questionId = (
      adv.currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
    ).id;

    const canary = 'CANARY-PRIVATE-SPOKEN-PHRASE-9e1f';
    sttBehaviour = { kind: 'text', text: canary };
    dispatcher = buildDispatcher();
    const { recordingId, transcriptId } = await recordAndTranscribe();
    const editedCanary =
      'CANARY-EDITED-ANSWER-7b2a differs from the transcript.';
    ok(
      await send('interviews', 'answers.submit', {
        sessionId,
        questionId,
        answerText: editedCanary,
        audio: { recordingId, transcriptId },
      }),
    );
    ok(
      await send('interviews', 'answers.draft.save', {
        sessionId,
        questionId: (
          ok<AdvanceOut>(
            await send('interviews', 'sessions.advance', { sessionId }),
          ).currentQuestion as NonNullable<AdvanceOut['currentQuestion']>
        ).id,
        recordingId,
        draftText: editedCanary,
      }),
    );

    const runs = storage.db
      .prepare('SELECT detail_json FROM operation_runs')
      .all() as Array<{ detail_json: string | null }>;
    const telemetryDump = runs.map((r) => r.detail_json ?? '').join('\n');
    expect(telemetryDump).not.toContain(canary);
    expect(telemetryDump).not.toContain(editedCanary);

    const log = fs.existsSync(jsonlPath)
      ? fs.readFileSync(jsonlPath, 'utf8')
      : '';
    expect(log).not.toContain(canary);
    expect(log).not.toContain(editedCanary);
  });

  it('migration keeps foreign keys and invariants intact', () => {
    expect(storage.db.pragma('integrity_check', { simple: true })).toBe('ok');
    expect(storage.db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
  });
});

async function waitIdleOn(
  sessionId: string,
  active: Dispatcher,
): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    const p = ok<ProgressOut>(
      await send('interviews', 'sessions.progress', { sessionId }, active),
    );
    if (p.operationStatus !== 'running') {
      return;
    }
    await tick();
  }
  throw new Error('operation did not settle');
}

describe('Stage 06.4 — Deep Loop workflow with voice answers', () => {
  interface WorkflowSnapshot {
    currentQuestion: { id: string; roundId: string } | null;
    availableActions: string[];
    feedback: {
      review: { decision: string } | null;
      coaching: unknown;
    } | null;
  }

  async function snapshot(sessionId: string): Promise<WorkflowSnapshot> {
    return ok<{ state: WorkflowSnapshot }>(
      await send('interviews', 'workflow.state.get', { sessionId }),
    ).state;
  }

  async function choose(sessionId: string, action: string): Promise<void> {
    ok(await send('interviews', 'workflow.continue', { sessionId, action }));
    await waitIdle(sessionId);
  }

  it('keeps recorded answers and a crash-safe follow-up draft through intent-only orchestration', async () => {
    const sessionId = await createSession('deep_loop');
    ok(await send('interviews', 'sessions.start', { sessionId }));
    await waitIdle(sessionId);
    const primaryId = (await snapshot(sessionId)).currentQuestion!.id;
    const primary = await recordAndTranscribe();
    ok(
      await send('interviews', 'workflow.answer.submit', {
        sessionId,
        questionId: primaryId,
        answerText: 'Spoken primary answer, edited for clarity.',
        audio: {
          recordingId: primary.recordingId,
          transcriptId: primary.transcriptId,
        },
      }),
    );
    await waitIdle(sessionId);
    const followId = (await snapshot(sessionId)).currentQuestion!.id;
    expect(followId).not.toBe(primaryId);

    const followRecording = await makeRecording();
    ok(
      await send('interviews', 'answers.draft.save', {
        sessionId,
        questionId: followId,
        recordingId: followRecording,
        draftText: 'Half-finished spoken follow-up.',
      }),
    );

    // Relaunch: the draft and the pending follow-up both survive.
    dispatcher = buildDispatcher();
    fakeInference.reviewScore = 40;
    const restored = ok<{ draft: { recordingId: string | null } | null }>(
      await send('interviews', 'answers.draft.get', {
        sessionId,
        questionId: followId,
      }),
    );
    expect(restored.draft?.recordingId).toBe(followRecording);
    const resumed = await snapshot(sessionId);
    expect(resumed.currentQuestion?.id).toBe(followId);
    expect(resumed.availableActions).toEqual(['answer', 'abandon']);

    ok(
      await send('interviews', 'workflow.answer.submit', {
        sessionId,
        questionId: followId,
        answerText: 'Final spoken follow-up with a concrete outcome.',
        audio: { recordingId: followRecording },
      }),
    );
    await waitIdle(sessionId);
    expect((await snapshot(sessionId)).feedback?.review?.decision).toBe('fail');
    expect(
      ok<{ draft: unknown }>(
        await send('interviews', 'answers.draft.get', {
          sessionId,
          questionId: followId,
        }),
      ).draft,
    ).toBeNull();

    await choose(sessionId, 'request_coaching');
    await choose(sessionId, 'request_reassessment');
    const reassessment = await snapshot(sessionId);
    expect(reassessment.currentQuestion?.id).not.toBe(primaryId);

    // Later model work never re-links or rewrites the committed audio answers.
    for (const [questionId, recordingId] of [
      [primaryId, primary.recordingId],
      [followId, followRecording],
    ]) {
      const linked = ok<{ audio: { recordingId: string } | null }>(
        await send('interviews', 'answers.audio.get', {
          sessionId,
          questionId,
        }),
      );
      expect(linked.audio?.recordingId).toBe(recordingId);
    }
  });
});

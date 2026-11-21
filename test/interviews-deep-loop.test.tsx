// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  InsightsDetail,
  InterviewWorkflowAction,
  InterviewWorkflowState,
} from '../src/shared/contracts';
import { SessionOutlet } from '../src/renderer/pages/interviews/session/SessionOutlet';
import { STT_POLL_MS } from '../src/renderer/pages/interviews/answer/voiceAnswer';
import { SESSION_POLL_MS } from '../src/renderer/pages/interviews/session/useSessionWorkflow';
import { FakeMedia } from './fixtures/fake-microphone';

const id = (n: number) =>
  `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const NOW = '2026-11-12T10:00:00.000Z';
const sessionId = id(1);
const question = (n: number) => ({
  id: id(10 + n),
  roundId: id(20 + n),
  question: `Saved question ${n}`,
  competency: 'Communication',
  createdAt: NOW,
  rubricSummary: null,
  provenance: {
    origin: 'generated' as const,
    providerId: 'mock',
    modelId: 'mock-interview',
    promptVersion: 'iq-v2',
    sourceBasis: 'model_general_knowledge' as const,
    validation: 'passed' as const,
    generatedAt: NOW,
  },
});

class FakeDeepLoop {
  questions = [question(1)];
  answers: (string | null)[] = [null];
  reviews: ('pass' | 'fail' | 'unscored' | null)[] = [null];
  coached = false;
  reassessing = false;
  operation: string | null = null;
  failure: 'failed' | 'cancelled' | null = null;
  paused = false;
  completed = false;
  requests = 0;
  commands: string[] = [];
  recommendation: string | null = null;

  state(): InterviewWorkflowState {
    const index = this.questions.length - 1;
    const reviewed = this.reviews[index] !== null;
    const actions: InterviewWorkflowAction[] = [];
    if (!this.completed) {
      if (this.paused) actions.push('continue');
      else if (this.failure) {
        actions.push('retry');
        if (this.operation === 'follow_up') actions.push('continue');
      } else if (this.operation === null) {
        if (this.answers[index] === null) actions.push('answer');
        else if (reviewed) {
          if (this.reviews[index] === 'fail' && !this.coached)
            actions.push('request_coaching');
          if (this.coached && !this.reassessing)
            actions.push('request_reassessment');
          if (!this.reassessing) actions.push('continue');
          actions.push('request_results');
        }
      }
      if (!this.paused && this.operation && !this.failure)
        actions.push('pause');
      actions.push('abandon');
    }
    const session: InterviewWorkflowState['session'] = {
      id: sessionId,
      method: 'deep_loop',
      subject: 'Communication',
      careerTargetId: null,
      targetSnapshot: null,
      questionCount: null,
      additionalGuidance: null,
      status: this.completed ? 'completed' : 'active',
      phase: this.completed
        ? 'completed'
        : this.paused
          ? 'paused'
          : 'answering',
      barSnapshot: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: this.completed ? NOW : null,
    };
    const result: InterviewWorkflowState['result'] = this.completed
      ? {
          method: 'deep_loop',
          subject: session.subject,
          totalRounds: this.questions.length,
          answeredCount: this.answers.filter(Boolean).length,
          reviewedCount: this.reviews.filter(Boolean).length,
          passCount: this.reviews.filter((r) => r === 'pass').length,
          failCount: this.reviews.filter((r) => r === 'fail').length,
          unscoredCount: this.reviews.filter((r) => r === 'unscored').length,
          averageScore: this.reviews.some((r) => r === 'pass') ? 80 : null,
          complete: true,
          recommendation: this.recommendation,
          rounds: this.questions.map((q, i) => ({
            roundId: q.roundId,
            ordinal: i + 1,
            competency: q.competency,
            decision: this.reviews[i]!,
            score: this.reviews[i] === 'pass' ? 80 : null,
            isReassessment: this.reassessing && i === index,
          })),
        }
      : null;
    return {
      session,
      currentQuestion:
        this.answers[index] === null ? this.questions[index] : null,
      progress: {
        phase: session.phase!,
        operationStatus: this.failure ?? (this.operation ? 'running' : 'idle'),
        progressText: null,
        operation: this.operation,
        errorMessage: this.failure ? 'Local model unavailable' : null,
        questionCount: this.questions.length,
        answeredCount: this.answers.filter((a) => a !== null).length,
        reviewedCount: this.reviews.filter(Boolean).length,
        canSubmit: actions.includes('answer'),
        canRetry: actions.includes('retry'),
      },
      operationId:
        this.operation && !this.failure && !this.paused ? id(90) : null,
      availableActions: actions,
      feedback: null,
      result,
      deepLoop: {
        roundId: this.questions[index].roundId,
        isReassessment: this.reassessing,
        followUpLimit: this.reassessing ? 0 : 1,
        followUpsAsked: index === 1 && !this.reassessing ? 1 : 0,
        reassessmentDepth: this.reassessing ? 2 : 0,
        reassessmentCap: 2,
        recommendation: this.recommendation,
      },
    };
  }

  detail(): InsightsDetail {
    return {
      session: this.state().session,
      bar: null,
      rounds: this.questions.map((q, i) => ({
        id: q.roundId,
        ordinal: i + 1,
        reassessmentOfRoundId:
          this.reassessing && i === 1 ? this.questions[0].roundId : null,
        questions: [
          {
            id: q.id,
            kind: i === 1 && !this.reassessing ? 'follow_up' : 'primary',
            question: q.question,
            competency: q.competency,
            createdAt: NOW,
            answer: this.answers[i],
          },
        ],
        review: this.reviews[i]
          ? {
              id: id(40 + i),
              roundId: q.roundId,
              decision: this.reviews[i],
              score: this.reviews[i] === 'pass' ? 80 : null,
              provisional: true,
              barKind: 'practice_benchmark',
              passThreshold: 70,
              criteria: [],
              strengths: [],
              gaps: [],
              needsMoreEvidence: false,
              unscoredReason: null,
              modelProvenance: {
                providerId: 'mock',
                modelId: 'mock-interview',
                promptVersion: 'ir-v1',
                validation: 'passed',
                generatedAt: NOW,
              },
              createdAt: NOW,
            }
          : null,
        coaching:
          i === 0 && this.coached
            ? {
                id: id(50),
                roundId: q.roundId,
                diagnosis: 'Practice a clearer example',
                advice: ['Use one concrete outcome'],
                workedExample: null,
                reassessmentFocus: 'Clarity',
                modelProvenance: {
                  providerId: 'mock',
                  modelId: 'mock-interview',
                  promptVersion: 'ic-v1',
                  validation: 'passed',
                  generatedAt: NOW,
                },
                createdAt: NOW,
              }
            : null,
      })),
    };
  }

  command(action: string, payload: Record<string, unknown>) {
    this.commands.push(action);
    if (action === 'workflow.answer.submit') {
      const index = this.questions.length - 1;
      if (this.answers[index] !== null) throw new Error('duplicate answer');
      this.answers[index] = payload.answerText as string;
      this.operation = index === 0 ? 'follow_up' : 'reviewing';
    } else if (action === 'workflow.continue') {
      const intent = payload.action;
      if (intent === 'request_coaching') {
        this.coached = true;
        this.operation = 'coaching';
      }
      if (intent === 'request_reassessment') {
        this.reassessing = true;
        this.questions.push(question(3));
        this.answers.push(null);
        this.reviews.push(null);
        this.operation = 'reassessing';
      }
      if (intent === 'retry') this.failure = null;
      if (intent === 'continue') {
        if (this.paused) {
          this.paused = false;
        } else if (this.failure) {
          this.failure = null;
          this.operation = 'reviewing';
        } else {
          this.questions.push(question(2));
          this.answers.push(null);
          this.reviews.push(null);
          this.operation = 'next_question';
        }
      }
    } else if (action === 'workflow.pause') {
      this.paused = true;
      this.operation = null;
    } else if (action === 'workflow.results.request') {
      this.requests++;
      this.completed = true;
      this.operation = null;
    } else if (action === 'sessions.finish') {
      this.completed = true;
      this.operation = null;
    }
    return { state: this.state() };
  }
}

let fake: FakeDeepLoop;
let backend: ReturnType<typeof vi.fn>;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let media: FakeMedia;
type Call = { action: string; payload: Record<string, unknown> };
const query = (name: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${name}"]`);
const settle = async () => {
  await act(async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  });
};
const click = async (name: string) => {
  expect(query(name)).not.toBeNull();
  await act(async () => query(name)!.click());
  await settle();
};
const poll = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SESSION_POLL_MS);
  });
  await settle();
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  fake = new FakeDeepLoop();
  media = new FakeMedia();
  media.install();
  backend = vi.fn(async (input: Call) => ({ ok: true, data: respond(input) }));
  vi.stubGlobal('career', { request: backend });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

function respond({ action, payload }: Call): unknown {
  if (action === 'workflow.state.get') return { state: fake.state() };
  if (action === 'insights.sessions.get') return fake.detail();
  if (action === 'answers.draft.get') return { draft: null };
  if (action === 'answers.draft.save')
    return { draft: { ...payload, updatedAt: NOW } };
  if (action === 'answers.draft.clear') return { cleared: true };

  switch (action) {
    case 'capture.begin':
      return {
        captureId: id(73),
        token: 'capture-token-0123456789',
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        maxChunkBytes: 32768,
        maxDurationMs: 300000,
        maxBytes: 9600000,
      };
    case 'capture.append':
      return { receivedBytes: 1 };
    case 'capture.complete':
      return {
        recording: {
          id: id(70),
          mediaType: 'audio/wav',
          codec: 'pcm_s16le',
          sampleRate: 16000,
          channels: 1,
          sizeBytes: 64000,
          durationMs: 2000,
          label: 'Interview answer',
          createdAt: NOW,
        },
      };
    case 'stt.jobs.start':
    case 'stt.jobs.get': {
      const succeeded = action === 'stt.jobs.get';
      return {
        job: {
          id: id(72),
          recordingId: id(70),
          providerId: 'whisper',
          engineVersion: '1.7',
          modelId: 'base',
          locale: 'en',
          status: succeeded ? 'succeeded' : 'queued',
          errorCode: null,
          transcriptId: succeeded ? id(71) : null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      };
    }
    case 'stt.transcripts.get':
      return {
        transcript: {
          id: id(71),
          jobId: id(72),
          recordingId: id(70),
          providerId: 'whisper',
          engineVersion: '1.7',
          modelId: 'base',
          locale: 'en',
          text: 'Spoken draft',
          empty: false,
          segments: null,
          createdAt: NOW,
        },
      };
    default:
      return fake.command(action, payload);
  }
}
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () =>
    root.render(
      <SessionOutlet sessionId={sessionId} onOpenLocalAi={vi.fn()} />,
    ),
  );
  await settle();
}
async function answer(text: string) {
  const textarea = query('interview-composer-input') as HTMLTextAreaElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await click('interview-composer-submit');
}
const actions = () =>
  backend.mock.calls.map(([call]) => (call as { action: string }).action);

describe('Deep Loop session', () => {
  it('keeps speech editable and submits its owned audio link only after confirmation', async () => {
    await mount();
    await click('interview-voice-record');
    expect(query('interview-recording')?.textContent).toContain('Recording');
    await act(async () => media.emit(0.4));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    await click('interview-recording-stop');
    expect(media.track.stop).toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STT_POLL_MS);
    });
    await settle();
    expect(
      (query('interview-composer-input') as HTMLTextAreaElement).value,
    ).toBe('Spoken draft');
    expect(actions()).not.toContain('workflow.answer.submit');
    const textarea = query('interview-composer-input') as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(textarea, 'Edited spoken draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('interview-composer-submit');
    const submitted = backend.mock.calls.find(
      ([call]) =>
        (call as { action: string }).action === 'workflow.answer.submit',
    )![0] as { payload: Record<string, unknown> };
    expect(submitted.payload).toMatchObject({
      answerText: 'Edited spoken draft',
      audio: { recordingId: id(70), transcriptId: id(71) },
    });
    expect(actions()).not.toContain('sessions.cancelOperation');
  });

  it('restores saved conversation, waits for follow-up, reviews and publishes only on request', async () => {
    await mount();
    expect(query('session-question')?.textContent).toContain(
      'Saved question 1',
    );
    await answer('My first long answer');
    expect(query('deep-loop-conversation')?.textContent).toContain(
      'My first long answer',
    );
    expect(query('session-work-status')?.textContent).toContain('follow-up');
    fake.questions.push(question(2));
    fake.answers.push(null);
    fake.reviews.push(null);
    fake.operation = null;
    await poll();
    expect(query('session-question')?.textContent).toContain(
      'Saved question 2',
    );
    await answer('Clarifying the example');
    fake.operation = null;
    fake.reviews[1] = 'unscored';
    await poll();
    expect(container.textContent).toContain('Unscored');
    expect(container.textContent).not.toContain('Score 0 / 100');
    expect(actions()).not.toContain('reviews.run');
    await click('deep-loop-actions-request_results');
    expect(fake.requests).toBe(1);
    expect(query('interview-result-summary')?.textContent).toContain(
      'Unscored',
    );
    await act(async () => root.unmount());
    root = createRoot(container);
    await mount();
    expect(container.textContent).toContain('My first long answer');
    expect(fake.requests).toBe(1);
  });

  it('offers explicit coaching and linked reassessment, honors the cap, pauses and skips a failed follow-up', async () => {
    await mount();
    await answer('First answer');
    fake.failure = 'failed';
    await poll();
    expect(query('deep-loop-actions-continue')?.textContent).toContain(
      'Skip follow-up',
    );
    await click('deep-loop-actions-continue');
    expect(fake.operation).toBe('reviewing');
    fake.operation = null;
    fake.reviews[0] = 'fail';
    await poll();
    expect(query('deep-loop-actions-request_coaching')).not.toBeNull();
    await click('deep-loop-actions-request_coaching');
    fake.operation = null;
    await poll();
    expect(container.textContent).toContain('Practice a clearer example');
    await click('deep-loop-actions-request_reassessment');
    fake.operation = null;
    await poll();
    expect(container.textContent).toContain('linked to an earlier round');
    fake.recommendation = 'Spend some time practising before another round.';
    await answer('Second attempt');
    await click('deep-loop-actions-pause');
    expect(query('session-paused')).not.toBeNull();
    expect(
      container.querySelectorAll('[data-testid="session-summary"]'),
    ).toHaveLength(1);
    expect(query('deep-loop-conversation')?.textContent).toContain(
      'First answer',
    );
    const before = actions().filter(
      (action) => action === 'workflow.continue',
    ).length;
    await poll();
    expect(
      actions().filter((action) => action === 'workflow.continue'),
    ).toHaveLength(before);
    await click('deep-loop-actions-continue');
    expect(fake.questions).toHaveLength(2);
    expect(query('deep-loop-conversation')?.textContent).toContain(
      'First answer',
    );
    fake.operation = null;
    fake.reviews[1] = 'fail';
    await poll();
    expect(container.textContent).toContain(fake.recommendation);
    expect(query('deep-loop-actions-continue')).toBeNull();
    expect(query('deep-loop-actions-request_reassessment')).toBeNull();
    expect(actions()).not.toContain('sessions.advance');
    expect(actions()).not.toContain('coaching.run');
    expect(actions()).not.toContain('reassessment.generate');
  });
});

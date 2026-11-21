import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InterviewAnswerAudioLink,
  InterviewWorkflowState,
} from '../../../../shared/contracts';
import {
  ApiError,
  cancelInterviewOperation,
  continueInterviewWorkflow,
  finishInterviewSession,
  getInterviewWorkflowState,
  pauseInterviewWorkflow,
  requestInterviewResults,
  submitInterviewWorkflowAnswer,
} from '../../../api';
import { shouldPoll } from './sessionView';

/** Read cadence while the snapshot reports running work (`operationId`). */
export const SESSION_POLL_MS = 1200;

/** Onward intents carried by `workflow.continue`. */
export type SessionIntent =
  | 'continue'
  | 'retry'
  | 'request_coaching'
  | 'request_reassessment';

/** Every user command the controller can send; one runs at a time. */
export type SessionCommand =
  | SessionIntent
  | 'answer'
  | 'pause'
  | 'request_results'
  | 'cancel_operation'
  | 'abandon';

export type WorkflowLoad =
  | { status: 'loading' }
  | { status: 'ready'; state: InterviewWorkflowState }
  | { status: 'error'; message: string };

export interface AnswerSubmission {
  questionId: string;
  answerText: string;
  audio?: InterviewAnswerAudioLink;
}

function errorMessage(error: unknown) {
  return error instanceof ApiError
    ? error.message
    : 'The interview couldn’t be loaded. Please try again.';
}

/**
 * Session controller shared by both runners: an API facade plus the in-flight
 * request and passive poll lifecycle. It is not a second workflow state
 * machine; the backend snapshot and its `availableActions` stay authoritative.
 *
 * - `workflow.state.get` is read on entry and re-read every `SESSION_POLL_MS`
 *   only while `operationId` is set. Reads never start work, and are skipped
 *   while a command is in flight so they cannot overwrite its result.
 * - Commands are only sent when advertised (cancelling an operation needs a
 *   running `operationId`). A second command while one runs is ignored.
 * - Only the newest response for the current `sessionId` is applied, so a slow
 *   reply for a previous session or an older read can never win.
 * - `pause` is durable, `cancel_operation` stops one model operation, and
 *   `abandon` is terminal. Leaving the view sends nothing.
 */
export function useSessionWorkflow(
  sessionId: string,
  initialState?: InterviewWorkflowState,
) {
  const [load, setLoad] = useState<WorkflowLoad>(
    initialState?.session.id === sessionId
      ? { status: 'ready', state: initialState }
      : { status: 'loading' },
  );
  const [pending, setPending] = useState<SessionCommand | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const mounted = useRef(true);
  const inFlight = useRef(false);
  // Only the newest read or command result may replace the snapshot.
  const sequence = useRef(0);
  const currentSession = useRef(sessionId);
  const loadedSession = useRef(
    load.status === 'loading' ? null : (sessionId as string | null),
  );

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const isCurrent = useCallback(
    (request: number, requestedSession: string) =>
      mounted.current &&
      request === sequence.current &&
      requestedSession === currentSession.current,
    [],
  );

  const read = useCallback(async () => {
    const request = ++sequence.current;
    const requestedSession = sessionId;
    try {
      const state = await getInterviewWorkflowState(requestedSession);
      if (isCurrent(request, requestedSession))
        setLoad({ status: 'ready', state });
    } catch (error) {
      if (isCurrent(request, requestedSession))
        setLoad({ status: 'error', message: errorMessage(error) });
    }
  }, [isCurrent, sessionId]);

  // Initial read, and a fresh one whenever the session id changes.
  useEffect(() => {
    currentSession.current = sessionId;
    if (loadedSession.current === sessionId) return;
    loadedSession.current = sessionId;
    sequence.current += 1;
    inFlight.current = false;
    setPending(null);
    setActionError(null);
    setLoad({ status: 'loading' });
    void read();
  }, [read, sessionId]);

  const state = load.status === 'ready' ? load.state : null;

  // Keyed on `load`, which changes on every completed read, so an unchanged
  // snapshot still schedules the next poll.
  useEffect(() => {
    if (load.status !== 'ready' || !shouldPoll(load.state)) return;
    const timer = window.setTimeout(() => {
      // A running command will deliver a newer snapshot itself.
      if (!inFlight.current) void read();
    }, SESSION_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [load, read]);

  /** Run one command; `send` returns the next snapshot or null to re-read. */
  const run = useCallback(
    async (
      command: SessionCommand,
      send: () => Promise<InterviewWorkflowState | null>,
    ) => {
      inFlight.current = true;
      setPending(command);
      setActionError(null);
      const request = ++sequence.current;
      const requestedSession = sessionId;
      let reread = false;
      try {
        const next = await send();
        if (next === null) reread = true;
        else if (isCurrent(request, requestedSession))
          setLoad({ status: 'ready', state: next });
      } catch (error) {
        if (!isCurrent(request, requestedSession)) return;
        setActionError(errorMessage(error));
        // The snapshot may have moved on (for example CONFLICT); re-read it.
        reread = true;
      } finally {
        if (requestedSession === currentSession.current) {
          inFlight.current = false;
          if (mounted.current) setPending(null);
        }
      }
      if (reread && requestedSession === currentSession.current) void read();
    },
    [isCurrent, read, sessionId],
  );

  const canSend = useCallback(
    (command: SessionCommand) => {
      if (inFlight.current || !state) return false;
      if (command === 'cancel_operation') return state.operationId !== null;
      return state.availableActions.includes(command);
    },
    [state],
  );

  const act = useCallback(
    async (intent: SessionIntent) => {
      if (!canSend(intent)) return;
      await run(intent, () => continueInterviewWorkflow(sessionId, intent));
    },
    [canSend, run, sessionId],
  );

  /** Resolves true only when the answer was committed by this call. */
  const submitAnswer = useCallback(
    async (answer: AnswerSubmission) => {
      if (!canSend('answer')) return false;
      if (state?.currentQuestion?.id !== answer.questionId) return false;
      let committed = false;
      await run('answer', async () => {
        const next = await submitInterviewWorkflowAnswer({
          sessionId,
          questionId: answer.questionId,
          answerText: answer.answerText,
          ...(answer.audio ? { audio: answer.audio } : {}),
        });
        committed = true;
        return next;
      });
      return committed;
    },
    [canSend, run, sessionId, state],
  );

  const pause = useCallback(async () => {
    if (!canSend('pause')) return;
    await run('pause', () => pauseInterviewWorkflow(sessionId));
  }, [canSend, run, sessionId]);

  /**
   * `not_sent` when the request was not advertised or another command is in
   * flight; otherwise whether the backend accepted it.
   */
  const requestResults = useCallback(async (): Promise<
    'accepted' | 'failed' | 'not_sent'
  > => {
    if (!canSend('request_results')) return 'not_sent';
    let accepted = false;
    await run('request_results', async () => {
      const next = await requestInterviewResults(sessionId);
      accepted = true;
      return next;
    });
    return accepted ? 'accepted' : 'failed';
  }, [canSend, run, sessionId]);

  /** Stops the current model operation only; the session stays active. */
  const cancelOperation = useCallback(async () => {
    if (!canSend('cancel_operation')) return;
    await run('cancel_operation', async () => {
      await cancelInterviewOperation(sessionId);
      return null;
    });
  }, [canSend, run, sessionId]);

  /** Terminal: `sessions.finish {outcome:'abandoned'}`. */
  const abandon = useCallback(async () => {
    if (!canSend('abandon')) return;
    await run('abandon', async () => {
      await finishInterviewSession(sessionId, 'abandoned');
      return null;
    });
  }, [canSend, run, sessionId]);

  const refresh = useCallback(() => {
    setLoad((current) =>
      current.status === 'error' ? { status: 'loading' } : current,
    );
    void read();
  }, [read]);

  return {
    load,
    pending,
    actionError,
    act,
    submitAnswer,
    pause,
    requestResults,
    cancelOperation,
    abandon,
    refresh,
  };
}

export type SessionWorkflow = ReturnType<typeof useSessionWorkflow>;

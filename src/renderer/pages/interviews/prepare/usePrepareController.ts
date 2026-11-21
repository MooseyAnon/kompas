import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ADDITIONAL_GUIDANCE_MAX,
  type InterviewMethod,
  type InterviewSession,
  type InterviewSessionSummary,
  type InterviewWorkflowState,
  type Target,
} from '../../../../shared/contracts';
import {
  ApiError,
  clearInterviewPreview,
  continueInterviewWorkflow,
  createInterviewSession,
  deleteInterviewSession,
  finishInterviewSession,
  getInterviewPreview,
  getInterviewSession,
  getInterviewWorkflowState,
  listInterviewSessions,
  listTargets,
  startInterviewSession,
  updateInterviewSession,
} from '../../../api';
import { isPausedPhase } from '../session/sessionView';
import {
  buildCreateInput,
  buildPatch,
  emptyPrepareForm,
  formFromSession,
  guidanceLength,
  hasErrors,
  isEmptyPatch,
  validateCreate,
  validatePatch,
  type PrepareField,
  type PrepareFieldErrors,
  type PrepareFormValues,
} from './prepareForm';

/**
 * Prepare-tab controller: an API facade plus in-flight request state. The
 * backend owns the lifecycle; this hook never infers transitions, only sends
 * explicit user intents and re-reads results.
 */
export type Loadable<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; message: string };

export type DraftEditor =
  | { kind: 'new' }
  | { kind: 'loading'; sessionId: string }
  | { kind: 'editing'; session: InterviewSession };

export type PrepareBusy = 'save' | 'start' | 'clear-preview' | 'row' | null;

export type PrepareNotice =
  | { tone: 'success'; message: string }
  | {
      tone: 'error';
      /** `draft` = saving the setup; `start` = asking the backend to begin. */
      stage: 'draft' | 'start';
      message: string;
      openSettings: boolean;
      canClearPreview: boolean;
    }
  | null;

export type RowAction = 'resume' | 'delete' | 'abandon';
export type RowState = { sessionId: string; action: RowAction };

export type OpenSession = (
  sessionId: string,
  state?: InterviewWorkflowState,
) => void;

const GENERIC_ERROR = 'Something went wrong. Please try again.';

function errorMessage(error: unknown) {
  return error instanceof ApiError ? error.message : GENERIC_ERROR;
}

/** Backend model failures consistently direct people to Local AI settings. */
export function pointsToLocalAiSettings(message: string | null) {
  return /local ai/i.test(message ?? '');
}

export function isResumable(item: InterviewSessionSummary) {
  return item.status === 'draft' || item.status === 'active';
}

export function usePrepareController(onOpenSession: OpenSession) {
  const [values, setValues] = useState<PrepareFormValues>(emptyPrepareForm);
  const [editor, setEditor] = useState<DraftEditor>({ kind: 'new' });
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState<PrepareBusy>(null);
  const [notice, setNotice] = useState<PrepareNotice>(null);
  const [recent, setRecent] = useState<Loadable<InterviewSessionSummary[]>>({
    status: 'loading',
  });
  const [targets, setTargets] = useState<Loadable<Target[]>>({
    status: 'loading',
  });
  const [confirming, setConfirming] = useState<RowState | null>(null);
  const [rowBusy, setRowBusy] = useState<RowState | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const mounted = useRef(true);
  // One mutation at a time; a ref closes the double-click gap before re-render.
  const inFlight = useRef(false);
  // Responses for an older draft selection or list request are ignored.
  const draftRequest = useRef(0);
  const recentRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // --- reads (never start work) ---------------------------------------------

  const refreshRecent = useCallback(async () => {
    const request = ++recentRequest.current;
    try {
      const items = await listInterviewSessions();
      if (!mounted.current || request !== recentRequest.current) return;
      const unfinished = items
        .filter(isResumable)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      setRecent({ status: 'ready', data: unfinished });
    } catch (error) {
      if (!mounted.current || request !== recentRequest.current) return;
      setRecent({ status: 'error', message: errorMessage(error) });
    }
  }, []);

  const loadTargets = useCallback(async () => {
    try {
      const items = await listTargets();
      if (mounted.current) setTargets({ status: 'ready', data: items });
    } catch (error) {
      if (mounted.current)
        setTargets({ status: 'error', message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void refreshRecent();
    void loadTargets();
  }, [refreshRecent, loadTargets]);

  // --- form state -----------------------------------------------------------

  const editing = editor.kind === 'editing' ? editor.session : null;
  const patch = useMemo(
    () => (editing ? buildPatch(editing, values) : null),
    [editing, values],
  );
  const fieldErrors = useMemo<PrepareFieldErrors>(
    () => (patch ? validatePatch(values, patch) : validateCreate(values)),
    [patch, values],
  );
  // Overlength guidance is shown live; other errors after a save/start attempt.
  const visibleErrors = useMemo<PrepareFieldErrors>(() => {
    if (attempted) return fieldErrors;
    return guidanceLength(values.additionalGuidance) > ADDITIONAL_GUIDANCE_MAX
      ? { additionalGuidance: fieldErrors.additionalGuidance }
      : {};
  }, [attempted, fieldErrors, values.additionalGuidance]);
  const dirty = patch === null || !isEmptyPatch(patch);

  const setField = useCallback(
    <K extends keyof PrepareFormValues>(
      field: K,
      value: PrepareFormValues[K],
    ) => {
      setValues((current) => ({ ...current, [field]: value }));
      setNotice((current) => (current?.tone === 'success' ? null : current));
    },
    [],
  );

  const setMethod = useCallback(
    (method: InterviewMethod) => {
      // A saved draft's method is fixed by the contract.
      if (editor.kind !== 'new') return;
      setField('method', method);
    },
    [editor.kind, setField],
  );

  function adoptDraft(session: InterviewSession) {
    draftRequest.current++;
    setEditor({ kind: 'editing', session });
    setValues(formFromSession(session));
  }

  const resetToNew = useCallback(() => {
    draftRequest.current++;
    setEditor({ kind: 'new' });
    setValues(emptyPrepareForm);
    setAttempted(false);
  }, []);

  // --- mutations ------------------------------------------------------------

  async function exclusive(
    kind: Exclude<PrepareBusy, null>,
    task: () => Promise<void>,
  ) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    try {
      await task();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  /** Validates before any request; returns the first invalid field, if any. */
  function checkForm(): PrepareField | null {
    setAttempted(true);
    if (!hasErrors(fieldErrors)) return null;
    return (Object.keys(fieldErrors) as PrepareField[])[0];
  }

  async function persistDraft(): Promise<InterviewSession> {
    if (editing && patch) {
      if (isEmptyPatch(patch)) return editing;
      const updated = await updateInterviewSession(editing.id, patch);
      adoptDraft(updated);
      return updated;
    }
    const created = await createInterviewSession(buildCreateInput(values));
    adoptDraft(created);
    return created;
  }

  async function draftFailure(error: unknown, draft: InterviewSession | null) {
    const base = {
      tone: 'error' as const,
      stage: 'draft' as const,
      openSettings: false,
      canClearPreview: false,
    };
    if (!(error instanceof ApiError) || error.code !== 'CONFLICT' || !draft) {
      setNotice({ ...base, message: errorMessage(error) });
      return;
    }

    // CONFLICT means the draft started elsewhere or has a stale preview.
    try {
      const current = await getInterviewSession(draft.id);
      if (!mounted.current) return;
      if (current.status !== 'draft') {
        resetToNew();
        setNotice({
          ...base,
          message:
            'This interview has already started, so its setup can’t change. Resume it from the list instead.',
        });
        void refreshRecent();
        return;
      }
      const preview = await getInterviewPreview(draft.id);
      if (!mounted.current) return;
      setNotice({
        ...base,
        message: error.message,
        canClearPreview: preview.question !== null,
      });
    } catch {
      if (mounted.current) setNotice({ ...base, message: error.message });
    }
  }

  function saveDraft(): PrepareField | null {
    const invalid = checkForm();
    if (invalid) return invalid;

    void exclusive('save', async () => {
      setNotice(null);
      try {
        await persistDraft();
        if (!mounted.current) return;
        setNotice({ tone: 'success', message: 'Draft saved.' });
        void refreshRecent();
      } catch (error) {
        await draftFailure(error, editing);
      }
    });
    return null;
  }

  function startPractice(): PrepareField | null {
    const invalid = checkForm();
    if (invalid) return invalid;

    void exclusive('start', async () => {
      setNotice(null);
      let draft: InterviewSession;
      try {
        draft = await persistDraft();
      } catch (error) {
        await draftFailure(error, editing);
        return;
      }

      try {
        await startInterviewSession(draft.id);
      } catch (error) {
        if (!mounted.current) return;
        const message = errorMessage(error);
        // The draft is kept and stays selected, so Start can simply be retried.
        setNotice({
          tone: 'error',
          stage: 'start',
          message,
          openSettings: pointsToLocalAiSettings(message),
          canClearPreview: false,
        });
        void refreshRecent();
        return;
      }

      // `sessions.start` is not a snapshot; read one before entering.
      let state: InterviewWorkflowState | undefined;
      try {
        state = await getInterviewWorkflowState(draft.id);
      } catch {
        state = undefined;
      }
      onOpenSession(draft.id, state);
    });
    return null;
  }

  function clearPreview() {
    if (!editing) return;
    const sessionId = editing.id;
    void exclusive('clear-preview', async () => {
      try {
        await clearInterviewPreview(sessionId);
        if (!mounted.current) return;
        setNotice({
          tone: 'success',
          message: 'Preview cleared. You can save your changes now.',
        });
      } catch (error) {
        if (!mounted.current) return;
        setNotice({
          tone: 'error',
          stage: 'draft',
          message: errorMessage(error),
          openSettings: false,
          canClearPreview: false,
        });
      }
    });
  }

  async function editDraft(sessionId: string) {
    if (inFlight.current) return;
    const request = ++draftRequest.current;
    setEditor({ kind: 'loading', sessionId });
    setNotice(null);
    setConfirming(null);
    setAttempted(false);
    try {
      const session = await getInterviewSession(sessionId);
      if (!mounted.current || request !== draftRequest.current) return;
      if (session.status !== 'draft') {
        resetToNew();
        setRowError(
          'That interview has already started, so it can’t be edited.',
        );
        void refreshRecent();
        return;
      }
      setRowError(null);
      setEditor({ kind: 'editing', session });
      setValues(formFromSession(session));
    } catch (error) {
      if (!mounted.current || request !== draftRequest.current) return;
      resetToNew();
      setRowError(errorMessage(error));
    }
  }

  function cancelEdit() {
    if (inFlight.current) return;
    resetToNew();
    setNotice(null);
  }

  function requestConfirm(sessionId: string, action: 'delete' | 'abandon') {
    if (inFlight.current) return;
    setRowError(null);
    setConfirming({ sessionId, action });
  }

  function cancelConfirm() {
    setConfirming(null);
  }

  function runRow(row: RowState, task: () => Promise<void>) {
    void exclusive('row', async () => {
      setRowBusy(row);
      setRowError(null);
      try {
        await task();
      } catch (error) {
        if (mounted.current) setRowError(errorMessage(error));
        void refreshRecent();
      } finally {
        if (mounted.current) setRowBusy(null);
      }
    });
  }

  function confirmRow() {
    if (!confirming) return;
    const row = confirming;
    runRow(row, async () => {
      if (row.action === 'delete') await deleteInterviewSession(row.sessionId);
      else await finishInterviewSession(row.sessionId, 'abandoned');
      if (!mounted.current) return;
      setConfirming(null);
      if (
        editing?.id === row.sessionId ||
        (editor.kind === 'loading' && editor.sessionId === row.sessionId)
      )
        resetToNew();
      await refreshRecent();
    });
  }

  /**
   * Resume is an explicit user intent. A paused session continues only when
   * the snapshot advertises `continue`. With nothing running in memory (for
   * example after a restart), an explicit `sessions.start` rebuilds missing
   * work; the backend never repeats saved questions, answers or reviews. A
   * failed or cancelled operation is not retried here: the session view
   * offers Retry when advertised.
   */
  function resumeSession(sessionId: string) {
    runRow({ sessionId, action: 'resume' }, async () => {
      const state = await getInterviewWorkflowState(sessionId);
      const { session, progress, availableActions } = state;

      if (session.status === 'completed' || session.status === 'abandoned') {
        if (!mounted.current) return;
        setRowError('That interview has already finished.');
        await refreshRecent();
        return;
      }

      let next = state;
      if (isPausedPhase(session.phase)) {
        if (availableActions.includes('continue'))
          next = await continueInterviewWorkflow(sessionId, 'continue');
      } else if (
        session.status === 'active' &&
        state.operationId === null &&
        progress.operationStatus === 'idle'
      ) {
        await startInterviewSession(sessionId);
        next = await getInterviewWorkflowState(sessionId);
      }
      onOpenSession(sessionId, next);
    });
  }

  return {
    values,
    editor,
    dirty,
    busy,
    notice,
    fieldErrors: visibleErrors,
    recent,
    targets,
    confirming,
    rowBusy,
    rowError,
    setField,
    setMethod,
    saveDraft,
    startPractice,
    clearPreview,
    editDraft,
    cancelEdit,
    requestConfirm,
    cancelConfirm,
    confirmRow,
    resumeSession,
    retryRecent: refreshRecent,
  };
}

export type PrepareController = ReturnType<typeof usePrepareController>;

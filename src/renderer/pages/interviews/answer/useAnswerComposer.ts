import { useCallback, useEffect, useRef, useState } from 'react';
import { ANSWER_TEXT_MAX } from '../../../../shared/contracts';
import {
  clearInterviewAnswerDraft,
  getInterviewAnswerDraft,
  saveInterviewAnswerDraft,
} from '../../../api';
import type { InterviewDraftStatus } from '../../../presentation/components/interviews/InterviewAnswerComposer';
import type { AnswerSubmission } from '../session/useSessionWorkflow';
import { useVoiceAnswer, type CreateVoiceRecorder } from './useVoiceAnswer';
import { mergeTranscript } from './voiceAnswer';

/** Typing pauses this long before the draft is saved. */
export const DRAFT_SAVE_DELAY_MS = 800;

/**
 * Answer controller for one question; mount it per question (key the
 * component by question id). It restores and saves the backend draft
 * (`answers.draft.*`), adapts voice capture/STT, and submits once through the
 * session controller. Saves stop as soon as a submit starts, because the
 * backend consumes the draft when the answer is committed.
 */
export function useAnswerComposer({
  sessionId,
  questionId,
  canAnswer,
  submit,
  createRecorder,
}: {
  sessionId: string;
  questionId: string;
  /** `answer` is advertised for this question and nothing else is sending. */
  canAnswer: boolean;
  submit: (answer: AnswerSubmission) => Promise<boolean>;
  createRecorder?: CreateVoiceRecorder;
}) {
  const [text, setTextValue] = useState('');
  const [draftStatus, setDraftStatus] = useState<InterviewDraftStatus>('idle');
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const mounted = useRef(true);
  const textRef = useRef('');
  const recordingIdRef = useRef<string | null>(null);
  const lastTranscript = useRef<string | null>(null);
  const edited = useRef(false);
  const loadedRef = useRef(false);
  // A save requested before the draft was read runs once it has been read.
  const saveAfterLoad = useRef(false);
  const committing = useRef(false);
  const saveTimer = useRef<number | null>(null);
  const saveSequence = useRef(0);
  const saving = useRef<Promise<void>>(Promise.resolve());

  const persist = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (committing.current) return;
    if (!loadedRef.current) {
      saveAfterLoad.current = true;
      return;
    }

    const request = ++saveSequence.current;
    const draftText = textRef.current;
    const recordingId = recordingIdRef.current;
    if (mounted.current) setDraftStatus('saving');
    // SQLite upserts are last-write-wins. Serialize requests so a slow older
    // draft cannot arrive after a newer edit (or after submit consumes it).
    const save = saving.current.then(() =>
      draftText.trim() || recordingId
        ? saveInterviewAnswerDraft(sessionId, questionId, {
            recordingId,
            draftText: draftText || null,
          }).then(() => undefined)
        : clearInterviewAnswerDraft(sessionId, questionId),
    );
    saving.current = save.then(
      () => {
        if (mounted.current && request === saveSequence.current)
          setDraftStatus('saved');
      },
      () => {
        if (mounted.current && request === saveSequence.current)
          setDraftStatus('error');
      },
    );
  }, [questionId, sessionId]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(persist, DRAFT_SAVE_DELAY_MS);
  }, [persist]);

  const setText = useCallback(
    (value: string) => {
      textRef.current = value;
      edited.current = true;
      setTextValue(value);
      scheduleSave();
    },
    [scheduleSave],
  );

  const voice = useVoiceAnswer({
    createRecorder,
    onRecordingChange: (recordingId) => {
      recordingIdRef.current = recordingId;
      persist();
    },
    onTranscript: (transcript) => {
      const merged = mergeTranscript(
        textRef.current,
        transcript,
        lastTranscript.current,
      );
      lastTranscript.current = transcript;
      textRef.current = merged;
      edited.current = true;
      if (mounted.current) setTextValue(merged);
      persist();
    },
  });
  const { rehydrate } = voice;

  // Restore the saved draft once; typing that started first is kept.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { draft } = await getInterviewAnswerDraft(sessionId, questionId);
        if (cancelled || !draft) return;
        if (!edited.current && draft.draftText) {
          textRef.current = draft.draftText;
          setTextValue(draft.draftText);
        }
        if (
          draft.recordingId &&
          recordingIdRef.current === null &&
          rehydrate(draft.recordingId, draft.updatedAt)
        )
          recordingIdRef.current = draft.recordingId;
      } catch {
        // No readable draft: start empty; saving reports its own errors.
      } finally {
        if (!cancelled) {
          loadedRef.current = true;
          setLoaded(true);
          if (saveAfterLoad.current) persist();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persist, questionId, rehydrate, sessionId]);

  // Leaving the view keeps whatever was typed.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (saveTimer.current !== null) persist();
    };
  }, [persist]);

  const trimmedLength = text.trim().length;
  const validText = trimmedLength > 0 && trimmedLength <= ANSWER_TEXT_MAX;
  const canSubmit = canAnswer && validText && !voice.busy && !submitting;

  const submitAnswer = useCallback(async () => {
    if (committing.current || !canSubmit) return;
    committing.current = true;
    setSubmitting(true);
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = null;
    // A save landing after the commit would recreate a consumed draft.
    await saving.current;

    const committed = await submit({
      questionId,
      answerText: textRef.current.trim(),
      ...(voice.link ? { audio: voice.link } : {}),
    });
    if (!mounted.current) return;
    setSubmitting(false);
    if (!committed) {
      committing.current = false;
      persist();
    }
  }, [canSubmit, persist, questionId, submit, voice.link]);

  return {
    inputId: `interview-answer-${questionId}`,
    text,
    setText,
    draftStatus,
    loaded,
    submitting,
    canSubmit,
    submit: submitAnswer,
    maxLength: ANSWER_TEXT_MAX,
    voice,
  };
}

import type { ZodIssue } from 'zod';
import {
  ADDITIONAL_GUIDANCE_MAX,
  QUICK_FIRE_DEFAULT_COUNT,
  QUICK_FIRE_MAX_COUNT,
  QUICK_FIRE_MIN_COUNT,
  SUBJECT_MAX,
  interviewSessionPatchSchema,
  interviewSessionsCreateInputSchema,
  type InterviewMethod,
  type InterviewSession,
  type InterviewSessionPatch,
  type InterviewSessionsCreateInput,
} from '../../../../shared/contracts/interviews';

/**
 * The Prepare form as the user edits it. Payloads are built from these values
 * and validated with the authoritative Zod schemas before anything is sent, so
 * field errors mirror the backend instead of re-implementing its rules.
 */
export type PrepareFormValues = {
  method: InterviewMethod;
  subject: string;
  /** Empty string means "no career target". */
  careerTargetId: string;
  questionCount: number;
  additionalGuidance: string;
};

export type PrepareField =
  | 'subject'
  | 'careerTargetId'
  | 'questionCount'
  | 'additionalGuidance';
export type PrepareFieldErrors = Partial<Record<PrepareField, string>>;

export const quickFireCounts = Array.from(
  { length: QUICK_FIRE_MAX_COUNT - QUICK_FIRE_MIN_COUNT + 1 },
  (_, index) => QUICK_FIRE_MIN_COUNT + index,
);

export const emptyPrepareForm: PrepareFormValues = {
  method: 'quick_fire',
  subject: '',
  careerTargetId: '',
  questionCount: QUICK_FIRE_DEFAULT_COUNT,
  additionalGuidance: '',
};

export function formFromSession(session: InterviewSession): PrepareFormValues {
  return {
    method: session.method,
    subject: session.subject,
    careerTargetId: session.careerTargetId ?? '',
    questionCount: session.questionCount ?? QUICK_FIRE_DEFAULT_COUNT,
    additionalGuidance: session.additionalGuidance ?? '',
  };
}

/** The contract counts trimmed UTF-16 code units, which is `String#length`. */
export function guidanceLength(text: string) {
  return text.trim().length;
}

function normalisedGuidance(text: string): string | null {
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

export function buildCreateInput(
  values: PrepareFormValues,
): InterviewSessionsCreateInput {
  const guidance = normalisedGuidance(values.additionalGuidance);
  return {
    method: values.method,
    subject: values.subject.trim(),
    careerTargetId: values.careerTargetId || null,
    ...(values.method === 'quick_fire'
      ? { questionCount: values.questionCount }
      : {}),
    // Omitting guidance is equivalent to null; only send real text.
    ...(guidance ? { additionalGuidance: guidance } : {}),
  };
}

/**
 * Only keys the user actually changed. The backend rejects any context key
 * while a draft preview exists, even when its value is unchanged.
 */
export function buildPatch(
  original: InterviewSession,
  values: PrepareFormValues,
): InterviewSessionPatch {
  const patch: InterviewSessionPatch = {};

  const subject = values.subject.trim();
  if (subject !== original.subject) patch.subject = subject;

  const careerTargetId = values.careerTargetId || null;
  if (careerTargetId !== original.careerTargetId)
    patch.careerTargetId = careerTargetId;

  if (
    original.method === 'quick_fire' &&
    values.questionCount !== original.questionCount
  )
    patch.questionCount = values.questionCount;

  const guidance = normalisedGuidance(values.additionalGuidance);
  if (guidance !== original.additionalGuidance)
    patch.additionalGuidance = guidance;

  return patch;
}

export function isEmptyPatch(patch: InterviewSessionPatch) {
  return Object.keys(patch).length === 0;
}

function messageFor(field: PrepareField, issue: ZodIssue, value: unknown) {
  switch (field) {
    case 'subject':
      return issue.code === 'too_big'
        ? `Keep the subject to ${SUBJECT_MAX} characters or fewer.`
        : 'Add a subject to practise.';
    case 'additionalGuidance':
      return issue.code === 'too_big'
        ? `Guidance can be up to ${ADDITIONAL_GUIDANCE_MAX.toLocaleString('en-GB')} characters; it isn’t shortened for you (currently ${guidanceLength(String(value ?? '')).toLocaleString('en-GB')}).`
        : 'Guidance contains characters that can’t be saved. Remove any pasted control characters.';
    case 'careerTargetId':
      return 'Choose a career target from the list, or none.';
    case 'questionCount':
      return `Choose between ${QUICK_FIRE_MIN_COUNT} and ${QUICK_FIRE_MAX_COUNT} questions.`;
  }
}

function collectErrors(
  issues: readonly ZodIssue[],
  payload: Record<string, unknown>,
): PrepareFieldErrors {
  const errors: PrepareFieldErrors = {};
  for (const issue of issues) {
    const field = issue.path[0] as PrepareField;
    if (!errors[field])
      errors[field] = messageFor(field, issue, payload[field]);
  }
  return errors;
}

function countErrors(values: PrepareFormValues): PrepareFieldErrors {
  if (values.method !== 'quick_fire') return {};
  return quickFireCounts.includes(values.questionCount)
    ? {}
    : {
        questionCount: `Choose between ${QUICK_FIRE_MIN_COUNT} and ${QUICK_FIRE_MAX_COUNT} questions.`,
      };
}

export function validateCreate(values: PrepareFormValues): PrepareFieldErrors {
  // Validate the untrimmed guidance so the schema itself trims and measures it.
  const payload = {
    ...buildCreateInput(values),
    ...(values.additionalGuidance.trim()
      ? { additionalGuidance: values.additionalGuidance }
      : {}),
  };
  const parsed = interviewSessionsCreateInputSchema.safeParse(payload);
  return {
    ...(parsed.success ? {} : collectErrors(parsed.error.issues, payload)),
    ...countErrors(values),
  };
}

export function validatePatch(
  values: PrepareFormValues,
  patch: InterviewSessionPatch,
): PrepareFieldErrors {
  const parsed = interviewSessionPatchSchema.safeParse(patch);
  return {
    ...(parsed.success ? {} : collectErrors(parsed.error.issues, patch)),
    ...countErrors(values),
  };
}

export function hasErrors(errors: PrepareFieldErrors) {
  return Object.keys(errors).length > 0;
}

/**
 * Internal helpers shared by the interview services. Not part of the module's
 * public surface: import only from files inside `modules/interviews`.
 */

import {
  approvedOrProvisionalBarSchema,
  type ApprovedOrProvisionalBar,
  type Experience,
  type GenerationResult,
  type InferenceSettingsGetOutput,
  type Target,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';
import type { GenerationEntry } from '../inference/inference.service';
import type { TelemetryService } from '../telemetry/telemetry.service';
import type { IdentityFact } from './interviews.question-prompt';

// --- Types -------------------------------------------------------------------

/** The narrow inference surface the interview services depend on. */
export interface InterviewsInferenceClient {
  getSettingsSnapshot(): Promise<InferenceSettingsGetOutput>;
  generate(request: GenerationEntry): Promise<GenerationResult>;
}

/**
 * Read-only identity context the interviews domain is allowed to see. Exposes
 * only the minimal typed reads needed to ground a question — never raw document
 * text or a generic profile dump. Structurally satisfied by `IdentityService`.
 */
export interface InterviewsIdentityReader {
  getTarget(id: string): Target | null;
  listExperiences(): Experience[];
}

export type TelemetryOutcome = 'success' | 'failure';

export type TelemetryDetail = Record<string, string | number | boolean | null>;

// --- Constants ---------------------------------------------------------------

/** Upper bound on user-confirmed facts used to ground one generation. */
export const MAX_CONFIRMED_FACTS = 6;

export const SESSION_NOT_FOUND_MESSAGE = 'That interview could not be found.';

// --- Helpers -----------------------------------------------------------------

export function now(): string {
  return new Date().toISOString();
}

export function newId(): string {
  return globalThis.crypto.randomUUID();
}

/** Truncate to `max` characters, marking the cut with an ellipsis. */
export function shorten(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Parse a stored bar snapshot; anything missing or invalid yields null. */
export function parseBar(value: unknown): ApprovedOrProvisionalBar | null {
  if (value === null || value === undefined) {
    return null;
  }

  const parsed = approvedOrProvisionalBarSchema.safeParse(value);

  return parsed.success ? parsed.data : null;
}

/**
 * Only user-confirmed experiences may ground generation; imported or inferred
 * facts stay out of prompts until the user approves them.
 */
export function collectConfirmedFacts(
  identity: InterviewsIdentityReader,
): IdentityFact[] {
  return identity
    .listExperiences()
    .filter((e) => e.verificationStatus === 'user_confirmed')
    .slice(0, MAX_CONFIRMED_FACTS)
    .map((e) => ({
      roleTitle: e.roleTitle,
      category: e.category,
      organisation: e.organisation,
    }));
}

export function sessionNotFound(): AppError {
  return new AppError('NOT_FOUND', SESSION_NOT_FOUND_MESSAGE);
}

/** Record an `interviews` telemetry event when telemetry is wired in. */
export function recordTelemetry(
  telemetry: TelemetryService | undefined,
  operation: string,
  startedAt: string,
  outcome: TelemetryOutcome,
  detail: TelemetryDetail,
): void {
  telemetry?.record({
    moduleId: 'interviews',
    operation,
    outcome,
    startedAt,
    detail,
  });
}

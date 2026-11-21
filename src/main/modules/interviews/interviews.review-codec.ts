/**
 * Persistence codecs for the Deep Loop review service: the stored JSON shapes
 * of reviews, coaching and rubric snapshots, and their tolerant parsers. A
 * malformed row always decodes to a safe fallback rather than throwing.
 */

import type { InterviewModelProvenance } from '../../../shared/contracts';

// --- Stored shapes -----------------------------------------------------------

export interface StoredProvenance extends InterviewModelProvenance {
  inferenceRequestId: string;
}

export interface StoredCriterion {
  id: string;
  label: string;
  weight: number;
  score: number | null;
  evidence: string | null;
  rationale: string | null;
}

/** Persisted feedback payload in `interview_reviews.feedback_json`. */
export interface StoredFeedback {
  schemaVersion: 1;
  criteria: StoredCriterion[];
  strengths: string[];
  gaps: string[];
  needsMoreEvidence: boolean;
  unscoredReason: string | null;
  provenance: StoredProvenance;
}

/** Persisted coaching payload in `interview_coaching.content_json`. */
export interface StoredCoaching {
  schemaVersion: 1;
  diagnosis: string;
  advice: string[];
  workedExample: string | null;
  reassessmentFocus: string;
  provenance: StoredProvenance;
}

export type BarKind = 'target_hiring_bar' | 'practice_benchmark';

export interface StoredRubricSnapshot {
  barKind: BarKind;
  passThreshold: number | null;
}

// --- Helpers -----------------------------------------------------------------

/** Placeholder provenance for reviews/coaching produced without a model. */
export function offlineProvenance(
  validation: 'passed' | 'unscored',
): StoredProvenance {
  return {
    providerId: 'none',
    modelId: 'none',
    promptVersion: 'none',
    validation,
    generatedAt: new Date(0).toISOString(),
    inferenceRequestId: 'none',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Rows are written only by this service, so a present provenance or reason is
 * passed through unchanged (historical behaviour) rather than re-validated.
 */
function trustedOr<T>(value: unknown, fallback: T): T {
  return value === null || value === undefined ? fallback : (value as T);
}

// --- Parsers -----------------------------------------------------------------

export function parseFeedback(json: string): StoredFeedback {
  const fallback: StoredFeedback = {
    schemaVersion: 1,
    criteria: [],
    strengths: [],
    gaps: [],
    needsMoreEvidence: false,
    unscoredReason: null,
    provenance: offlineProvenance('unscored'),
  };

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return fallback;
    }

    return {
      schemaVersion: 1,
      criteria: Array.isArray(parsed.criteria) ? parsed.criteria : [],
      strengths: Array.isArray(parsed.strengths) ? parsed.strengths : [],
      gaps: Array.isArray(parsed.gaps) ? parsed.gaps : [],
      needsMoreEvidence: parsed.needsMoreEvidence === true,
      unscoredReason: trustedOr<string | null>(parsed.unscoredReason, null),
      provenance: trustedOr(parsed.provenance, fallback.provenance),
    };
  } catch {
    return fallback;
  }
}

/** Only the string gaps of a stored feedback payload; [] when unreadable. */
export function feedbackGaps(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed) || !Array.isArray(parsed.gaps)) {
      return [];
    }

    return parsed.gaps.filter(isString);
  } catch {
    return [];
  }
}

export function parseCoaching(json: string): StoredCoaching {
  const fallback: StoredCoaching = {
    schemaVersion: 1,
    diagnosis: '',
    advice: [],
    workedExample: null,
    reassessmentFocus: '',
    provenance: offlineProvenance('passed'),
  };

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return fallback;
    }

    return {
      schemaVersion: 1,
      diagnosis: isString(parsed.diagnosis) ? parsed.diagnosis : '',
      advice: Array.isArray(parsed.advice)
        ? parsed.advice.filter(isString)
        : [],
      workedExample: isString(parsed.workedExample)
        ? parsed.workedExample
        : null,
      reassessmentFocus: isString(parsed.reassessmentFocus)
        ? parsed.reassessmentFocus
        : '',
      provenance: trustedOr(parsed.provenance, fallback.provenance),
    };
  } catch {
    return fallback;
  }
}

export function parseSnapshot(
  json: string | null,
): StoredRubricSnapshot | null {
  if (!json) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(json);
    if (!isRecord(parsed)) {
      return null;
    }

    const { barKind, passThreshold } = parsed;
    const hasKnownBarKind =
      barKind === 'target_hiring_bar' || barKind === 'practice_benchmark';
    if (!hasKnownBarKind) {
      return null;
    }

    return {
      barKind,
      passThreshold: typeof passThreshold === 'number' ? passThreshold : null,
    };
  } catch {
    return null;
  }
}

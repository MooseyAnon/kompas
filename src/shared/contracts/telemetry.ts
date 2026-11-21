import { z } from 'zod';

/** Public API major version for the `telemetry` module. */
export const TELEMETRY_API_VERSION = 1;
export const TELEMETRY_MODULE_ID = 'telemetry';

/** Outcome of an observed operation. */
export const OPERATION_OUTCOMES = ['success', 'failure', 'cancelled'] as const;

export const operationOutcomeSchema = z.enum(OPERATION_OUTCOMES);

export type OperationOutcome = (typeof OPERATION_OUTCOMES)[number];

/**
 * Safe, public projection of an `operation_runs` row. The sensitive
 * `detail_json` column is deliberately excluded from this listing.
 */
export const operationRunSchema = z.object({
  id: z.string().min(1),
  moduleId: z.string().min(1),
  operation: z.string().min(1),
  outcome: operationOutcomeSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().min(1).nullable(),
});

export type OperationRun = z.infer<typeof operationRunSchema>;

/**
 * Maximum number of recent runs returnable in one `telemetry.runs.list` call.
 */
export const TELEMETRY_RUNS_MAX_LIMIT = 100;
export const TELEMETRY_RUNS_DEFAULT_LIMIT = 50;

/** `telemetry.runs.list` input: optional bounded limit. */
export const telemetryRunsListInputSchema = z
  .object({
    limit: z.number().int().positive().max(TELEMETRY_RUNS_MAX_LIMIT).optional(),
  })
  .strict();

export type TelemetryRunsListInput = z.infer<
  typeof telemetryRunsListInputSchema
>;

export const telemetryRunsListOutputSchema = z.object({
  items: z.array(operationRunSchema),
});

export type TelemetryRunsListOutput = z.infer<
  typeof telemetryRunsListOutputSchema
>;

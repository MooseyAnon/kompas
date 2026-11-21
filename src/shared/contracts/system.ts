import { z } from 'zod';

/** Public API major version for the `system` module. */
export const SYSTEM_API_VERSION = 1;
export const SYSTEM_MODULE_ID = 'system';

/** `system.ping` input: no parameters. */
export const systemPingInputSchema = z.object({}).strict();

export type SystemPingInput = z.infer<typeof systemPingInputSchema>;

/**
 * `system.ping` output. `storageReady` reflects whether the local SQLite
 * database and managed file store initialised successfully on app boot.
 */
export const systemPingOutputSchema = z.object({
  appVersion: z.string().min(1),
  apiVersion: z.literal(SYSTEM_API_VERSION),
  storageReady: z.boolean(),
});

export type SystemPingOutput = z.infer<typeof systemPingOutputSchema>;

/**
 * One app-local completion bit; neither command accepts a caller-selected key.
 */
export const onboardingStatusInputSchema = z.object({}).strict();

export const onboardingStatusOutputSchema = z
  .object({ completed: z.boolean() })
  .strict();

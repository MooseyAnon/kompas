import type { z } from 'zod';
import type { generationEventMessageSchema } from '../../../shared/contracts/inference-worker';

/** Payload of a `generation.event` transport message (discriminated by eventKind). */
export type GenerationEventMessageSchemaPayload = z.infer<
  typeof generationEventMessageSchema
>['payload'];

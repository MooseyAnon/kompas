import type { ZodType } from 'zod';
import {
  DEFAULT_ERROR_MESSAGES,
  MAX_PAYLOAD_BYTES,
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  type ErrorCode,
  type FailureEnvelope,
  type RequestEnvelope,
  type ResponseEnvelope,
} from '../../shared/contracts';
import { AppError, isAppError } from './errors';

export interface RequestContext {
  correlationId: string;

  module: string;

  action: string;
}

export interface CommandDefinition<I = unknown, O = unknown> {
  input: ZodType<I>;

  output: ZodType<O>;

  handle: (input: I, ctx: RequestContext) => O | Promise<O>;
}

/**
 * Identity helper that preserves a command's precise input/output types at the
 * definition site while erasing them to the registry's `CommandDefinition`
 * shape, so handlers receive typed (already-validated) input.
 */
export function defineCommand<I, O>(
  definition: CommandDefinition<I, O>,
): CommandDefinition {
  return definition as unknown as CommandDefinition;
}

export interface ModuleManifest {
  id: string;

  apiMajor: number;

  commands: Record<string, CommandDefinition>;
}

/** Internal failure logger; must never receive user content, only safe metadata. */
export type FailureLogger = (info: {
  correlationId: string;
  module: string;
  action: string;
  code: ErrorCode;
}) => void;

export interface Dispatcher {
  dispatch(raw: unknown): Promise<ResponseEnvelope>;

  has(module: string, action: string, version: number): boolean;

  listCommands(): Array<{ module: string; version: number; action: string }>;
}

type FailureHandler = (
  context: RequestContext,
  code: ErrorCode,
  message?: string,
) => FailureEnvelope;

function generateId(): string {
  return globalThis.crypto.randomUUID();
}

/** Derive a UUID correlation id, reusing a valid incoming requestId when present. */
export function coerceCorrelationId(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || !('requestId' in raw)) {
    return generateId();
  }

  const candidate = raw.requestId;

  if (typeof candidate === 'string') {
    const parsed = requestEnvelopeSchema.shape.requestId.safeParse(candidate);

    if (parsed.success) {
      return candidate;
    }
  }

  return generateId();
}

export function buildFailure(
  correlationId: string,
  code: ErrorCode,
  message?: string,
): FailureEnvelope {
  return {
    requestId: correlationId,
    ok: false,
    error: {
      code,
      message: message ?? DEFAULT_ERROR_MESSAGES[code],
      correlationId,
    },
  };
}

function serialisedByteLength(value: unknown): number {
  const json = JSON.stringify(value ?? {});

  return Buffer.byteLength(json ?? 'null', 'utf8');
}

function createModuleRegistry(
  modules: ModuleManifest[],
): Map<string, ModuleManifest> {
  const registry = new Map<string, ModuleManifest>();

  for (const module of modules) {
    if (registry.has(module.id)) {
      throw new Error(`Duplicate module id in registry: ${module.id}`);
    }

    registry.set(module.id, module);
  }

  return registry;
}

function validateCommandResponse(
  command: CommandDefinition,
  output: unknown,
  context: RequestContext,
  fail: FailureHandler,
): ResponseEnvelope {
  const parsedOutput = command.output.safeParse(output);

  if (!parsedOutput.success) {
    // Output contract violated: a programming error, never leak details.
    return fail(context, 'INTERNAL');
  }

  const response: ResponseEnvelope = {
    requestId: context.correlationId,
    ok: true,
    data: parsedOutput.data,
  };

  // Defensively validate the outgoing envelope before it crosses the boundary.
  const parsedResponse = responseEnvelopeSchema.safeParse(response);

  if (!parsedResponse.success) {
    return fail(context, 'INTERNAL');
  }

  return response;
}

async function executeCommand(
  command: CommandDefinition,
  payload: unknown,
  context: RequestContext,
  fail: FailureHandler,
): Promise<ResponseEnvelope> {
  if (serialisedByteLength(payload) > MAX_PAYLOAD_BYTES) {
    return fail(context, 'INVALID_INPUT', 'The request payload is too large.');
  }

  const parsedInput = command.input.safeParse(payload);

  if (!parsedInput.success) {
    return fail(context, 'INVALID_INPUT');
  }

  let output: unknown;

  // Only handler failures are mapped; validation and logger exceptions propagate.
  try {
    output = await command.handle(parsedInput.data, context);
  } catch (error) {
    if (isAppError(error)) {
      return fail(context, error.code, error.safeMessage);
    }

    return fail(context, 'INTERNAL');
  }

  return validateCommandResponse(command, output, context, fail);
}

function dispatchRequest(
  envelope: RequestEnvelope,
  registry: Map<string, ModuleManifest>,
  fail: FailureHandler,
): ResponseEnvelope | Promise<ResponseEnvelope> {
  const context: RequestContext = {
    correlationId: envelope.requestId,
    module: envelope.module,
    action: envelope.action,
  };

  const module = registry.get(envelope.module);

  if (!module) {
    return fail(context, 'NOT_FOUND');
  }

  if (module.apiMajor !== envelope.version) {
    return fail(context, 'VERSION_UNSUPPORTED');
  }

  const command = module.commands[envelope.action];

  if (!command) {
    return fail(context, 'NOT_FOUND');
  }

  // Keep routing metadata independent of the mutable context given to handlers.
  const failCommand: FailureHandler = (requestContext, code, message) =>
    fail(
      {
        correlationId: requestContext.correlationId,
        module: envelope.module,
        action: envelope.action,
      },
      code,
      message,
    );

  return executeCommand(command, envelope.payload, context, failCommand);
}

/** Build a versioned command dispatcher with validated inputs and outputs. */
export function createDispatcher(
  modules: ModuleManifest[],
  options: { logFailure?: FailureLogger } = {},
): Dispatcher {
  const registry = createModuleRegistry(modules);
  const logFailure: FailureLogger = options.logFailure ?? (() => {});

  function fail(
    context: RequestContext,
    code: ErrorCode,
    message?: string,
  ): FailureEnvelope {
    const { correlationId, module, action } = context;
    logFailure({ correlationId, module, action, code });

    return buildFailure(correlationId, code, message);
  }

  async function dispatch(raw: unknown): Promise<ResponseEnvelope> {
    const correlationId = coerceCorrelationId(raw);
    const parsedEnvelope = requestEnvelopeSchema.safeParse(raw);

    if (!parsedEnvelope.success) {
      return fail(
        { correlationId, module: 'unknown', action: 'unknown' },
        'INVALID_INPUT',
      );
    }

    return dispatchRequest(parsedEnvelope.data, registry, fail);
  }

  function has(moduleId: string, action: string, version: number): boolean {
    const module = registry.get(moduleId);

    return Boolean(
      module && module.apiMajor === version && action in module.commands,
    );
  }

  function listCommands(): Array<{
    module: string;
    version: number;
    action: string;
  }> {
    const commands: Array<{ module: string; version: number; action: string }> =
      [];

    for (const module of registry.values()) {
      for (const action of Object.keys(module.commands)) {
        commands.push({ module: module.id, version: module.apiMajor, action });
      }
    }

    return commands;
  }

  return { dispatch, has, listCommands };
}

export { AppError };

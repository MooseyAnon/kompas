import {
  FORBIDDEN_JSON_KEYS,
  TOOL_LIMITS,
  type InferenceErrorCode,
  type JsonValue,
  type ToolDefinition,
  type ToolEffect,
  type ToolInvocation,
  type ToolPolicy,
  type ToolResult,
} from '../../../shared/contracts';
import type { TelemetryService } from '../../modules/telemetry/telemetry.service';
import type { ToolRegistry } from './tool-registry';
import { toToolDefinition, type RegisteredTool } from './tool-types';

/** Trusted, deliberate per-call approval for write/external-action tools. */
export type ToolApprovalHandler = (request: {
  runId: string;

  toolName: string;

  effect: ToolEffect;
}) => boolean | Promise<boolean>;

export interface OpenRunInput {
  runId: string;

  callerModule: string;

  contextId?: string;

  /** Tools the caller explicitly selected for this run. */
  requestedToolNames?: string[];

  policy?: Partial<ToolPolicy>;

  approvalHandler?: ToolApprovalHandler;
}

export interface OpenRunResult {
  definitions: ToolDefinition[];

  policy: ToolPolicy;
}

/** Narrow capability the worker supervisor depends on to run a proposed call. */
export interface ToolExecutor {
  execute(runId: string, invocation: ToolInvocation): Promise<ToolResult>;
}

interface RunContext {
  runId: string;

  callerModule: string;

  contextId?: string;

  allowedToolNames: Set<string>;

  policy: ToolPolicy;

  approvalHandler?: ToolApprovalHandler;

  totalCalls: number;

  perTool: Map<string, number>;
}

interface ToolRejection {
  code: InferenceErrorCode;

  message: string;
}

interface ValidatedToolData {
  data: unknown;
}

const TIMEOUT = Symbol('tool-timeout');
const MAX_TELEMETRY_TOOL_NAME_LENGTH = 80;

/**
 * The application core's tool broker. It is the single main-process authority
 * for tool authorisation and execution. Registration never grants authority;
 * the broker validates the run, allowlist, ownership, version, permission,
 * arguments and output on *every* call, then dispatches to the owning module's
 * in-process handler. Provider-proposed names and arguments are untrusted;
 * anything unrecognised, disallowed, malformed or oversized fails closed
 * without invoking a handler.
 */
export class ToolBroker implements ToolExecutor {
  private readonly registry: ToolRegistry;

  private readonly telemetry?: TelemetryService;

  private readonly now: () => number;

  private readonly runs = new Map<string, RunContext>();

  constructor(options: {
    registry: ToolRegistry;

    telemetry?: TelemetryService;

    now?: () => number;
  }) {
    this.registry = options.registry;
    this.telemetry = options.telemetry;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Open a bounded run and resolve the model-facing tool definitions. The
   * returned set is the intersection of the caller's explicit request with the
   * tools the registry authorises for that caller — a registered tool is never
   * made available implicitly.
   */
  openRun(input: OpenRunInput): OpenRunResult {
    const caller = {
      callerModule: input.callerModule,
      contextId: input.contextId,
    };
    const allowedByPolicy = new Map(
      this.registry
        .listAll()
        .filter((tool) => this.registry.isAllowedFor(tool, caller))
        .map((tool) => [tool.name, tool]),
    );
    const requested = input.requestedToolNames ?? [];
    const selected = new Set<string>();
    const definitions: ToolDefinition[] = [];

    for (const name of requested) {
      const tool = allowedByPolicy.get(name);

      if (tool && !selected.has(name)) {
        selected.add(name);
        definitions.push(toToolDefinition(tool));
      }
    }

    const policy = resolvePolicy(input.policy);
    this.runs.set(input.runId, {
      runId: input.runId,
      callerModule: input.callerModule,
      contextId: input.contextId,
      allowedToolNames: selected,
      policy,
      approvalHandler: input.approvalHandler,
      totalCalls: 0,
      perTool: new Map(),
    });

    return { definitions, policy };
  }

  /** Whether a run currently has any authorised tools. */
  runHasTools(runId: string): boolean {
    return (this.runs.get(runId)?.allowedToolNames.size ?? 0) > 0;
  }

  closeRun(runId: string): void {
    this.runs.delete(runId);
  }

  async execute(
    runId: string,
    invocation: ToolInvocation,
  ): Promise<ToolResult> {
    const startedMs = this.now();
    const run = this.runs.get(runId);
    const toolName = invocation.toolName;
    const deny = (code: InferenceErrorCode, message: string): ToolResult =>
      this.fail(runId, invocation, code, message, startedMs);

    if (!run) {
      return deny('TOOL_NOT_ALLOWED', 'No active tool run for this request.');
    }

    const authorization = this.authorizeTool(run, toolName, invocation);

    if ('code' in authorization) {
      return deny(authorization.code, authorization.message);
    }

    const { tool } = authorization;

    // Permission: read+automatic may run; anything else needs trusted approval.
    const automatic = tool.permission === 'automatic' && tool.effect === 'read';

    if (!automatic) {
      const approved = run.approvalHandler
        ? await safeApprove(run.approvalHandler, {
            runId,
            toolName,
            effect: tool.effect,
          })
        : false;

      if (!approved) {
        return deny(
          'TOOL_NOT_ALLOWED',
          'That tool requires explicit approval.',
        );
      }
    }

    // Invalid arguments still consume budget, after trusted approval succeeds.
    if (!this.consumeCallBudget(run, tool, toolName)) {
      return deny('LIMIT_EXCEEDED', 'The tool-call budget was exhausted.');
    }

    const args = validateArguments(tool, invocation.arguments);

    if ('code' in args) {
      return deny(args.code, args.message);
    }

    // Execute the owning module's handler under a hard deadline.
    let raw: unknown;

    try {
      raw = await this.runWithTimeout(
        () =>
          tool.handle(args.data, {
            runId,
            callerModule: run.callerModule,
            contextId: run.contextId,
          }),
        tool.timeoutMs,
      );
    } catch (error) {
      if (error === TIMEOUT) {
        return deny('TOOL_TIMEOUT', 'The tool timed out.');
      }

      return deny('TOOL_FAILED', 'The tool failed to execute.');
    }

    const output = validateOutput(tool, raw);

    if ('code' in output) {
      return deny(output.code, output.message);
    }

    this.record(tool, 'success', null, this.now() - startedMs, runId);

    return {
      toolCallId: invocation.toolCallId,
      toolName,
      ok: true,
      data: output.data,
      durationMs: Math.max(0, this.now() - startedMs),
    };
  }

  private authorizeTool(
    run: RunContext,
    toolName: string,
    invocation: ToolInvocation,
  ): { tool: RegisteredTool } | ToolRejection {
    if (!run.allowedToolNames.has(toolName)) {
      return {
        code: 'TOOL_NOT_ALLOWED',
        message: 'That tool is not allowed in this run.',
      };
    }

    const tool = this.registry.get(toolName);

    if (!tool) {
      return {
        code: 'TOOL_NOT_ALLOWED',
        message: 'That tool is not registered.',
      };
    }

    if (tool.version !== invocation.version) {
      return { code: 'TOOL_NOT_ALLOWED', message: 'Tool version mismatch.' };
    }

    if (tool.permission === 'disabled') {
      return { code: 'TOOL_NOT_ALLOWED', message: 'That tool is disabled.' };
    }

    return { tool };
  }

  private consumeCallBudget(
    run: RunContext,
    tool: RegisteredTool,
    toolName: string,
  ): boolean {
    const used = run.perTool.get(toolName) ?? 0;
    const perToolCap = Math.min(
      run.policy.maxCallsPerTool,
      tool.maxCallsPerRun,
    );

    if (run.totalCalls >= run.policy.maxToolCalls || used >= perToolCap) {
      return false;
    }

    run.totalCalls += 1;
    run.perTool.set(toolName, used + 1);

    return true;
  }

  private fail(
    runId: string,
    invocation: ToolInvocation,
    code: InferenceErrorCode,
    message: string,
    startedMs: number,
  ): ToolResult {
    const tool = this.registry.get(invocation.toolName);
    this.record(
      tool ?? { ownerModule: 'inference', effect: 'read' },
      'failure',
      code,
      this.now() - startedMs,
      runId,
      invocation.toolName,
    );

    return {
      toolCallId: invocation.toolCallId,
      toolName: invocation.toolName,
      ok: false,
      error: { code, message },
      durationMs: Math.max(0, this.now() - startedMs),
    };
  }

  private record(
    tool: Pick<RegisteredTool, 'ownerModule' | 'effect'> & { name?: string },
    outcome: 'success' | 'failure',
    errorCode: string | null,
    durationMs: number,
    runId: string,
    fallbackName?: string,
  ): void {
    this.telemetry?.record({
      moduleId: tool.ownerModule,
      operation: 'tool.execute',
      outcome,
      durationMs: Math.max(0, durationMs),
      errorCode,
      correlationId: runId,
      detail: {
        toolName: (tool.name ?? fallbackName ?? 'unknown').slice(
          0,
          MAX_TELEMETRY_TOOL_NAME_LENGTH,
        ),
        effect: tool.effect,
        ok: outcome === 'success',
      },
    });
  }

  private runWithTimeout<T>(fn: () => Promise<T> | T, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(TIMEOUT);
        }
      }, ms);

      Promise.resolve()
        .then(fn)
        .then(
          (value) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(value);
            }
          },
          (error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(error);
            }
          },
        );
    });
  }
}

function resolvePolicy(policy: Partial<ToolPolicy> | undefined): ToolPolicy {
  const maxSteps = clamp(
    policy?.maxSteps ?? TOOL_LIMITS.defaultMaxSteps,
    1,
    TOOL_LIMITS.hardMaxSteps,
  );
  const maxToolCalls = clamp(
    policy?.maxToolCalls ?? TOOL_LIMITS.defaultMaxToolCalls,
    1,
    TOOL_LIMITS.hardMaxToolCalls,
  );
  const maxCallsPerTool = clamp(
    policy?.maxCallsPerTool ?? TOOL_LIMITS.defaultMaxCallsPerTool,
    1,
    TOOL_LIMITS.defaultMaxCallsPerTool,
  );

  return { maxSteps, maxToolCalls, maxCallsPerTool };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function safeApprove(
  handler: ToolApprovalHandler,
  request: { runId: string; toolName: string; effect: ToolEffect },
): Promise<boolean> {
  try {
    return (await handler(request)) === true;
  } catch {
    return false;
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Validate untrusted arguments in size, forbidden-key, then schema order. */
function validateArguments(
  tool: RegisteredTool,
  args: unknown,
): ValidatedToolData | ToolRejection {
  if (byteLength(safeStringify(args)) > TOOL_LIMITS.maxArgBytes) {
    return {
      code: 'TOOL_INVALID_ARGUMENTS',
      message: 'Tool arguments were too large.',
    };
  }

  if (hasForbiddenKeys(args)) {
    return {
      code: 'TOOL_INVALID_ARGUMENTS',
      message: 'Tool arguments were rejected.',
    };
  }

  const parsed = tool.inputSchema.safeParse(args);

  if (!parsed.success) {
    return {
      code: 'TOOL_INVALID_ARGUMENTS',
      message: 'Tool arguments were invalid.',
    };
  }

  return { data: parsed.data };
}

function validateOutput(
  tool: RegisteredTool,
  raw: unknown,
): { data: JsonValue } | ToolRejection {
  const parsed = tool.outputSchema.safeParse(raw);

  if (!parsed.success) {
    return {
      code: 'TOOL_FAILED',
      message: 'The tool returned an invalid result.',
    };
  }

  const data = parsed.data as JsonValue;

  if (byteLength(safeStringify(data)) > tool.maxResultBytes) {
    return {
      code: 'TOOL_FAILED',
      message: 'The tool result exceeded its size budget.',
    };
  }

  return { data };
}

function hasForbiddenKeys(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasForbiddenKeys);
  }

  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_JSON_KEYS.includes(key)) {
        return true;
      }

      if (hasForbiddenKeys((value as Record<string, unknown>)[key])) {
        return true;
      }
    }
  }

  return false;
}

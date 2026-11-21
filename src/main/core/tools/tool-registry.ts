import {
  TOOL_LIMITS,
  TOOL_NAME_PATTERN,
  type ToolDefinition,
} from '../../../shared/contracts';
import {
  toToolDefinition,
  type RegisteredTool,
  type ToolCallerContext,
  type ToolRegistration,
} from './tool-types';

const MAX_DESCRIPTION_LENGTH = 500;

function validateRegistration(
  tool: ToolRegistration,
  registeredTools: Map<string, RegisteredTool>,
): void {
  if (!TOOL_NAME_PATTERN.test(tool.name)) {
    throw new Error(`Invalid tool name: ${tool.name}`);
  }

  if (!Number.isInteger(tool.version) || tool.version < 1) {
    throw new Error(`Invalid tool version for ${tool.name}`);
  }

  if (registeredTools.has(tool.name)) {
    throw new Error(`Duplicate tool registration: ${tool.name}`);
  }

  if (tool.ownerModule.length === 0) {
    throw new Error(`Tool ${tool.name} must declare an owner module`);
  }

  const invalidDescription =
    tool.description.length === 0 ||
    tool.description.length > MAX_DESCRIPTION_LENGTH;

  if (invalidDescription) {
    throw new Error(`Tool ${tool.name} has an invalid description`);
  }

  validateToolBudgets(tool);
}

function validateToolBudgets(tool: ToolRegistration): void {
  if (
    !Number.isInteger(tool.timeoutMs) ||
    tool.timeoutMs < 1 ||
    tool.timeoutMs > TOOL_LIMITS.maxTimeoutMs
  ) {
    throw new Error(`Tool ${tool.name} has an invalid timeout`);
  }

  if (
    !Number.isInteger(tool.maxResultBytes) ||
    tool.maxResultBytes < 1 ||
    tool.maxResultBytes > TOOL_LIMITS.maxResultBytes
  ) {
    throw new Error(`Tool ${tool.name} has an invalid result budget`);
  }

  if (!Number.isInteger(tool.maxCallsPerRun) || tool.maxCallsPerRun < 1) {
    throw new Error(`Tool ${tool.name} has an invalid per-run call budget`);
  }
}

/**
 * Static, startup-time registry of module-owned tools. Registration is explicit
 * and deterministic (no scanning or dynamic marketplace). The registry enforces
 * stable namespaced names, positive integer versions, bounded budgets and name
 * uniqueness. It never grants authority: discovery and execution are gated
 * separately by the {@link ToolBroker}.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /** Register one tool. Throws on malformed input or a duplicate name. */
  register(registration: ToolRegistration): void {
    validateRegistration(registration, this.tools);
    this.tools.set(registration.name, registration);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /** Internal descriptors for registration checks/debugging — not a model menu. */
  listAll(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  /** Whether a caller is authorised to discover/use a tool (default-deny). */
  isAllowedFor(tool: RegisteredTool, caller: ToolCallerContext): boolean {
    if (tool.permission === 'disabled') {
      return false;
    }

    if (tool.ownerModule === caller.callerModule) {
      return true;
    }

    const contexts = tool.allowlistContexts;

    if (!contexts || contexts.length === 0) {
      return false; // no wildcard default
    }

    if (contexts.includes(caller.callerModule)) {
      return true;
    }

    return (
      caller.contextId !== undefined && contexts.includes(caller.contextId)
    );
  }

  /** Only the definitions a caller is authorised to use for this operation. */
  listAllowed(caller: ToolCallerContext): ToolDefinition[] {
    return this.listAll()
      .filter((tool) => this.isAllowedFor(tool, caller))
      .map(toToolDefinition);
  }
}

import type {
  InferenceError,
  JsonValue,
  ModelDescriptor,
  ProviderCapabilities,
  ToolCall,
} from '../../../shared/contracts';
import type {
  ProviderGenerateControls,
  ProviderGenerateOutcome,
  ProviderGenerateRequest,
  ProviderStatusObservation,
  WorkerProvider,
} from './provider';

export const MOCK_PROVIDER_ID = 'mock';

/** Deterministic model identifiers understood by the mock provider. */
export const MOCK_MODELS = {
  static: 'mock-static',
  json: 'mock-json',
  slow: 'mock-slow',
  faultError: 'mock-fault-error',
  faultInvalidJson: 'mock-fault-invalid-json',
  /** Dev/smoke-only: returns a valid interview-question structured output. */
  interview: 'mock-interview',
  cv: 'mock-cv',
  summary: 'mock-summary',
  /** Test-only: streams reasoning (unless thinking is off) before an echo answer. */
  thinking: 'mock-thinking',
  /** Handled by the worker *entry* (real process exit); not by this adapter. */
  faultCrash: 'mock-fault-crash',
  /** Tool-exercising models (dev/test only); drive the bounded tool loop. */
  toolsAdd: 'mock-tools-add',
  toolsMulti: 'mock-tools-multi',
  toolsUnknown: 'mock-tools-unknown',
  toolsBadArgs: 'mock-tools-bad-args',
  toolsLoop: 'mock-tools-loop',
  toolsWrite: 'mock-tools-write',
  toolsSlow: 'mock-tools-slow',
  toolsUnsupported: 'mock-tools-unsupported',
} as const;

type ProviderMessages = ProviderGenerateRequest['messages'];

type Usage = Extract<ProviderGenerateOutcome, { status: 'completed' }>['usage'];

interface ProposedCall {
  toolName: string;
  args: JsonValue;
}

const MOCK_CAPABILITIES: ProviderCapabilities = {
  text: 'supported',
  streaming: 'supported',
  structuredOutput: 'supported',
  tools: 'unsupported',
};

const EMPTY_USAGE: NonNullable<Usage> = {
  inputTokens: null,
  outputTokens: null,
  durationMs: null,
};

const TOOLS_MODEL_PREFIX = 'mock-tools-';

/** Streamed answers are split into chunks of this many characters. */
const ANSWER_CHUNK_CHARS = 4;

const THINKING_CHUNK_CHARS = 5;

/** Per-chunk streaming delay; gives cancellation a chance between chunks. */
const STREAM_TICK_MS = 1;

/** The slow model waits this long, expecting to be cancelled or timed out. */
const SLOW_MODEL_WAIT_MS = 60_000;

const DEFAULT_CRITERION_IDS = ['accuracy', 'reasoning', 'relevance'];

/** Reassessment questions are drawn this far ahead of the normal sequence. */
const REASSESSMENT_SCENARIO_OFFSET = 7;

const EXCLUDED_QUESTIONS_MARKER = '## Questions already asked';

const FOLLOW_UP_MARKER = '## Original question';

const REASSESSMENT_MARKER = 'materially different scenario';

/** Dev/smoke-only: a distinct, schema-valid interview question per index. */
const MOCK_QUESTION_SCENARIOS = [
  'design a reliable process for a recurring task in this subject, ' +
    'and explain the key trade-offs you would weigh',
  'diagnose a sudden drop in quality for this subject, ' +
    'and outline how you would isolate the root cause',
  'plan how you would onboard a newcomer to this subject, ' +
    'prioritising what they must learn first',
  'evaluate two competing approaches in this subject, ' +
    'and defend which you would adopt and why',
  'describe how you would measure success for an initiative in this ' +
    'subject, including leading indicators',
  'walk through how you would recover from a significant mistake in this ' +
    'subject without losing trust',
  'explain how you would scale an approach in this subject as demand ' +
    'grows tenfold',
  'identify the biggest risk in a typical project for this subject, ' +
    'and how you would mitigate it',
  'compare short-term and long-term trade-offs for a decision in this ' +
    'subject',
  'outline how you would validate correctness before and after a change ' +
    'in this subject',
  'describe how you would prioritise competing requests in this subject ' +
    'under a tight deadline',
  'explain how you would communicate a difficult trade-off in this ' +
    'subject to a non-expert',
];

/** Fixture satisfying the stage's structured-output test schema. */
const STRUCTURED_FIXTURE: JsonValue = {
  title: 'Mock structured result',
  score: 7,
  ready: true,
  tags: ['alpha', 'beta'],
};

const MOCK_STRENGTHS = ['Attempts to address the question'];

const MOCK_GAPS = ['Needs clearer reasoning and specific trade-offs'];

// --- prompt inspection ------------------------------------------------------

function lastUserContent(messages: ProviderMessages): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') {
      return messages[i].content;
    }
  }

  return '';
}

function joinedContent(messages: ProviderMessages): string {
  return messages.map((m) => m.content).join('\n');
}

/**
 * Dev/smoke-only: recover the frozen bar's criterion ids from the reviewer
 * prompt (lines of the form `- id "accuracy" — ...`) so the mock review scores
 * exactly the requested ids. Falls back to the default provisional-bar ids.
 */
function extractCriterionIds(messages: ProviderMessages): string[] {
  const text = joinedContent(messages);
  const ids: string[] = [];
  const pattern = /id "([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    ids.push(match[1]);
  }

  return ids.length > 0 ? ids : DEFAULT_CRITERION_IDS;
}

/** Count the prior questions listed in a generation prompt's exclude block. */
function countExcludedQuestions(messages: ProviderMessages): number {
  const text = joinedContent(messages);
  const start = text.indexOf(EXCLUDED_QUESTIONS_MARKER);
  if (start === -1) {
    return 0;
  }

  const lines = text
    .slice(start + EXCLUDED_QUESTIONS_MARKER.length)
    .split('\n');
  let count = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('##')) {
      break;
    }

    if (trimmed.startsWith('- ') && trimmed !== '- none') {
      count += 1;
    }
  }

  return count;
}

// --- structured outputs -----------------------------------------------------

function interviewQuestionVariant(index: number): JsonValue {
  const scenario =
    MOCK_QUESTION_SCENARIOS[index % MOCK_QUESTION_SCENARIOS.length];

  return {
    question: `Question ${index + 1}: describe how you would ${scenario}.`,
    competency: 'structured problem solving',
    intent:
      'Assess the ability to reason about the subject and explain trade-offs.',
    criteria: [
      'Identifies the main requirements and failure modes',
      'Explains relevant trade-offs clearly and concretely',
    ],
    pitfalls: ['A vague answer with no concrete choices'],
    difficultyRationale:
      'Calibrated to a provisional general-practice benchmark.',
    sourceBasis: 'approved_target_and_model_general_knowledge',
  };
}

function interviewFollowUpOutput(joined: string): JsonValue {
  const probe = joined.includes('trade-off')
    ? 'Which single trade-off from your answer would you reconsider first, ' +
      'and what would change your mind?'
    : 'What concrete example from your experience best supports the ' +
      'approach you just described?';

  return {
    question: `Building on your answer: ${probe}`,
    competency: 'structured problem solving',
    intent: 'Probe the depth of reasoning behind the candidate answer.',
    criteria: ['Gives a concrete, specific justification'],
    pitfalls: ['Repeating the original answer without adding depth'],
    difficultyRationale: 'A single probing follow-up.',
    sourceBasis: 'model_general_knowledge',
  };
}

/**
 * Question schema (007.1 generation, 007.2 reassessment and 007.3 quick-fire
 * / deep-loop / follow-up). Varies the output so the interactive runner's
 * distinctness guard is satisfied across many questions without a real model.
 */
function interviewQuestionOutput(messages: ProviderMessages): JsonValue {
  const joined = joinedContent(messages);
  if (joined.includes(FOLLOW_UP_MARKER)) {
    return interviewFollowUpOutput(joined);
  }

  const offset = joined.includes(REASSESSMENT_MARKER)
    ? REASSESSMENT_SCENARIO_OFFSET
    : 0;

  return interviewQuestionVariant(countExcludedQuestions(messages) + offset);
}

/** Reviewer schema (007.2): a deterministic below-bar assessment. */
function reviewOutput(messages: ProviderMessages): JsonValue {
  const criterionIds = extractCriterionIds(messages);

  return {
    criterionIds,
    scores: criterionIds.map(() => 40),
    evidence: criterionIds.map(() => ''),
    rationales: criterionIds.map(
      () => 'The answer lacks concrete, well-justified detail.',
    ),
    strengths: MOCK_STRENGTHS,
    gaps: MOCK_GAPS,
    needsMoreEvidence: false,
  };
}

function synthesisOutput(): JsonValue {
  return {
    strengths: MOCK_STRENGTHS,
    gaps: MOCK_GAPS,
    recommendations: ['Practise explaining trade-offs with concrete examples'],
  };
}

/** Coaching schema (007.2). */
function coachingOutput(): JsonValue {
  return {
    diagnosis:
      'The answer identifies the task but does not justify the key ' +
      'trade-offs.',
    advice: [
      'State the main requirements explicitly before proposing a design.',
      'Name at least two concrete trade-offs and why you chose one.',
    ],
    workedExample:
      'A stronger answer would list the failure modes, then weigh ' +
      'reliability against cost with a concrete choice.',
    reassessmentFocus: 'Justifying trade-offs with concrete reasoning',
  };
}

/**
 * Packaged Discovery acceptance: evidence is present in the smoke-only Acme
 * page. The domain still validates every field against that capture.
 */
function jobDescriptionOutput(): JsonValue {
  const field = (text: string) => ({ text, evidence: text });
  const absentInference = () => ({ value: '', evidence: '', reason: '' });

  return {
    schemaVersion: 1,
    classification: 'job_description',
    title: field('Software Intern'),
    company: field('Acme'),
    location: field('London'),
    responsibilities: [field('developing software')],
    requiredSkills: [field('TypeScript')],
    preferredSkills: [],
    educationRequirements: [],
    minimumYearsExperience: field(''),
    seniority: absentInference(),
    estimatedExperienceBand: absentInference(),
    employmentType: field(''),
    workArrangement: field(''),
    salaryText: field(''),
    inferences: [],
  };
}

/** A CV extraction restricted to the fields the caller's schema declares. */
function cvOutput(
  messages: ProviderMessages,
  schemaProperties: Record<string, unknown>,
): JsonValue {
  const source = lastUserContent(messages);
  const knownNames = ['Smoke Tester', 'Docx Tester'];
  const name = knownNames.find((known) => source.includes(known)) ?? null;
  const fields: Record<string, JsonValue> = {
    name,
    email: null,
    phoneNumber: null,
    location: null,
    summary: null,
    experience: [],
    skills: [],
    education: [],
    projects: [],
    inferences: [],
  };

  return Object.fromEntries(
    Object.entries(fields).filter(([key]) =>
      Object.hasOwn(schemaProperties, key),
    ),
  );
}

// --- streaming helpers ------------------------------------------------------

function chunk(text: string, size: number): string[] {
  if (text.length === 0) {
    return [];
  }

  const parts: string[] = [];
  for (let i = 0; i < text.length; i += size) {
    parts.push(text.slice(i, i + size));
  }

  return parts;
}

/** Abortable delay. Resolves `true` if aborted during the wait. */
function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(false);
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Stream `text` in fixed-size chunks with a tick before each one. Resolves
 * `true` if the signal aborted at any point (including after the last chunk).
 */
async function streamChunks(
  text: string,
  size: number,
  signal: AbortSignal,
  emit: (part: string) => void,
): Promise<boolean> {
  for (const part of chunk(text, size)) {
    if (await abortableDelay(STREAM_TICK_MS, signal)) {
      return true;
    }
    emit(part);
  }

  return false;
}

/** Emit a structured output as one delta with no delay. */
function completeImmediately(
  output: JsonValue,
  controls: ProviderGenerateControls,
): ProviderGenerateOutcome {
  if (controls.signal.aborted) {
    return { status: 'cancelled' };
  }

  controls.onDelta(JSON.stringify(output));

  return { status: 'completed', output, usage: null };
}

/** Wait one tick, then emit a structured output as one delta. */
async function completeAfterTick(
  output: JsonValue,
  controls: ProviderGenerateControls,
  usage: Usage = null,
): Promise<ProviderGenerateOutcome> {
  const { signal, onDelta } = controls;
  if (await abortableDelay(STREAM_TICK_MS, signal)) {
    return { status: 'cancelled' };
  }

  onDelta(JSON.stringify(output));
  if (signal.aborted) {
    return { status: 'cancelled' };
  }

  return { status: 'completed', output, usage };
}

function failure(
  code: InferenceError['code'],
  message: string,
): ProviderGenerateOutcome {
  return { status: 'failed', error: { code, message } };
}

function mockModel(id: string, displayName: string): ModelDescriptor {
  return {
    providerId: MOCK_PROVIDER_ID,
    id,
    displayName,
    locality: 'local',
    installed: true,
    sizeBytes: null,
    parameterSize: null,
    quantization: null,
    contextLength: null,
    capabilities: MOCK_CAPABILITIES,
  };
}

function schemaPropertiesOf(
  req: ProviderGenerateRequest,
): Record<string, unknown> | null {
  return req.responseFormat?.type === 'json_schema'
    ? req.responseFormat.schema.properties
    : null;
}

/**
 * Deterministic, dev/test-only provider that exercises the full worker boundary
 * without any real model, download or network access. It supports streaming
 * deltas, structured output, controlled failures and cancellation. It never
 * claims real-model capabilities and is not offered for ordinary end-user model
 * selection (registered only behind an explicit dev/smoke flag).
 */
export class MockProvider implements WorkerProvider {
  readonly id = MOCK_PROVIDER_ID;

  status(): ProviderStatusObservation {
    return {
      state: 'ready',
      capabilities: MOCK_CAPABILITIES,
      runtimeVersion: 'mock-1',
    };
  }

  /**
   * Report the deterministic static model as an installed local model. The mock
   * provider is only ever registered behind the dev/smoke flag, so this is never
   * offered for ordinary end-user selection; it lets the connectivity-test path
   * be exercised offline without any real runtime, download or network access.
   */
  async listModels(): Promise<ModelDescriptor[]> {
    return [
      mockModel(MOCK_MODELS.static, 'Mock static (local, dev only)'),
      mockModel(MOCK_MODELS.slow, 'Mock slow (local, dev only)'),
      mockModel(MOCK_MODELS.interview, 'Mock interview (local, dev only)'),
      mockModel(MOCK_MODELS.cv, 'Mock CV (local, dev only)'),
      mockModel(MOCK_MODELS.summary, 'Mock summary (local, dev only)'),
    ];
  }

  async getModelDetails(modelId: string) {
    const models = await this.listModels();
    if (!models.some((model) => model.id === modelId)) return null;

    return {
      maxContextTokens: 32_768,
      configuredContextTokens: 32_768,
      supportsContextOverride: true,
    };
  }

  async generate(
    req: ProviderGenerateRequest,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome> {
    const { modelId } = req;

    if (modelId === MOCK_MODELS.summary) {
      const summary = { summary: 'An analyst preparing for a science role.' };
      return completeImmediately(summary, controls);
    }

    if (modelId.startsWith(TOOLS_MODEL_PREFIX)) {
      return this.generateWithTools(req);
    }

    if (modelId === MOCK_MODELS.thinking) {
      return this.generateWithThinking(req, controls);
    }

    if (modelId === MOCK_MODELS.faultError) {
      return failure(
        'INVALID_RESPONSE',
        'The mock provider failed on request.',
      );
    }

    if (modelId === MOCK_MODELS.slow) {
      // Never completes on its own; waits to be cancelled or timed out.
      const aborted = await abortableDelay(SLOW_MODEL_WAIT_MS, controls.signal);
      return aborted
        ? { status: 'cancelled' }
        : failure('TIMEOUT', 'Timed out.');
    }

    const wantsJson =
      modelId === MOCK_MODELS.json ||
      req.responseFormat?.type === 'json_schema';
    if (wantsJson) {
      return this.generateJson(req, controls);
    }

    const isEchoModel =
      modelId === MOCK_MODELS.static ||
      modelId === MOCK_MODELS.faultInvalidJson;
    if (!isEchoModel) {
      return failure('MODEL_NOT_FOUND', 'Unknown mock model.');
    }

    return this.generateEcho(req, controls);
  }

  /** Stream `echo:<last user message>` in small chunks. */
  private async generateEcho(
    req: ProviderGenerateRequest,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome> {
    const prompt = lastUserContent(req.messages);
    const output = `echo:${prompt}`;

    const cancelled = await streamChunks(
      output,
      ANSWER_CHUNK_CHARS,
      controls.signal,
      controls.onDelta,
    );
    if (cancelled || controls.signal.aborted) {
      return { status: 'cancelled' };
    }

    return {
      status: 'completed',
      output,
      usage: {
        inputTokens: prompt.length,
        outputTokens: output.length,
        durationMs: null,
      },
    };
  }

  /**
   * Mirrors a reasoning model: reasoning streams first on its own channel, then
   * the answer. `thinking: false` suppresses reasoning, as Ollama's `think` does.
   */
  private async generateWithThinking(
    req: ProviderGenerateRequest,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome> {
    const { signal, onDelta, onThinkingDelta } = controls;

    if (req.thinking !== false) {
      const cancelled = await streamChunks(
        'mock reasoning',
        THINKING_CHUNK_CHARS,
        signal,
        (part) => onThinkingDelta?.(part),
      );
      if (cancelled) {
        return { status: 'cancelled' };
      }
    }

    const output = `echo:${lastUserContent(req.messages)}`;
    const cancelled = await streamChunks(
      output,
      ANSWER_CHUNK_CHARS,
      signal,
      onDelta,
    );
    if (cancelled || signal.aborted) {
      return { status: 'cancelled' };
    }

    return { status: 'completed', output, usage: null };
  }

  /**
   * Deterministic tool-loop behaviour for `mock-tools-*` models. On the first
   * turn it proposes fixed tool calls; once any tool result is present in the
   * conversation it finalises. It never executes tools itself — the worker and
   * main-process broker do that.
   */
  private generateWithTools(
    req: ProviderGenerateRequest,
  ): ProviderGenerateOutcome {
    if (req.modelId === MOCK_MODELS.toolsUnsupported) {
      // Honest refusal: a provider that cannot do tools never fabricates a call.
      return failure(
        'CAPABILITY_UNSUPPORTED',
        'The mock provider model does not support tools.',
      );
    }

    if (req.modelId === MOCK_MODELS.toolsLoop) {
      // Never finalises: forces the worker's step budget to terminate the run.
      return this.propose([
        { toolName: 'examples.add_numbers', args: { a: 1, b: 1 } },
      ]);
    }

    const priorResults = req.messages.filter((m) => m.role === 'tool');
    if (priorResults.length === 0) {
      const firstTurnCalls = firstTurnToolCalls(req.modelId);
      if (firstTurnCalls) {
        return this.propose(firstTurnCalls);
      }
    }

    return {
      status: 'completed',
      output: summariseToolResult(priorResults[0]?.content),
      usage: EMPTY_USAGE,
    };
  }

  private propose(calls: ProposedCall[]): ProviderGenerateOutcome {
    const toolCalls: ToolCall[] = calls.map((call) => ({
      toolCallId: globalThis.crypto.randomUUID(),
      toolName: call.toolName,
      arguments: call.args,
    }));

    return {
      status: 'tool_calls',
      toolCalls,
      assistantContent: null,
      usage: EMPTY_USAGE,
    };
  }

  private async generateJson(
    req: ProviderGenerateRequest,
    controls: ProviderGenerateControls,
  ): Promise<ProviderGenerateOutcome> {
    const schemaProps = schemaPropertiesOf(req);

    // Intentionally malformed structured output to exercise INVALID_SCHEMA.
    if (req.modelId === MOCK_MODELS.faultInvalidJson) {
      const bad: JsonValue = { note: 'missing required fields' };
      controls.onDelta(JSON.stringify(bad));
      if (controls.signal.aborted) {
        return { status: 'cancelled' };
      }

      return { status: 'completed', output: bad, usage: null };
    }

    const isJobDescriptionRequest =
      req.modelId === MOCK_MODELS.interview &&
      schemaProps !== null &&
      'requiredSkills' in schemaProps;
    if (isJobDescriptionRequest) {
      return completeImmediately(jobDescriptionOutput(), controls);
    }

    if (req.modelId === MOCK_MODELS.cv && schemaProps !== null) {
      return completeImmediately(cvOutput(req.messages, schemaProps), controls);
    }

    // Dev/smoke-only: lets the full renderer→worker→interviews-domain→DB path
    // run offline with no model.
    if (req.modelId === MOCK_MODELS.interview) {
      return completeAfterTick(
        interviewOutput(req.messages, schemaProps ?? {}),
        controls,
      );
    }

    // Downstream validation still enforces the caller's schema.
    return completeAfterTick(STRUCTURED_FIXTURE, controls, EMPTY_USAGE);
  }
}

/** Pick the interview output whose schema the request asks for. */
function interviewOutput(
  messages: ProviderMessages,
  schemaProps: Record<string, unknown>,
): JsonValue {
  // Reviewer output lets the smoke exercise review → coaching → reassessment.
  if ('criterionIds' in schemaProps && 'scores' in schemaProps) {
    return reviewOutput(messages);
  }

  if ('recommendations' in schemaProps && 'strengths' in schemaProps) {
    return synthesisOutput();
  }

  if ('diagnosis' in schemaProps && 'reassessmentFocus' in schemaProps) {
    return coachingOutput();
  }

  return interviewQuestionOutput(messages);
}

/** Fixed first-turn proposals per tools model; `null` means finalise. */
function firstTurnToolCalls(modelId: string): ProposedCall[] | null {
  switch (modelId) {
    case MOCK_MODELS.toolsAdd:
      return [{ toolName: 'examples.add_numbers', args: { a: 2, b: 3 } }];
    case MOCK_MODELS.toolsMulti:
      return [
        { toolName: 'examples.add_numbers', args: { a: 1, b: 1 } },
        { toolName: 'examples.add_numbers', args: { a: 2, b: 2 } },
      ];
    case MOCK_MODELS.toolsUnknown:
      return [{ toolName: 'examples.not_registered', args: {} }];
    case MOCK_MODELS.toolsBadArgs:
      return [{ toolName: 'examples.add_numbers', args: { a: 'x', b: 3 } }];
    case MOCK_MODELS.toolsWrite:
      return [{ toolName: 'examples.write_note', args: { note: 'remember' } }];
    case MOCK_MODELS.toolsSlow:
      return [{ toolName: 'examples.sleep', args: {} }];
    default:
      return null;
  }
}

/** Deterministic summary of the first tool result, used as the final answer. */
function summariseToolResult(content: unknown): string {
  const text = typeof content === 'string' ? content : '';

  try {
    const parsed = JSON.parse(text) as {
      ok?: boolean;
      data?: { sum?: number };
    };
    if (parsed.ok && typeof parsed.data?.sum === 'number') {
      return `sum=${parsed.data.sum}`;
    }

    if (parsed.ok === false) {
      return 'tool-denied';
    }
  } catch {
    // Unparseable results fall through to the generic summary.
  }

  return 'tools-done';
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OllamaProvider,
  isLoopbackEndpoint,
  OLLAMA_MESSAGE_CODES,
} from '../src/main/modules/inference/ollama-provider';
import { recommendOllamaModels } from '../src/main/modules/inference/ollama-recommend';
import { WorkerRuntime } from '../src/main/modules/inference/worker-runtime';
import type { WorkerToMainMessage } from '../src/shared/contracts/inference-worker';
import type { HardwareProfile, ModelDescriptor } from '../src/shared/contracts';
import type { ProviderGenerateControls } from '../src/main/modules/inference/provider';

type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void | Promise<void>;

interface FakeOllama {
  url: string;
  on: (route: string, handler: Handler) => void;
  close: () => Promise<void>;
}

const servers: FakeOllama[] = [];

async function createFakeOllama(): Promise<FakeOllama> {
  const handlers = new Map<string, Handler>();
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const key = `${req.method} ${path}`;
    const handler = handlers.get(key);
    if (handler) {
      void handler(req, res);
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const fake: FakeOllama = {
    url: `http://127.0.0.1:${port}`,
    on: (route, handler) => handlers.set(route, handler),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  servers.push(fake);
  return fake;
}

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

/** Bind then immediately release a port so connecting yields ECONNREFUSED. */
async function closedEndpoint(): Promise<string> {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(`http://127.0.0.1:${port}`));
    });
  });
}

function jsonRoute(body: unknown): Handler {
  return (_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
}

function collectControls(): {
  controls: ProviderGenerateControls;
  deltas: string[];
  thinking: string[];
  abort: AbortController;
} {
  const abort = new AbortController();
  const deltas: string[] = [];
  const thinking: string[] = [];
  const controls: ProviderGenerateControls = {
    signal: abort.signal,
    onDelta: (text) => deltas.push(text),
    onThinkingDelta: (text) => thinking.push(text),
  };
  return { controls, deltas, thinking, abort };
}

describe('Ollama endpoint safety', () => {
  it('accepts loopback endpoints only', () => {
    expect(isLoopbackEndpoint('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackEndpoint('http://localhost:11434')).toBe(true);
    expect(isLoopbackEndpoint('http://[::1]:11434')).toBe(true);
    expect(isLoopbackEndpoint('http://10.0.0.5:11434')).toBe(false);
    expect(isLoopbackEndpoint('https://api.ollama.ai')).toBe(false);
    expect(isLoopbackEndpoint('not-a-url')).toBe(false);
  });

  it('fails closed with a non-loopback endpoint', async () => {
    const provider = new OllamaProvider({ endpoint: 'http://10.0.0.5:11434' });
    const status = await provider.status();
    expect(status.state).toBe('error');
    expect(status.messageCode).toBe(OLLAMA_MESSAGE_CODES.badEndpoint);
    expect(await provider.listModels()).toEqual([]);
    const { controls } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('PROVIDER_UNAVAILABLE');
    }
  });
});

describe('Ollama model capacity', () => {
  it('reads architecture-specific official metadata separately from configured context', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'POST /api/show',
      jsonRoute({
        parameters: 'temperature 0.7\nnum_ctx 8192\n',
        model_info: {
          'general.architecture': 'qwen3',
          'qwen3.context_length': 131_072,
          'vision.context_length': 256,
        },
      }),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    expect(await provider.getModelDetails('qwen3:8b')).toEqual({
      maxContextTokens: 131_072,
      configuredContextTokens: 8192,
      supportsContextOverride: true,
    });
  });

  it('does not invent a default when context metadata is missing or invalid', async () => {
    const fake = await createFakeOllama();
    const provider = new OllamaProvider({ endpoint: fake.url });
    for (const capacity of [undefined, 0, -1, 12.5, '32768']) {
      fake.on(
        'POST /api/show',
        jsonRoute({
          model_info: {
            'general.architecture': 'llama',
            'llama.context_length': capacity,
          },
        }),
      );
      expect(await provider.getModelDetails('llama')).toEqual({
        maxContextTokens: null,
        configuredContextTokens: null,
        supportsContextOverride: true,
      });
    }
    fake.on('POST /api/show', jsonRoute({ wrong: 'shape' }));
    expect(await provider.getModelDetails('llama')).toBeNull();
    expect(
      await new OllamaProvider({
        endpoint: 'http://10.0.0.1:11434',
      }).getModelDetails('llama'),
    ).toBeNull();
  });

  it('translates neutral context and output limits into the actual chat request', async () => {
    const fake = await createFakeOllama();
    let requestBody: unknown;
    fake.on('POST /api/chat', async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requestBody = JSON.parse(Buffer.concat(chunks).toString());
      res.end(
        JSON.stringify({
          message: { content: 'ok' },
          done: true,
        }) + '\n',
      );
    });
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls } = collectControls();
    const result = await provider.generate(
      {
        modelId: 'local',
        messages: [{ role: 'user', content: 'job' }],
        limits: { contextTokens: 12_000, maxOutputTokens: 4_000 },
      },
      controls,
    );
    expect(result.status).toBe('completed');
    expect(requestBody).toMatchObject({
      options: { num_ctx: 12_000, num_predict: 4_000 },
    });
  });
});

describe('Ollama health detection', () => {
  it('reports ready with models', async () => {
    const fake = await createFakeOllama();
    fake.on('GET /api/version', jsonRoute({ version: '0.5.1' }));
    fake.on(
      'GET /api/tags',
      jsonRoute({
        models: [
          {
            name: 'llama3:8b',
            size: 4_700_000_000,
            details: { parameter_size: '8B', quantization_level: 'Q4_0' },
          },
        ],
      }),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const status = await provider.status();
    expect(status.state).toBe('ready');
    expect(status.runtimeVersion).toBe('0.5.1');
    expect(status.messageCode).toBe(OLLAMA_MESSAGE_CODES.ready);
    expect(status.capabilities.text).toBe('supported');
    expect(status.capabilities.tools).toBe('unknown');
  });

  it('reports ready-with-no-models when the runtime has no models', async () => {
    const fake = await createFakeOllama();
    fake.on('GET /api/version', jsonRoute({ version: '0.5.1' }));
    fake.on('GET /api/tags', jsonRoute({ models: [] }));
    const provider = new OllamaProvider({ endpoint: fake.url });
    const status = await provider.status();
    expect(status.state).toBe('ready');
    expect(status.messageCode).toBe(OLLAMA_MESSAGE_CODES.noModels);
  });

  it('reports not_running on connection refused (never not_installed)', async () => {
    // Nothing is listening on this port.
    const provider = new OllamaProvider({
      endpoint: await closedEndpoint(),
      healthTimeoutMs: 500,
    });
    const status = await provider.status();
    expect(status.state).toBe('not_running');
    expect(status.messageCode).toBe(OLLAMA_MESSAGE_CODES.notRunning);
  });

  it('reports unknown on a health timeout', async () => {
    const fake = await createFakeOllama();
    fake.on('GET /api/version', (_req, res) => {
      setTimeout(() => res.end(JSON.stringify({ version: '0.5.1' })), 300);
    });
    const provider = new OllamaProvider({
      endpoint: fake.url,
      healthTimeoutMs: 50,
    });
    const status = await provider.status();
    expect(status.state).toBe('unknown');
    expect(status.messageCode).toBe(OLLAMA_MESSAGE_CODES.unreachable);
  });
});

describe('Ollama model discovery', () => {
  it('maps tags into descriptors and classifies locality', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'GET /api/tags',
      jsonRoute({
        models: [
          {
            name: 'llama3:8b',
            size: 4_700_000_000,
            details: { parameter_size: '8B', quantization_level: 'Q4_K_M' },
          },
          { name: 'gpt-oss:120b-cloud', size: 0 },
        ],
      }),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const models = await provider.listModels();
    expect(models).toHaveLength(2);
    const local = models.find((m) => m.id === 'llama3:8b');
    expect(local).toMatchObject({
      providerId: 'ollama',
      locality: 'local',
      installed: true,
      sizeBytes: 4_700_000_000,
      parameterSize: '8B',
      quantization: 'Q4_K_M',
    });
    const cloud = models.find((m) => m.id === 'gpt-oss:120b-cloud');
    expect(cloud?.locality).toBe('cloud');
  });

  it('returns an empty list when the runtime is unreachable', async () => {
    const provider = new OllamaProvider({
      endpoint: await closedEndpoint(),
      modelsTimeoutMs: 500,
    });
    expect(await provider.listModels()).toEqual([]);
  });
});

function chatStreamRoute(
  lines: string[],
  opts: { delayMs?: number } = {},
): Handler {
  return (_req, res) => {
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const writeNext = () => {
      if (i >= lines.length) {
        res.end();
        return;
      }
      res.write(lines[i]);
      i += 1;
      if (opts.delayMs) {
        setTimeout(writeNext, opts.delayMs);
      } else {
        writeNext();
      }
    };
    writeNext();
  };
}

describe('Ollama generation', () => {
  it('completes a single-object (non-streaming) response', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'POST /api/chat',
      jsonRoute({
        model: 'llama3',
        message: { role: 'assistant', content: 'Hello world' },
        done: true,
        prompt_eval_count: 3,
        eval_count: 2,
        total_duration: 2_000_000,
      }),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls, deltas } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toBe('Hello world');
      expect(outcome.usage).toEqual({
        inputTokens: 3,
        outputTokens: 2,
        durationMs: 2,
      });
    }
    expect(deltas.join('')).toBe('Hello world');
  });

  it('streams ordered deltas and concatenates the final output', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'POST /api/chat',
      chatStreamRoute([
        JSON.stringify({ message: { content: 'Hel' }, done: false }) + '\n',
        JSON.stringify({ message: { content: 'lo ' }, done: false }) + '\n',
        JSON.stringify({ message: { content: 'there' }, done: false }) + '\n',
        JSON.stringify({
          message: { content: '' },
          done: true,
          eval_count: 5,
        }) + '\n',
      ]),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls, deltas, thinking } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    expect(deltas).toEqual(['Hel', 'lo ', 'there']);
    expect(thinking).toEqual([]);
    if (outcome.status === 'completed') {
      expect(outcome.output).toBe('Hello there');
      expect(outcome.usage?.outputTokens).toBe(5);
    }
  });

  it('streams reasoning separately and keeps it out of the answer', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'POST /api/chat',
      chatStreamRoute([
        JSON.stringify({ message: { thinking: 'Let me ' }, done: false }) +
          '\n',
        JSON.stringify({ message: { thinking: 'think.' }, done: false }) + '\n',
        JSON.stringify({ message: { content: 'Answer' }, done: false }) + '\n',
        JSON.stringify({ message: { content: '' }, done: true }) + '\n',
      ]),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls, deltas, thinking } = collectControls();
    const outcome = await provider.generate(
      {
        modelId: 'qwen3',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
      },
      controls,
    );
    expect(thinking).toEqual(['Let me ', 'think.']);
    expect(deltas).toEqual(['Answer']);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toBe('Answer');
    }
  });

  it('stops forwarding reasoning past its cap without failing the answer', async () => {
    const fake = await createFakeOllama();
    const piece = 'r'.repeat(20_000);
    const lines = Array.from(
      { length: 12 },
      () =>
        JSON.stringify({ message: { thinking: piece }, done: false }) + '\n',
    );
    lines.push(
      JSON.stringify({ message: { content: 'Done' }, done: true }) + '\n',
    );
    fake.on('POST /api/chat', chatStreamRoute(lines));
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls, deltas, thinking } = collectControls();
    const outcome = await provider.generate(
      {
        modelId: 'qwen3',
        messages: [{ role: 'user', content: 'hi' }],
        thinking: true,
      },
      controls,
    );
    expect(thinking.join('').length).toBe(200_000);
    expect(deltas).toEqual(['Done']);
    expect(outcome.status).toBe('completed');
    if (outcome.status === 'completed') {
      expect(outcome.output).toBe('Done');
    }
  });

  it('reassembles NDJSON split across chunk boundaries', async () => {
    const fake = await createFakeOllama();
    const full =
      JSON.stringify({ message: { content: 'Split' }, done: false }) +
      '\n' +
      JSON.stringify({ message: { content: 'Line' }, done: true }) +
      '\n';
    // Write bytes in awkward fragments that break lines mid-object.
    fake.on('POST /api/chat', (_req, res) => {
      res.write(full.slice(0, 10));
      setTimeout(() => res.write(full.slice(10, 35)), 10);
      setTimeout(() => {
        res.write(full.slice(35));
        res.end();
      }, 20);
    });
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls, deltas } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    expect(deltas.join('')).toBe('SplitLine');
    expect(outcome.status).toBe('completed');
  });

  it('fails with INVALID_RESPONSE on malformed stream data', async () => {
    const fake = await createFakeOllama();
    fake.on('POST /api/chat', (_req, res) => {
      res.write('{ this is not json }\n');
      res.end();
    });
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    expect(outcome.status).toBe('failed');
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('INVALID_RESPONSE');
    }
  });

  it('maps a 404 to MODEL_NOT_FOUND', async () => {
    const fake = await createFakeOllama();
    fake.on('POST /api/chat', (_req, res) => {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'model not found' }));
    });
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'ghost', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('MODEL_NOT_FOUND');
    } else {
      throw new Error('expected failure');
    }
  });

  it('maps connection refused to PROVIDER_UNAVAILABLE', async () => {
    const provider = new OllamaProvider({ endpoint: await closedEndpoint() });
    const { controls } = collectControls();
    const outcome = await provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    if (outcome.status === 'failed') {
      expect(outcome.error.code).toBe('PROVIDER_UNAVAILABLE');
    } else {
      throw new Error('expected failure');
    }
  });

  it('cancels an in-flight stream when the signal aborts', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'POST /api/chat',
      chatStreamRoute(
        [
          JSON.stringify({ message: { content: 'one' }, done: false }) + '\n',
          JSON.stringify({ message: { content: 'two' }, done: false }) + '\n',
          JSON.stringify({ message: { content: 'three' }, done: true }) + '\n',
        ],
        { delayMs: 40 },
      ),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls, abort, deltas } = collectControls();
    const promise = provider.generate(
      { modelId: 'llama3', messages: [{ role: 'user', content: 'hi' }] },
      controls,
    );
    setTimeout(() => abort.abort(), 50);
    const outcome = await promise;
    expect(outcome.status).toBe('cancelled');
    expect(deltas.length).toBeLessThan(3);
  });

  it('normalises tool-call proposals as a tool_calls outcome without executing them', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'POST /api/chat',
      jsonRoute({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: 'lookup_fact',
                arguments: { subject: 'role' },
              },
            },
          ],
        },
        done: true,
      }),
    );
    const provider = new OllamaProvider({ endpoint: fake.url });
    const { controls } = collectControls();
    const outcome = await provider.generate(
      {
        modelId: 'llama3',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'lookup_fact',
            version: 1,
            description: 'Look up a fact',
            inputSchema: {
              type: 'object',
              properties: { subject: { type: 'string' } },
              required: ['subject'],
            },
          },
        ],
      },
      controls,
    );
    expect(outcome.status).toBe('tool_calls');
    if (outcome.status === 'tool_calls') {
      expect(outcome.toolCalls).toHaveLength(1);
      expect(outcome.toolCalls[0]).toMatchObject({
        toolName: 'lookup_fact',
        arguments: { subject: 'role' },
      });
    }
  });

  it('passes a structured format and validates it through the runtime', async () => {
    const fake = await createFakeOllama();
    fake.on('POST /api/chat', (req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const parsed = JSON.parse(body) as { format?: unknown };
        expect(parsed.format).toMatchObject({ type: 'object' });
        res.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({ title: 'Ok', score: 9 }),
            },
            done: true,
          }),
        );
      });
    });

    const sent: WorkerToMainMessage[] = [];
    const runtime = new WorkerRuntime({
      send: (m) => sent.push(m),
      createProvider: (config) =>
        config.kind === 'ollama'
          ? new OllamaProvider({ endpoint: fake.url })
          : null,
    });
    const lifecycleId = crypto.randomUUID();
    runtime.handle({
      protocolVersion: 1,
      kind: 'worker.init',
      lifecycleId,
      payload: { providers: [{ providerId: 'ollama', kind: 'ollama' }] },
    });
    const requestId = crypto.randomUUID();
    runtime.handle({
      protocolVersion: 1,
      kind: 'generation.start',
      requestId,
      seq: 0,
      payload: {
        providerId: 'ollama',
        modelId: 'llama3',
        messages: [{ role: 'user', content: 'give json' }],
        responseFormat: {
          type: 'json_schema',
          schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              score: { type: 'integer' },
            },
            required: ['title', 'score'],
          },
        },
      },
    });

    await waitFor(() =>
      sent.some(
        (m) =>
          m.kind === 'generation.event' &&
          m.requestId === requestId &&
          (m.payload.eventKind === 'completed' ||
            m.payload.eventKind === 'failed'),
      ),
    );
    const terminal = sent
      .filter(
        (m): m is Extract<WorkerToMainMessage, { kind: 'generation.event' }> =>
          m.kind === 'generation.event' && m.requestId === requestId,
      )
      .at(-1);
    expect(terminal?.payload.eventKind).toBe('completed');
    if (terminal && terminal.payload.eventKind === 'completed') {
      expect(terminal.payload.output).toMatchObject({ title: 'Ok', score: 9 });
    }
  });
  it('transmits a nested nullable CV schema unchanged and rejects a bad nested response', async () => {
    const { fullCvSchema } =
      await import('../src/main/modules/cv-imports/full-cv');
    const fake = await createFakeOllama();
    let bad = false;
    const thinkingRequests: { present: boolean; value: unknown }[] = [];
    fake.on('POST /api/chat', (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        const payload = JSON.parse(body) as {
          format: unknown;
          tools?: unknown;
          think?: unknown;
        };
        expect(payload.format).toEqual(fullCvSchema);
        expect(payload.tools).toBeUndefined();
        thinkingRequests.push({
          present: Object.hasOwn(payload, 'think'),
          value: payload.think,
        });
        res.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                name: null,
                email: null,
                phoneNumber: null,
                location: null,
                summary: null,
                experience: bad ? [{ title: 7 }] : [],
                skills: [],
                education: [],
                projects: [],
                inferences: [],
              }),
            },
            done: true,
          }),
        );
      });
    });
    const sent: WorkerToMainMessage[] = [];
    const runtime = new WorkerRuntime({
      send: (message) => sent.push(message),
      createProvider: (config) =>
        config.kind === 'ollama'
          ? new OllamaProvider({ endpoint: fake.url })
          : null,
    });
    runtime.handle({
      protocolVersion: 1,
      kind: 'worker.init',
      lifecycleId: crypto.randomUUID(),
      payload: { providers: [{ providerId: 'ollama', kind: 'ollama' }] },
    });
    for (const [thinking, expected] of [
      [false, 'completed'],
      [true, 'failed'],
      [undefined, 'failed'],
    ] as const) {
      const requestId = crypto.randomUUID();
      runtime.handle({
        protocolVersion: 1,
        kind: 'generation.start',
        requestId,
        seq: 0,
        payload: {
          providerId: 'ollama',
          modelId: 'local',
          messages: [{ role: 'user', content: 'CV text' }],
          responseFormat: { type: 'json_schema', schema: fullCvSchema },
          ...(thinking === undefined ? {} : { thinking }),
        },
      });
      await waitFor(() =>
        sent.some(
          (message) =>
            message.kind === 'generation.event' &&
            message.requestId === requestId &&
            (message.payload.eventKind === 'completed' ||
              message.payload.eventKind === 'failed'),
        ),
      );
      const terminal = sent
        .filter(
          (message) =>
            message.kind === 'generation.event' &&
            message.requestId === requestId,
        )
        .at(-1);
      expect(
        terminal?.kind === 'generation.event' && terminal.payload.eventKind,
      ).toBe(expected);
      bad = true;
    }
    expect(thinkingRequests).toEqual([
      { present: true, value: false },
      { present: true, value: true },
      { present: false, value: undefined },
    ]);
  });
});

describe('Ollama worker runtime registration', () => {
  it('registers the ollama provider and answers provider.models', async () => {
    const fake = await createFakeOllama();
    fake.on(
      'GET /api/tags',
      jsonRoute({ models: [{ name: 'phi3:mini', size: 2_000_000_000 }] }),
    );
    const sent: WorkerToMainMessage[] = [];
    const runtime = new WorkerRuntime({
      send: (m) => sent.push(m),
      createProvider: (config) =>
        config.kind === 'ollama'
          ? new OllamaProvider({ endpoint: fake.url })
          : null,
    });
    runtime.handle({
      protocolVersion: 1,
      kind: 'worker.init',
      lifecycleId: crypto.randomUUID(),
      payload: { providers: [{ providerId: 'ollama', kind: 'ollama' }] },
    });
    const requestId = crypto.randomUUID();
    runtime.handle({
      protocolVersion: 1,
      kind: 'provider.models',
      requestId,
      payload: { providerId: 'ollama' },
    });
    await waitFor(() => sent.some((m) => m.kind === 'provider.models.result'));
    const result = sent.find((m) => m.kind === 'provider.models.result');
    if (result && result.kind === 'provider.models.result') {
      expect(result.payload.models).toHaveLength(1);
      expect(result.payload.models[0].id).toBe('phi3:mini');
    }
  });
});

function hardware(totalMemoryBytes: number): HardwareProfile {
  return {
    platform: 'darwin',
    architecture: 'arm64',
    cpuLogicalCount: 8,
    totalMemoryBytes,
    freeMemoryBytes: Math.floor(totalMemoryBytes / 2),
    freeDiskBytes: 500_000_000_000,
    capturedAt: new Date().toISOString(),
    gpuName: null,
    gpuMemoryBytes: null,
    acceleration: 'metal',
    notes: [],
  };
}

function model(partial: Partial<ModelDescriptor>): ModelDescriptor {
  return {
    providerId: 'ollama',
    id: partial.id ?? 'm',
    displayName: partial.displayName ?? partial.id ?? 'm',
    locality: partial.locality ?? 'local',
    installed: partial.installed ?? true,
    sizeBytes: partial.sizeBytes ?? null,
    parameterSize: partial.parameterSize ?? null,
    quantization: partial.quantization ?? null,
    contextLength: partial.contextLength ?? null,
  };
}

describe('Ollama recommendations', () => {
  it('returns a setup note and no items for an empty model list', () => {
    const result = recommendOllamaModels(hardware(16e9), []);
    expect(result.items).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/install a model/i);
  });

  it('excludes cloud and unknown locality models from local-only output', () => {
    const result = recommendOllamaModels(hardware(32e9), [
      model({ id: 'cloud-model', locality: 'cloud', sizeBytes: 1e9 }),
      model({ id: 'unknown-model', locality: 'unknown', sizeBytes: 1e9 }),
    ]);
    expect(result.items).toEqual([]);
    expect(result.notes.join(' ')).toMatch(/excluded/i);
  });

  it('marks a comfortably-fitting model as likely', () => {
    const result = recommendOllamaModels(hardware(32e9), [
      model({ id: 'small', locality: 'local', sizeBytes: 4e9 }),
    ]);
    expect(result.items[0]).toMatchObject({ modelId: 'small', fit: 'likely' });
    expect(result.items[0].warnings.join(' ')).toMatch(/not benchmarked/i);
  });

  it('marks an oversized model as uncertain with a warning', () => {
    const result = recommendOllamaModels(hardware(8e9), [
      model({ id: 'huge', locality: 'local', sizeBytes: 40e9 }),
    ]);
    expect(result.items[0]).toMatchObject({
      modelId: 'huge',
      fit: 'uncertain',
    });
    expect(result.items[0].warnings.join(' ')).toMatch(/exceeds/i);
  });

  it('treats unknown model size conservatively as uncertain', () => {
    const result = recommendOllamaModels(hardware(16e9), [
      model({ id: 'mystery', locality: 'local', sizeBytes: null }),
    ]);
    expect(result.items[0]).toMatchObject({
      modelId: 'mystery',
      fit: 'uncertain',
    });
  });

  it('ranks likely candidates ahead of uncertain ones', () => {
    const result = recommendOllamaModels(hardware(16e9), [
      model({ id: 'big', locality: 'local', sizeBytes: 30e9 }),
      model({ id: 'tiny', locality: 'local', sizeBytes: 2e9 }),
    ]);
    expect(result.items.map((i) => i.modelId)).toEqual(['tiny', 'big']);
  });
});

describe('Ollama IPC surface (service + supervisor)', () => {
  async function setup(fake: FakeOllama) {
    const { ProviderManager } =
      await import('../src/main/modules/inference/provider-manager');
    const { WorkerSupervisor } =
      await import('../src/main/modules/inference/worker-supervisor');
    const { InMemoryTransport } =
      await import('../src/main/modules/inference/transport');
    const { InferenceService } =
      await import('../src/main/modules/inference/inference.service');
    const { createInferenceModule } =
      await import('../src/main/modules/inference/inference.module');
    const { createDispatcher } = await import('../src/main/ipc/dispatcher');

    const providers = new ProviderManager();
    providers.register({
      providerId: 'ollama',
      kind: 'ollama',
      configured: true,
      dev: false,
      endpoint: fake.url,
    });
    const supervisor = new WorkerSupervisor({
      createTransport: () =>
        new InMemoryTransport({
          createProvider: (config) =>
            config.kind === 'ollama'
              ? new OllamaProvider({ endpoint: config.endpoint })
              : null,
        }),
      providerConfigs: providers.workerConfigs(),
      startupTimeoutMs: 1000,
      statusTimeoutMs: 1000,
    });
    const service = new InferenceService({ supervisor, providers });
    await service.start();
    const dispatcher = createDispatcher([createInferenceModule(service)]);
    return { service, dispatcher, stop: () => service.stop() };
  }

  async function send(
    dispatcher: Awaited<ReturnType<typeof setup>>['dispatcher'],
    action: string,
    payload: unknown,
  ) {
    return dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'inference',
      version: 1,
      action,
      payload,
    });
  }

  it('serves provider.health, models.list and models.recommend', async () => {
    const fake = await createFakeOllama();
    fake.on('GET /api/version', jsonRoute({ version: '0.5.1' }));
    fake.on(
      'GET /api/tags',
      jsonRoute({
        models: [
          {
            name: 'llama3:8b',
            size: 4_700_000_000,
            details: { parameter_size: '8B', quantization_level: 'Q4_0' },
          },
        ],
      }),
    );
    const { dispatcher, stop } = await setup(fake);
    try {
      const health = (await send(dispatcher, 'provider.health', {
        providerId: 'ollama',
      })) as { ok: boolean; data?: { item: { state: string } } };
      expect(health.ok).toBe(true);
      expect(health.data?.item.state).toBe('ready');

      const list = (await send(dispatcher, 'models.list', {
        providerId: 'ollama',
      })) as { ok: boolean; data?: { items: ModelDescriptor[] } };
      expect(list.ok).toBe(true);
      expect(list.data?.items.map((m) => m.id)).toContain('llama3:8b');

      const rec = (await send(dispatcher, 'models.recommend', {
        providerId: 'ollama',
      })) as {
        ok: boolean;
        data?: { items: Array<{ modelId: string }>; notes: string[] };
      };
      expect(rec.ok).toBe(true);
      expect(Array.isArray(rec.data?.items)).toBe(true);
    } finally {
      await stop();
    }
  });

  it('rejects an unknown provider with NOT_FOUND', async () => {
    const fake = await createFakeOllama();
    const { dispatcher, stop } = await setup(fake);
    try {
      const res = (await send(dispatcher, 'models.list', {
        providerId: 'ghost',
      })) as { ok: boolean; error?: { code: string } };
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('NOT_FOUND');
    } finally {
      await stop();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
}

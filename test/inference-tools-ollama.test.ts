import { describe, expect, it } from 'vitest';
import {
  toOllamaMessages,
  toOllamaTools,
} from '../src/main/modules/inference/ollama-provider';
import type { ProviderMessage } from '../src/main/modules/inference/provider';
import type { ToolDefinition } from '../src/shared/contracts';

describe('Ollama tool serialisation', () => {
  it('serialises tool definitions into the function wire format', () => {
    const defs: ToolDefinition[] = [
      {
        name: 'examples.add_numbers',
        version: 1,
        description: 'Add two numbers.',
        inputSchema: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
      },
    ];
    expect(toOllamaTools(defs)).toEqual([
      {
        type: 'function',
        function: {
          name: 'examples.add_numbers',
          description: 'Add two numbers.',
          parameters: defs[0].inputSchema,
        },
      },
    ]);
  });

  it('maps an assistant tool-call turn and a tool-result turn back to Ollama messages', () => {
    const messages: ProviderMessage[] = [
      { role: 'user', content: 'add 2 and 3' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          {
            toolCallId: 'c0',
            toolName: 'examples.add_numbers',
            arguments: { a: 2, b: 3 },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { sum: 5 } }),
        name: 'examples.add_numbers',
        toolCallId: 'c0',
      },
    ];
    expect(toOllamaMessages(messages)).toEqual([
      { role: 'user', content: 'add 2 and 3' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            function: {
              name: 'examples.add_numbers',
              arguments: { a: 2, b: 3 },
            },
          },
        ],
      },
      {
        role: 'tool',
        content: JSON.stringify({ ok: true, data: { sum: 5 } }),
        name: 'examples.add_numbers',
      },
    ]);
  });
});

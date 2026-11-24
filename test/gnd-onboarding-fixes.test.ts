import { describe, expect, it } from 'vitest';
import { lookAt } from '../src/renderer/presentation/gnd/buddy/Buddy';
import {
  NO_OLLAMA,
  NOT_RUNNING,
  setupMessage,
} from '../src/renderer/presentation/gnd/pages/onboarding/OllamaSetup';
import { failureMessage } from '../src/renderer/presentation/gnd/pages/onboarding/steps/LearningStep';

describe('buddy eyes', () => {
  it('look toward the pointer, within a small range', () => {
    expect(lookAt({ x: 100, y: 100 }, { x: 100, y: 100 })).toEqual({
      x: 0,
      y: 0,
    });
    const right = lookAt({ x: 1000, y: 100 }, { x: 100, y: 100 });
    expect(right.x).toBe(7);
    expect(right.y).toBe(0);
    const near = lookAt({ x: 130, y: 100 }, { x: 100, y: 100 });
    expect(near.x).toBeLessThan(2);
  });
});

describe('Ollama setup says which part is missing', () => {
  it('separates the program from the model', () => {
    expect(setupMessage(null, 0, 'qwen3.5:4b')).toBe(NO_OLLAMA);
    expect(
      setupMessage({ reachable: false, state: 'not_running' }, 0, 'qwen3.5:4b'),
    ).toBe(NOT_RUNNING);
    const noModel = setupMessage(
      { reachable: true, runtimeVersion: '0.12.1' },
      0,
      'qwen3.5:4b',
    );
    expect(noModel).toContain('Ollama 0.12.1');
    expect(noModel).toContain('qwen3.5:4b');
    expect(setupMessage({ reachable: true }, 1, 'qwen3.5:4b')).toBeNull();
  });
});

describe('CV read errors', () => {
  it('explain the failure instead of blaming the file', () => {
    expect(failureMessage({ kind: 'file', code: 'TIMEOUT' })).toContain(
      'too long',
    );
    expect(
      failureMessage({ kind: 'file', code: 'INVALID_RESPONSE' }),
    ).toContain('didn’t make sense');
    expect(failureMessage({ kind: 'file', code: 'RESOURCE_LIMIT' })).toContain(
      'longer than',
    );
    expect(
      failureMessage({ kind: 'model', code: 'MODEL_UNAVAILABLE' }),
    ).toContain('local AI');
  });
});

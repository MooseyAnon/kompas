import { describe, expect, it } from 'vitest';
import { createAppDispatcher } from '../src/main/core/registry';
import { AppError } from '../src/main/ipc/dispatcher';
import {
  createDispatcher,
  type ModuleManifest,
} from '../src/main/ipc/dispatcher';
import { MAX_PAYLOAD_BYTES } from '../src/shared/contracts';
import { z } from 'zod';

const APP_VERSION = '1.0.0';

function makeDispatcher(storageReady = false) {
  return createAppDispatcher({
    getAppVersion: () => APP_VERSION,
    isStorageReady: () => storageReady,
  });
}

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: crypto.randomUUID(),
    module: 'system',
    version: 1,
    action: 'ping',
    payload: {},
    ...overrides,
  };
}

describe('system.ping happy path', () => {
  it('returns appVersion, apiVersion 1 and storageReady false', async () => {
    const dispatcher = makeDispatcher(false);
    const envelope = validEnvelope();
    const response = await dispatcher.dispatch(envelope);

    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.requestId).toBe(envelope.requestId);
      expect(response.data).toEqual({
        appVersion: APP_VERSION,
        apiVersion: 1,
        storageReady: false,
      });
    }
  });

  it('reflects storageReady when the service reports ready', async () => {
    const dispatcher = makeDispatcher(true);
    const response = await dispatcher.dispatch(validEnvelope());
    expect(response.ok).toBe(true);
    if (response.ok) {
      expect(response.data).toMatchObject({ storageReady: true });
    }
  });
});

describe('routing and version errors', () => {
  it('rejects an unknown module with NOT_FOUND', async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      validEnvelope({ module: 'ghost' }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('NOT_FOUND');
    }
  });

  it('rejects an unknown action with NOT_FOUND', async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      validEnvelope({ action: 'explode' }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('NOT_FOUND');
    }
  });

  it('rejects an unsupported version with VERSION_UNSUPPORTED', async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(validEnvelope({ version: 2 }));
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('VERSION_UNSUPPORTED');
    }
  });
});

describe('malformed and oversized requests', () => {
  it('rejects a non-object request with INVALID_INPUT', async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch('not-an-envelope');
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects an envelope with a non-UUID requestId', async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      validEnvelope({ requestId: 'not-a-uuid' }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
      // A fresh UUID correlation id is minted when the incoming id is invalid.
      expect(response.error.correlationId).toMatch(/[0-9a-f-]{36}/);
    }
  });

  it('rejects unexpected payload fields with INVALID_INPUT (strict schema)', async () => {
    const dispatcher = makeDispatcher();
    const response = await dispatcher.dispatch(
      validEnvelope({ payload: { unexpected: true } }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects an oversized payload with INVALID_INPUT', async () => {
    const dispatcher = makeDispatcher();
    const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 1024);
    const response = await dispatcher.dispatch(
      validEnvelope({ payload: { blob: big } }),
    );
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INVALID_INPUT');
    }
  });
});

describe('error mapping and correlation ids', () => {
  it('echoes the requestId as correlationId on success and failure', async () => {
    const dispatcher = makeDispatcher();
    const envelope = validEnvelope({ module: 'ghost' });
    const response = await dispatcher.dispatch(envelope);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.requestId).toBe(envelope.requestId);
      expect(response.error.correlationId).toBe(envelope.requestId);
    }
  });

  it('maps a thrown AppError to its code without leaking details', async () => {
    const boom: ModuleManifest = {
      id: 'boom',
      apiMajor: 1,
      commands: {
        go: {
          input: z.object({}).strict(),
          output: z.object({ ok: z.boolean() }),
          handle: () => {
            throw new AppError('CONFLICT', 'Safe conflict message.');
          },
        },
      },
    };
    const dispatcher = createDispatcher([boom]);
    const response = await dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'boom',
      version: 1,
      action: 'go',
      payload: {},
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('CONFLICT');
      expect(response.error.message).toBe('Safe conflict message.');
    }
  });

  it('maps an unexpected thrown error to INTERNAL without leaking the message', async () => {
    const boom: ModuleManifest = {
      id: 'boom',
      apiMajor: 1,
      commands: {
        go: {
          input: z.object({}).strict(),
          output: z.object({ ok: z.boolean() }),
          handle: () => {
            throw new Error('secret internal detail /Users/secret/path');
          },
        },
      },
    };
    const dispatcher = createDispatcher([boom]);
    const response = await dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'boom',
      version: 1,
      action: 'go',
      payload: {},
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INTERNAL');
      expect(response.error.message).not.toContain('secret');
    }
  });

  it('maps an output-contract violation to INTERNAL', async () => {
    const bad: ModuleManifest = {
      id: 'bad',
      apiMajor: 1,
      commands: {
        go: {
          input: z.object({}).strict(),
          output: z.object({ required: z.string() }),
          handle: () => ({ wrong: 1 }) as never,
        },
      },
    };
    const dispatcher = createDispatcher([bad]);
    const response = await dispatcher.dispatch({
      requestId: crypto.randomUUID(),
      module: 'bad',
      version: 1,
      action: 'go',
      payload: {},
    });
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.error.code).toBe('INTERNAL');
    }
  });
});

describe('registry introspection', () => {
  it('lists the system.ping command', () => {
    const dispatcher = makeDispatcher();
    expect(dispatcher.listCommands()).toContainEqual({
      module: 'system',
      version: 1,
      action: 'ping',
    });
    expect(dispatcher.has('system', 'ping', 1)).toBe(true);
    expect(dispatcher.has('system', 'ping', 2)).toBe(false);
  });
});

import { expect, it, vi } from 'vitest';
import { waitFor } from '../scripts/smoke/harness.mjs';

it('waits for an observable transition and returns the accepted snapshot', async () => {
  const snapshots = [{ status: 'running' }, { status: 'ready' }];
  const read = vi.fn(async () => snapshots.shift() ?? { status: 'ready' });
  const result = await waitFor(
    read,
    (value: { status: string }) => value.status === 'ready',
    'fixture ready',
  );

  expect(result).toEqual({ status: 'ready' });
  expect(read).toHaveBeenCalledTimes(2);
});

it('timeout diagnostics include only the explicitly selected safe fields', async () => {
  const privateSnapshot = {
    status: 'failed',
    errorCode: 'MODEL_UNAVAILABLE',
    documentText: 'private fixture text',
  };
  const operation = waitFor(
    async () => privateSnapshot,
    () => false,
    'fixture extraction',
    {
      timeout: 1,
      summarize: (value: typeof privateSnapshot) => ({
        status: value.status,
        errorCode: value.errorCode,
      }),
    },
  );
  const error = await operation.catch((cause: Error) => cause);

  if (!(error instanceof Error)) {
    throw new Error('Expected the poll to time out');
  }

  expect(error.message).toContain('fixture extraction');
  expect(error.message).toContain('MODEL_UNAVAILABLE');
  expect(error.message).not.toContain('private fixture text');
  expect(error.message).not.toContain('documentText');
});

it('propagates request failures immediately rather than hiding them as timeouts', async () => {
  const read = vi.fn(async () => {
    throw new Error('IPC connection closed');
  });

  await expect(waitFor(read, () => false, 'fixture state')).rejects.toThrow(
    'IPC connection closed',
  );
  expect(read).toHaveBeenCalledTimes(1);
});

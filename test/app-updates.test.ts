import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const electron = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mock = {
    app: {
      isPackaged: true,
      isReady: () => true,
      getVersion: () => '0.1.0',
    },
    autoUpdater: Object.assign(new EventEmitter(), {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
    }),
  };
  // The published library is CommonJS: mock its native require boundary too.
  const native = require('electron');
  const entry = require.cache[require.resolve('electron')]!;
  entry.exports = mock;
  return {
    ...mock,
    restore: () => {
      entry.exports = native;
    },
  };
});

vi.mock('electron', () => electron);
afterAll(() => electron.restore());

import { AppUpdates } from '../src/main/core/app-updates';
import { updateBuildRepository } from '../scripts/update-build-config.mjs';

function fixture(overrides = {}) {
  const deps = {
    packaged: true,
    platform: 'darwin',
    arch: 'arm64',
    testing: false,
    repository: 'test-owner/test-repository',
    version: '0.1.0',
    verifySignature: vi.fn().mockResolvedValue(undefined),
    updater: electron.autoUpdater,
    telemetry: { record: vi.fn() },
    prompt: vi.fn().mockResolvedValue(1),
    isBusy: () => false,
    prepareInstall: vi.fn().mockResolvedValue(undefined),
    onReady: vi.fn(),
    ...overrides,
  };
  const updates = new AppUpdates(deps);
  controllers.push(updates);
  return { deps, updates };
}

const controllers: AppUpdates[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  electron.autoUpdater.removeAllListeners();
});

afterEach(() => {
  controllers.splice(0).forEach((controller) => controller.dispose());
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('update build authority', () => {
  it('does not verify or embed a repository in unsigned builds', () => {
    const verify = vi.fn();
    expect(updateBuildRepository({}, verify)).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it('requires signing credentials and the existing public release guard', () => {
    const verify = vi.fn().mockReturnValue({ repository: 'verified/repo' });
    expect(() =>
      updateBuildRepository({ KOMPAS_RELEASE: '1' }, verify),
    ).toThrow('KOMPAS_SIGN_IDENTITY');
    const env = {
      KOMPAS_RELEASE: '1',
      KOMPAS_SIGN_IDENTITY: 'Developer ID Application: fixture',
      KOMPAS_NOTARY_PROFILE: 'fixture',
    };
    expect(updateBuildRepository(env, verify)).toBe('verified/repo');
    expect(verify).toHaveBeenCalledWith(env);
    verify.mockImplementation(() => {
      throw new Error('Private repository');
    });
    expect(() => updateBuildRepository(env, verify)).toThrow('Private');
  });
});

describe('gated public stable updater', () => {
  it.each([
    { packaged: false },
    { platform: 'linux' },
    { platform: 'win32' },
    { arch: 'x64' },
    { testing: true },
    { repository: null },
    { repository: 'https://github.com/test/repo' },
    { version: '0.1.1-beta.1' },
  ])('never initialises in an ineligible process: %j', async (override) => {
    const { deps, updates } = fixture(override);
    await updates.start();
    expect(deps.verifySignature).not.toHaveBeenCalled();
    expect(electron.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(electron.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects unsigned/ad-hoc packages non-disruptively', async () => {
    const { deps, updates } = fixture({
      verifySignature: vi.fn().mockRejectedValue(new Error('private path')),
    });
    await updates.start();
    expect(electron.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    expect(deps.telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'UPDATE_INITIALISATION_FAILED',
      }),
    );
    expect(JSON.stringify(deps.telemetry.record.mock.calls)).not.toContain(
      'private',
    );
  });

  it('uses the installed version and ARM64 public feed, startup and six-hour checks', async () => {
    const { updates } = fixture();
    await updates.start();
    await updates.start();
    expect(electron.autoUpdater.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://update.electronjs.org/test-owner/test-repository/darwin-arm64/0.1.0',
      }),
    );
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
    updates.dispose();
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('logs unavailable/offline/unpublished responses without dialogs or rapid retries', async () => {
    const { deps, updates } = fixture();
    await updates.start();
    electron.autoUpdater.emit('error', new Error('remote private diagnostics'));
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(deps.telemetry.record).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: 'UPDATE_SERVICE_UNAVAILABLE',
      }),
    );
    expect(JSON.stringify(deps.telemetry.record.mock.calls)).not.toContain(
      'private',
    );
  });

  it('records a stalled request once and remains non-blocking', async () => {
    const { deps, updates } = fixture();
    await updates.start();
    electron.autoUpdater.emit('checking-for-update');
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(
      deps.telemetry.record.mock.calls.filter(
        ([run]) => run.errorCode === 'UPDATE_TIMEOUT',
      ),
    ).toHaveLength(1);
    expect(deps.prompt).not.toHaveBeenCalled();
    electron.autoUpdater.emit('update-not-available');
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('downloads in the background; Later and duplicate ready events never quit', async () => {
    const { deps, updates } = fixture();
    await updates.start();
    electron.autoUpdater.emit('update-available');
    expect(deps.prompt).not.toHaveBeenCalled();
    electron.autoUpdater.emit('update-downloaded');
    electron.autoUpdater.emit('update-downloaded');
    await Promise.resolve();
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.prompt).toHaveBeenCalledTimes(1);
    expect(deps.prepareInstall).not.toHaveBeenCalled();
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000);
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(deps.prompt).toHaveBeenCalledTimes(1);
  });

  it('allows explicit menu retry after Later and waits for shutdown before installing once', async () => {
    let finishShutdown!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      finishShutdown = resolve;
    });
    const { deps, updates } = fixture({
      prepareInstall: vi.fn(() => shutdown),
    });
    await updates.start();
    electron.autoUpdater.emit('update-downloaded');
    await Promise.resolve();
    deps.prompt.mockResolvedValue(0);
    const restarting = updates.promptToInstall();
    await Promise.resolve();
    await updates.promptToInstall();
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    finishShutdown();
    await restarting;
    await updates.promptToInstall();
    expect(deps.prepareInstall).toHaveBeenCalledTimes(1);
    expect(electron.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('refuses install when work becomes active and allows a later explicit retry', async () => {
    const { deps, updates } = fixture();
    deps.prompt.mockResolvedValue(0);
    deps.prepareInstall.mockRejectedValueOnce(new Error('Active recording'));
    await updates.start();
    electron.autoUpdater.emit('update-downloaded');
    await vi.advanceTimersByTimeAsync(0);
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await updates.promptToInstall();
    expect(electron.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not interrupt an active journey with an automatic prompt', async () => {
    const { deps, updates } = fixture({ isBusy: () => true });
    await updates.start();
    electron.autoUpdater.emit('update-downloaded');
    expect(deps.onReady).toHaveBeenCalledTimes(1);
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(deps.prepareInstall).not.toHaveBeenCalled();
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await updates.promptToInstall();
    expect(deps.prompt).toHaveBeenCalledTimes(1);
  });

  it('does not compete with normal quit/reset while a dialog is open', async () => {
    let answer!: (response: number) => void;
    const { deps, updates } = fixture({
      prompt: () =>
        new Promise<number>((resolve) => {
          answer = resolve;
        }),
    });
    await updates.start();
    electron.autoUpdater.emit('update-downloaded');
    updates.dispose();
    answer(0);
    await Promise.resolve();
    expect(deps.prepareInstall).not.toHaveBeenCalled();
    expect(electron.autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('handles a synchronous native initialisation failure', async () => {
    electron.autoUpdater.setFeedURL.mockImplementationOnce(() => {
      throw new Error('native unavailable');
    });
    const { deps, updates } = fixture();
    await updates.start();
    expect(deps.prompt).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

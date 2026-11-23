// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GndSettingsPage as SettingsPage } from '../src/renderer/presentation/gnd/pages/settings/GndSettingsPage';

const api = vi.hoisted(() => ({
  getInferenceStatus: vi.fn(),
  getInferenceHardware: vi.fn(),
  getInferenceSettings: vi.fn(),
  listInferenceModels: vi.fn(),
  recommendInferenceModels: vi.fn(),
  updateInferenceSettings: vi.fn(),
  runInferenceTest: vi.fn(),
  getInferenceTest: vi.fn(),
  cancelInferenceTest: vi.fn(),
  audioSttProvidersList: vi.fn(),
  audioSttProvidersVerify: vi.fn(),
  audioSttJobsStart: vi.fn(),
  audioSttJobsGet: vi.fn(),
  audioSttJobsCancel: vi.fn(),
  audioSttTranscriptsGet: vi.fn(),
  webListBrowsers: vi.fn(),
  systemPing: vi.fn(),
  telemetryRunsList: vi.fn(),
  listInferenceDiagnostics: vi.fn(),
  getStorageUsage: vi.fn(),
  startStorageReset: vi.fn(),
}));
const capture = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('../src/renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/api')>()),
  ...api,
}));
vi.mock('../src/renderer/audio/capture', () => ({
  MicrophoneRecorder: class {
    start = capture.start;
    stop = capture.stop;
    cancel = capture.cancel;
    dispose = capture.dispose;
  },
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const model = {
  providerId: 'ollama',
  id: 'local:4b',
  displayName: 'Local 4B',
  locality: 'local',
  installed: true,
};
const settings = {
  mode: 'local_only',
  providerId: 'ollama',
  modelId: 'local:4b',
  generationTimeoutMs: null,
  updatedAt: 'today',
};
const provider = {
  providerId: 'ollama',
  state: 'ready',
  runtimeVersion: '1.0',
};
const hardware = {
  platform: 'darwin',
  architecture: 'arm64',
  totalMemoryBytes: 16 * 1024 ** 3,
  freeMemoryBytes: 8 * 1024 ** 3,
  freeDiskBytes: 60 * 1024 ** 3,
  cpuLogicalCount: 8,
  capturedAt: '2026-11-08T00:00:00.000Z',
  gpuName: 'Apple GPU',
  gpuMemoryBytes: null,
  osRelease: '25.0',
  notes: [],
  acceleration: 'metal',
};
const stt = {
  providerId: 'whisper',
  engine: 'whisper.cpp',
  state: 'unavailable',
  ready: false,
  offline: true,
  engineVersion: null,
  model: null,
  reason: 'model_missing',
  locales: [],
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  vi.clearAllMocks();
  capture.start.mockResolvedValue(undefined);
  capture.stop.mockResolvedValue({ id: 'recording-id' });
  capture.cancel.mockResolvedValue(undefined);
  api.getInferenceStatus.mockResolvedValue({
    worker: { state: 'ready' },
    providers: [provider],
  });
  api.getInferenceHardware.mockResolvedValue(hardware);
  api.systemPing.mockResolvedValue({
    appVersion: '1.0.0',
    apiVersion: 1,
    storageReady: true,
  });
  api.telemetryRunsList.mockResolvedValue([]);
  api.listInferenceDiagnostics.mockResolvedValue([]);
  api.getStorageUsage.mockResolvedValue({
    categories: [
      { category: 'database', bytes: 100 },
      { category: 'documents', bytes: 20 },
      { category: 'audio', bytes: 0 },
      { category: 'logs', bytes: 10 },
      { category: 'cache', bytes: 0 },
      { category: 'session', bytes: 0 },
    ],
    totalBytes: 130,
    partial: false,
  });
  api.startStorageReset.mockResolvedValue({ restarting: true });
  api.getInferenceSettings.mockResolvedValue({
    settings,
    resolvedModel: model,
    warnings: [],
  });
  api.listInferenceModels.mockResolvedValue([
    model,
    { ...model, id: 'cloud:4b', locality: 'cloud' },
  ]);
  api.recommendInferenceModels.mockResolvedValue({
    items: [
      {
        modelId: model.id,
        fit: 'uncertain',
        reasons: [],
        warnings: ['Memory may be limited'],
      },
    ],
    notes: [],
  });
  api.audioSttProvidersList.mockResolvedValue([stt]);
  api.webListBrowsers.mockResolvedValue({
    browsers: [
      {
        id: 'chrome',
        displayName: 'Chrome',
        detected: true,
        supported: true,
        launchVerified: false,
        reason: 'Launch failed',
      },
      {
        id: 'safari',
        displayName: 'Safari',
        detected: true,
        supported: false,
        launchVerified: null,
      },
    ],
    selectedId: 'chrome',
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<SettingsPage />);
    await tick();
  });
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function click(id: string) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!
      .click();
    await tick();
  });
}

describe('GND: active Settings', () => {
  it('shows the onboarding-style Ollama setup in Local AI until a local model is ready', async () => {
    await act(async () => root.unmount());
    api.getInferenceSettings.mockResolvedValue({
      settings,
      resolvedModel: null,
      warnings: [],
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<SettingsPage />);
      await tick();
    });
    expect(
      container.querySelector('[data-testid="ollama-nudge"]')?.textContent,
    ).toContain('07728990467');
    const view = container.querySelector(
      '[data-testid="settings-view-local-ai"]',
    )!;
    expect(view.textContent).toContain('Set up Ollama');
    expect(view.textContent).toContain('Mac & Linux');
    expect(view.textContent).toContain('ollama pull');
    expect(view.querySelector('.local-ai')).toBeNull();
  });

  it('saves a longer generation target and restores the five-minute default', async () => {
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="ai-timeout-input"]',
    )!;
    expect(input.value).toBe('300');
    expect(
      container.querySelector('[data-testid="ai-timeout-effective"]')
        ?.textContent,
    ).toContain('Saved target: 5 min · Stop after: 10 min');

    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, '900');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    api.updateInferenceSettings.mockResolvedValueOnce({
      settings: { ...settings, generationTimeoutMs: 900_000 },
    });
    await click('ai-timeout-save');
    expect(api.updateInferenceSettings).toHaveBeenCalledWith({
      generationTimeoutMs: 900_000,
    });
    expect(
      container.querySelector('[data-testid="ai-timeout-effective"]')
        ?.textContent,
    ).toContain('Saved target: 15 min · Stop after: 30 min');

    api.updateInferenceSettings.mockResolvedValueOnce({ settings });
    await click('ai-timeout-reset');
    expect(api.updateInferenceSettings).toHaveBeenLastCalledWith({
      generationTimeoutMs: null,
    });
    expect(input.value).toBe('300');
  });

  it('keeps runtime and model readiness separate and puts advisory guidance in native disclosures', async () => {
    expect(
      container
        .querySelector<HTMLImageElement>('img[alt="Ollama logo"]')
        ?.getAttribute('src'),
    ).toContain('ollama.png');
    expect(
      container.querySelector('[data-testid="ai-status"]')?.textContent,
    ).toBe('Ready');
    expect(container.textContent).toContain('Memory may be limited');
    expect(
      container.querySelectorAll('.local-ai-peers > .ui-card'),
    ).toHaveLength(2);
    expect(
      container.querySelector('.local-ai-inference')?.textContent,
    ).toContain('Run inference test');
    expect(
      container.querySelector('.local-ai-inference')?.textContent,
    ).toContain('Fit: Uncertain · memory guidance only');
    expect(
      container.querySelector('.local-ai-inference')?.textContent,
    ).toContain('Memory may be limited');
    expect(
      container.querySelector('[data-testid="model-select-cloud:4b"]'),
    ).toBeNull();
    const disclosure = [
      ...container.querySelectorAll<HTMLDetailsElement>('details'),
    ].find((item) =>
      item.textContent?.includes('Model inventory & memory details'),
    )!;
    expect(disclosure.open).toBe(false);
    await act(async () => disclosure.querySelector('summary')!.click());
    expect(disclosure.open).toBe(true);
    expect(disclosure.textContent).toContain('cloud:4b');
    expect(container.textContent).toContain('ollama pull qwen3.5:4b');

    api.getInferenceStatus.mockResolvedValueOnce({
      worker: { state: 'unavailable' },
      providers: [{ ...provider, state: 'not_running' }],
    });
    await click('ai-refresh');
    expect(
      container.querySelector('[data-testid="ai-status"]')?.textContent,
    ).toBe('Not running');
    expect(container.textContent).toContain(
      'a failed connection does not prove it is absent',
    );
    expect(container.textContent).toContain('Model inventory unavailable');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="ai-test-start"]',
      )?.disabled,
    ).toBe(true);
  });

  it('uses supplied logos for known browsers and shows support separately from detection and launch', async () => {
    api.webListBrowsers.mockResolvedValueOnce({
      browsers: [
        {
          id: 'msedge',
          displayName: 'Microsoft Edge',
          detected: true,
          supported: true,
          launchVerified: true,
        },
        {
          id: 'firefox',
          displayName: 'Firefox',
          detected: true,
          supported: false,
          launchVerified: null,
        },
        {
          id: 'safari',
          displayName: 'Safari',
          detected: true,
          supported: false,
          launchVerified: null,
        },
      ],
      selectedId: 'msedge',
    });
    await click('settings-nav-browsers');
    for (const [id, logo] of [
      ['msedge', 'edge'],
      ['firefox', 'firefox'],
      ['safari', 'safari'],
    ]) {
      expect(
        container
          .querySelector<HTMLImageElement>(`[data-testid="browser-${id}"] img`)
          ?.getAttribute('src'),
      ).toContain(`${logo}.png`);
    }
    expect(
      container.querySelector('[data-testid="browser-firefox"]')?.textContent,
    ).toContain('Reader supportedUnsupported');
    expect(
      container.querySelector('[data-testid="browser-msedge"]')?.textContent,
    ).toContain('Selected reader');
    expect(
      container.querySelector('[data-testid="browser-msedge"]')?.textContent,
    ).toContain('Launch verified');
    expect(container.querySelectorAll('.browser-grid > li')).toHaveLength(3);
    expect(
      container.querySelector('[data-testid="browser-chrome"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="browser-refresh"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="browser-selected"]')?.textContent,
    ).toContain('Microsoft Edge');
  });

  it('reports an automatically selected but failed reader without claiming launch readiness', async () => {
    await click('settings-nav-browsers');
    expect(
      container.querySelector('.browser-tile-selected')?.textContent,
    ).toContain('Chrome');
    expect(
      container.querySelector('[data-testid="browser-chrome"]')?.textContent,
    ).toContain('Launch failed');
    expect(
      container.querySelector('.browser-support-checks')?.textContent,
    ).toContain('Supported reader detected');
    expect(
      container.querySelector('.browser-support-checks')?.textContent,
    ).toContain('Selected reader launch failed');
    expect(container.textContent).toContain('failed its launch check');
    expect(
      container.querySelector('[data-testid="browser-safari"]')?.textContent,
    ).toContain('Reader supportedUnsupported');
    expect(
      container.querySelector(
        '.browser-settings button:not(.ui-disclosure-summary)',
      )?.textContent,
    ).toContain('Check again');
    expect(
      container.querySelector(
        '.browser-settings button:not([data-testid="browser-refresh"])',
      ),
    ).toBeNull();
  });

  it('shows unknown browser identity, missing installations and an unverified selected reader', async () => {
    api.webListBrowsers.mockResolvedValueOnce({
      browsers: [
        {
          id: 'unknown',
          displayName: 'Long experimental reader name',
          detected: true,
          supported: false,
          launchVerified: null,
          reason: 'Not a supported page reader',
        },
        {
          id: 'chrome',
          displayName: 'Google Chrome',
          detected: false,
          supported: true,
          launchVerified: null,
        },
        {
          id: 'msedge',
          displayName: 'Microsoft Edge',
          detected: true,
          supported: true,
          launchVerified: null,
        },
      ],
      selectedId: 'msedge',
    });
    await click('settings-nav-browsers');
    expect(
      container.querySelector('[data-testid="browser-unknown"] svg'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="browser-unknown"]')?.textContent,
    ).toContain('Not a supported page reader');
    expect(
      container.querySelector('[data-testid="browser-chrome"]')?.textContent,
    ).toContain('Not installed');
    expect(
      container.querySelector('[data-testid="browser-msedge"]')?.textContent,
    ).toContain('Selected reader');
    expect(
      container.querySelector('.browser-support-checks')?.textContent,
    ).toContain('launch not verified');
  });

  it('shows empty inventory and detection errors with a usable retry and setup links', async () => {
    api.webListBrowsers.mockResolvedValueOnce({ browsers: [] });
    await click('settings-nav-browsers');
    expect(container.textContent).toContain('No browser entries were reported');
    expect(container.textContent).toContain(
      'No supported Chrome or Edge detected',
    );
    const details =
      container.querySelector<HTMLDetailsElement>('.browser-guidance')!;
    expect(details.open).toBe(false);
    await act(async () => details.querySelector('summary')!.click());
    expect(details.querySelectorAll('a[href^="https://"]')).toHaveLength(2);

    api.webListBrowsers.mockRejectedValueOnce(
      new Error('Browser detection failed.'),
    );
    await click('browser-refresh');
    expect(
      container.querySelector('.browser-settings [role="alert"]')?.textContent,
    ).toContain('Try Check again');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="browser-refresh"]',
      )?.disabled,
    ).toBe(false);
    api.webListBrowsers.mockResolvedValueOnce({ browsers: [] });
    await click('browser-refresh');
    expect(container.textContent).toContain('No browser entries were reported');
  });
  it('keeps the outlet and pill selection in sync and resets only inner scroll', async () => {
    const outlet = container.querySelector<HTMLDivElement>('.settings-outlet')!;
    outlet.scrollTop = 320;
    await click('settings-nav-audio');
    expect(outlet.scrollTop).toBe(0);
    expect(container.querySelector('[data-testid="settings-view-audio"]')).toBe(
      outlet,
    );
    expect(
      container
        .querySelector('[data-testid="settings-nav-audio"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
    // GND style: one wide card, no supporting side cards.
    expect(container.querySelector('.settings-support')).toBeNull();
    expect(api.webListBrowsers).not.toHaveBeenCalled();
    await click('settings-nav-browsers');
    expect(
      container.querySelector('[data-testid="settings-view-browsers"]'),
    ).toBe(outlet);
    expect(api.webListBrowsers).toHaveBeenCalledTimes(1);
    expect(api.getInferenceHardware).toHaveBeenCalledTimes(1);
  });

  it('uses one active section for rapid navigation', async () => {
    const outlet = container.querySelector('.settings-outlet');
    // Meadow art is left out of the GND card, hidden by its styles.
    expect(container.querySelector('.settings-support-decorated')).toBeNull();
    await act(async () => {
      for (const id of [
        'audio',
        'browsers',
        'system',
        'diagnostics',
        'storage',
      ]) {
        container
          .querySelector<HTMLButtonElement>(
            `[data-testid="settings-nav-${id}"]`,
          )!
          .click();
      }
      await tick();
    });
    expect(container.querySelector('.settings-outlet')).toBe(outlet);
    expect(
      container.querySelectorAll('.settings-section-arrival'),
    ).toHaveLength(1);
    expect(
      container.querySelector(
        '[data-testid="settings-view-storage"] .storage-settings',
      ),
    ).not.toBeNull();
    expect(
      container
        .querySelector('[data-testid="settings-nav-storage"]')
        ?.getAttribute('aria-current'),
    ).toBe('page');
    expect(api.getStorageUsage).toHaveBeenCalledTimes(1);
    expect(api.webListBrowsers).not.toHaveBeenCalled();
  });

  it('keeps six subviews local, navigates with arrows, and separates browser states', async () => {
    expect(container.querySelectorAll('.settings-pill')).toHaveLength(6);
    const audio = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-nav-audio"]',
    )!;
    await act(async () => {
      audio.focus();
      audio.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
      await tick();
    });
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="settings-nav-browsers"]'),
    );
    expect(
      container.querySelector('[data-testid="browser-chrome"]')?.textContent,
    ).toContain('Launch failed');
    expect(
      container.querySelector('[data-testid="browser-safari"]')?.textContent,
    ).toContain('Launch not checked');
    await click('browser-refresh');
    expect(api.webListBrowsers).toHaveBeenCalledTimes(2);
    await click('settings-nav-storage');
    expect(
      container.querySelector('[data-testid="storage-settings"]'),
    ).not.toBeNull();
  });

  it('shows failed detection distinctly, never selects cloud models, and preserves choice on save failure', async () => {
    expect(
      container.querySelector('[data-testid="model-select-cloud:4b"]'),
    ).toBeNull();
    api.getInferenceStatus.mockRejectedValueOnce(new Error('private error'));
    await click('ai-refresh');
    expect(container.textContent).toContain(
      'Local AI status could not be loaded.',
    );
    api.getInferenceSettings.mockResolvedValueOnce({
      settings: { ...settings, modelId: null },
      resolvedModel: null,
      warnings: [],
    });
    await click('ai-refresh');
    api.updateInferenceSettings.mockRejectedValueOnce(
      new Error('private error'),
    );
    await click('model-select-local:4b');
    expect(container.textContent).toContain('Previous selection retained');
    expect(container.textContent).not.toContain('Saved selection: local:4b');
  });

  it('verifies audio readiness accurately, and ignores late browser responses after rapid navigation', async () => {
    await click('settings-nav-audio');
    expect(container.querySelectorAll('.audio-peers > .ui-card')).toHaveLength(
      2,
    );
    expect(container.querySelector('.audio-provider .ui-card')).toBeNull();
    expect(container.querySelector('.audio-test .ui-card')).toBeNull();
    api.audioSttProvidersVerify.mockResolvedValue({
      provider: stt,
      verified: false,
    });
    await click('audio-verify-whisper');
    expect(
      container.querySelector('[data-testid="audio-verify-result"]')
        ?.textContent,
    ).toContain('Not ready');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="audio-test-start"]',
      )?.disabled,
    ).toBe(true);
    expect(container.textContent).toContain('No ready provider');
    let release!: (value: unknown) => void;
    api.webListBrowsers.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await click('settings-nav-browsers');
    await click('settings-nav-system');
    await act(async () => {
      release({ browsers: [], selectedId: undefined });
      await tick();
    });
    expect(
      container.querySelector('[data-testid="system-details"]'),
    ).not.toBeNull();
  });

  it('polls a fixed test, requests cancellation, and cleans the timer on unmount', async () => {
    api.runInferenceTest.mockResolvedValue({
      testId: 'test-id',
      status: 'started',
    });
    api.getInferenceTest.mockResolvedValue({
      testId: 'test-id',
      status: 'running',
      firstTokenMs: null,
      durationMs: null,
      replyPreview: null,
      errorCode: null,
    });
    api.cancelInferenceTest.mockResolvedValue(true);
    await click('ai-test-start');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(api.getInferenceTest).toHaveBeenCalledWith('test-id');
    await click('ai-test-cancel');
    expect(api.cancelInferenceTest).toHaveBeenCalledWith('test-id');
    await click('settings-nav-system');
    const count = api.getInferenceTest.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(api.getInferenceTest).toHaveBeenCalledTimes(count);
  });

  it('confirms a saved installed model and displays completed and failed test outcomes', async () => {
    const second = { ...model, id: 'local:2b', displayName: 'Local 2B' };
    api.listInferenceModels.mockResolvedValueOnce([model, second]);
    await click('ai-refresh');
    api.updateInferenceSettings.mockResolvedValue({
      settings: { ...settings, modelId: second.id },
    });
    await click('model-select-local:2b');
    expect(api.updateInferenceSettings).toHaveBeenCalledWith({
      providerId: 'ollama',
      modelId: second.id,
    });
    expect(
      container
        .querySelector('[data-testid="model-select-local:2b"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      container.querySelector('[data-testid="model-select-local:2b"]')
        ?.textContent,
    ).toContain('Selected');

    api.runInferenceTest.mockResolvedValue({
      testId: 'fixed-test',
      status: 'started',
    });
    api.getInferenceTest.mockResolvedValueOnce({
      testId: 'fixed-test',
      status: 'completed',
      passed: true,
      firstTokenMs: 20,
      durationMs: 180,
      replyPreview: 'OK',
      errorCode: null,
    });
    await click('ai-test-start');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(
      container.querySelector('[data-testid="ai-test-result"]')?.textContent,
    ).toContain('completed · Responded');
    expect(
      container.querySelector('[data-testid="ai-test-result"]')?.textContent,
    ).toContain('180 ms');

    api.getInferenceTest.mockResolvedValueOnce({
      testId: 'fixed-test',
      status: 'failed',
      passed: false,
      firstTokenMs: null,
      durationMs: 150,
      replyPreview: null,
      errorCode: 'TIMEOUT',
    });
    await click('ai-test-start');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(
      container.querySelector('[data-testid="ai-test-result"]')?.textContent,
    ).toContain('failed · TIMEOUT');

    api.getInferenceTest.mockResolvedValueOnce({
      testId: 'fixed-test',
      status: 'completed',
      passed: false,
      firstTokenMs: null,
      durationMs: 110,
      replyPreview: '',
      errorCode: null,
    });
    await click('ai-test-start');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(
      container.querySelector('[data-testid="ai-test-result"]')?.textContent,
    ).toContain('completed · Empty reply');
  });

  it('records an independent sample, transcribes it, and cancels unfinished capture', async () => {
    api.audioSttProvidersList.mockResolvedValue([
      { ...stt, state: 'ready', ready: true, reason: null },
    ]);
    api.audioSttJobsStart.mockResolvedValue({ id: 'job-id', status: 'queued' });
    api.audioSttJobsGet.mockResolvedValue({
      id: 'job-id',
      status: 'succeeded',
      transcriptId: 'transcript-id',
    });
    api.audioSttTranscriptsGet.mockResolvedValue({
      empty: false,
      text: 'short sample',
    });
    await click('settings-nav-audio');
    expect(container.textContent).toContain('No recording yet.');
    await click('audio-test-start');
    expect(container.textContent).toContain('Recording sample…');
    expect(capture.start).toHaveBeenCalledWith('Settings transcription sample');
    await click('audio-test-cancel');
    expect(capture.cancel).toHaveBeenCalledOnce();
    await click('audio-test-start');
    await click('audio-test-stop');
    expect(api.audioSttJobsStart).toHaveBeenCalledWith('recording-id', {
      providerId: 'whisper',
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(
      container.querySelector('[data-testid="audio-test-result"]')?.textContent,
    ).toContain('retained');
    expect(container.textContent).toContain('short sample');
    expect(container.querySelector('.audio-transcript')?.textContent).toContain(
      'short sample',
    );
    const transcript = container.querySelector<HTMLElement>(
      '[role="region"][aria-label="Sample transcript"]',
    )!;
    await act(async () => transcript.focus());
    expect(document.activeElement).toBe(transcript);
  });

  it('keeps microphone permission failure distinct from successful engine verification and permits retry', async () => {
    const readyStt = { ...stt, state: 'ready', ready: true, reason: null };
    api.audioSttProvidersList.mockResolvedValue([readyStt]);
    api.audioSttProvidersVerify.mockResolvedValue({
      provider: readyStt,
      verified: true,
    });
    await click('settings-nav-audio');
    await click('audio-verify-whisper');
    expect(
      container.querySelector('[data-testid="audio-verify-result"]')
        ?.textContent,
    ).toContain('does not test microphone capture or transcription');
    expect(capture.start).not.toHaveBeenCalled();

    capture.start.mockRejectedValueOnce(new Error('private permission detail'));
    await click('audio-test-start');
    expect(
      container.querySelector('[data-testid="audio-test-result"]')?.textContent,
    ).toContain('Microphone unavailable or permission denied');
    expect(container.textContent).not.toContain('private permission detail');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="audio-test-start"]',
      )?.disabled,
    ).toBe(false);
    await click('audio-test-start');
    expect(container.textContent).toContain('Recording sample…');
    await click('audio-test-cancel');
    expect(container.textContent).toContain('no sample saved');
  });

  it('retains provider loading, empty and failed states with a working refresh', async () => {
    await click('settings-nav-audio');
    api.audioSttProvidersList.mockResolvedValueOnce([]);
    await click('audio-refresh');
    expect(container.textContent).toContain(
      'No speech-to-text providers reported',
    );
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="audio-test-start"]',
      )?.disabled,
    ).toBe(true);
    api.audioSttProvidersList.mockRejectedValueOnce(
      new Error('private engine path'),
    );
    await click('audio-refresh');
    expect(
      container.querySelector('.audio-provider [role="alert"]')?.textContent,
    ).toContain('Try Refresh');
    expect(container.textContent).not.toContain('private engine path');
    let release!: (value: unknown) => void;
    api.audioSttProvidersList.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    await click('audio-refresh');
    expect(
      container.querySelector('.audio-provider [role="status"]')?.textContent,
    ).toContain('Checking speech engines');
    await act(async () => {
      release([stt]);
      await tick();
    });
    expect(
      container.querySelector('[data-testid="audio-status-whisper"]')
        ?.textContent,
    ).toContain('Model missing');
  });

  it('keeps a pending sample cancellable and offers a retry when transcription polling fails', async () => {
    api.audioSttProvidersList.mockResolvedValue([
      { ...stt, state: 'ready', ready: true, reason: null },
    ]);
    api.audioSttJobsStart.mockResolvedValue({ id: 'job-id', status: 'queued' });
    api.audioSttJobsGet.mockRejectedValueOnce(
      new Error('private polling error'),
    );
    api.audioSttJobsGet.mockResolvedValueOnce({
      id: 'job-id',
      status: 'running',
      transcriptId: null,
    });
    api.audioSttJobsCancel.mockResolvedValue({ cancelled: true });
    await click('settings-nav-audio');
    await click('audio-test-start');
    await click('audio-test-stop');
    expect(container.textContent).toContain('Transcribing sample… queued');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(container.textContent).toContain(
      'Retry the check or cancel the job',
    );
    expect(container.textContent).not.toContain('private polling error');
    await act(async () => {
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          '.audio-test-controls button',
        ),
      ]
        .find((button) => button.textContent === 'Check again')!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(api.audioSttJobsGet).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Transcribing sample… running');
    await click('audio-test-cancel');
    expect(api.audioSttJobsCancel).toHaveBeenCalledWith('job-id');
    expect(container.textContent).toContain(
      'sample recording remains locally stored',
    );
    await click('settings-nav-system');
    expect(api.audioSttJobsCancel).toHaveBeenCalledWith('job-id');
  });

  it('shows real system capacity and partial signals, and recovers after a failed refresh', async () => {
    await click('settings-nav-system');
    expect(
      container.querySelector('[data-testid="system-details"]')?.textContent,
    ).toContain('16.0 GiB');
    expect(container.querySelectorAll('.system-tile')).toHaveLength(6);
    expect(container.textContent).toContain('8 logical CPUs');
    expect(container.textContent).toContain('Chip model not reported');
    expect(container.textContent).toContain('OS release 25.0');
    expect(container.textContent).toContain('darwin · arm64');
    expect(container.textContent).toContain('Free RAM at this snapshot');
    expect(container.textContent).toContain('60.0 GiB');
    expect(container.textContent).toContain('Apple GPU');
    expect(container.textContent).toContain('1.0.0');
    expect(container.textContent).not.toContain('Database size');

    api.getInferenceHardware.mockRejectedValueOnce(
      new Error('private path /Users/example'),
    );
    await click('system-refresh');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'could not be loaded',
    );
    expect(container.textContent).not.toContain('/Users/example');
    api.getInferenceHardware.mockResolvedValueOnce({
      ...hardware,
      freeDiskBytes: null,
      gpuName: null,
      gpuMemoryBytes: null,
      acceleration: 'unknown',
      freeMemoryBytes: 512 * 1024 ** 2,
      osRelease: undefined,
    });
    await click('system-refresh');
    expect(container.textContent).toContain('512.0 MiB');
    expect(container.textContent).toContain('Not reported');
    expect(container.textContent).toContain('OS release not reported');
    expect(container.textContent).toContain('Unknown');
    await click('settings-nav-local-ai');
    await click('settings-nav-system');
    await click('system-refresh');
    expect(container.textContent).toContain('60.0 GiB');
    await act(async () => {
      container.querySelector<HTMLElement>('.system-more summary')!.click();
      await tick();
    });
    expect(
      container.querySelector<HTMLDetailsElement>('.system-more')?.open,
    ).toBe(true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('.settings-text-action')!
        .click();
      await tick();
    });
    expect(
      container.querySelector('[data-testid="settings-view-local-ai"]'),
    ).not.toBeNull();
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="settings-nav-local-ai"]'),
    );
  });

  it('shows raw platform identifiers and ignores stale rapid-refresh results', async () => {
    await click('settings-nav-system');
    let finishOld!: (value: typeof hardware) => void;
    api.getInferenceHardware.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    await click('system-refresh');
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      'Reading',
    );
    api.getInferenceHardware.mockResolvedValueOnce({
      ...hardware,
      platform: 'win32',
      architecture: 'x64',
      osRelease: '10.0.very-long-release-string',
      gpuName: null,
      acceleration: 'unknown',
      freeDiskBytes: null,
      freeMemoryBytes: 0,
    });
    await click('system-refresh');
    expect(container.textContent).toContain('win32 · x64');
    expect(container.textContent).toContain(
      'OS release 10.0.very-long-release-string',
    );
    expect(container.textContent).toContain('0.0 MiB');
    expect(container.textContent).toContain('Unknown');
    await act(async () => {
      finishOld(hardware);
      await tick();
    });
    expect(container.textContent).toContain('win32 · x64');
    expect(container.textContent).not.toContain('darwin · arm64');
  });

  it('shows bounded independent activity projections and only supplied safe fields', async () => {
    api.telemetryRunsList.mockResolvedValueOnce([
      {
        id: 'a',
        moduleId: 'web',
        operation: 'search',
        outcome: 'failure',
        startedAt: '2026-11-08T00:00:00Z',
        finishedAt: '2026-11-08T00:00:01Z',
        durationMs: 1000,
        errorCode: 'RATE_LIMITED',
        privatePrompt: 'DO NOT SHOW',
        stack: 'private stack',
      },
      {
        id: 'b',
        moduleId: 'identity',
        operation: 'profile.update',
        outcome: 'success',
        startedAt: '2026-11-08T00:00:00Z',
        finishedAt: '2026-11-08T00:00:01Z',
        durationMs: 4,
        errorCode: null,
      },
    ]);
    api.listInferenceDiagnostics.mockResolvedValueOnce([
      {
        id: 'c',
        operation: 'generation',
        status: 'success',
        startedAt: '2026-11-08T00:00:00Z',
        finishedAt: '2026-11-08T00:00:01Z',
        durationMs: 500,
        firstTokenMs: 32,
        providerId: 'ollama',
        modelId: 'local:4b',
        inputTokens: 5,
        outputTokens: 8,
        toolCalls: null,
        errorCode: null,
        reply: 'SECRET RESPONSE',
      },
    ]);
    await click('settings-nav-diagnostics');
    expect(api.telemetryRunsList).toHaveBeenCalledWith(50);
    expect(api.listInferenceDiagnostics).toHaveBeenCalledWith(20);
    expect(
      container.querySelector('[data-testid="diagnostics-runs"]')?.textContent,
    ).toContain('RATE_LIMITED');
    expect(
      container.querySelector('[data-testid="diagnostics-inference"]')
        ?.textContent,
    ).toContain('local:4b');
    expect(container.textContent).not.toMatch(
      /DO NOT SHOW|private stack|SECRET RESPONSE|trace span/i,
    );
    await click('diagnostics-inspect-inference');
    const detail = container.querySelector(
      '[data-testid="diagnostics-details"]',
    )!;
    expect(detail.textContent).toContain('32 ms');
    expect(detail.textContent).toContain('ollama');
    expect(detail.textContent).toContain('Not reported');
    expect(detail.textContent).toContain('Operation ID');
    expect(detail.textContent).not.toMatch(/SECRET RESPONSE|prompt/i);

    const select = container.querySelector<HTMLSelectElement>(
      '[data-testid="diagnostics-outcome"]',
    )!;
    await act(async () => {
      select.value = 'failure';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      container.querySelectorAll('[data-testid="diagnostics-runs"] tbody tr'),
    ).toHaveLength(1);
    expect(
      container.querySelector('[data-testid="diagnostics-runs"]')?.textContent,
    ).not.toContain('profile.update');
    expect(container.textContent).toContain(
      'Filters apply only to these loaded records',
    );
    const module = container.querySelector<HTMLSelectElement>(
      '[data-testid="diagnostics-module"]',
    )!;
    await act(async () => {
      module.value = 'identity';
      module.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(
      container.querySelector('[data-testid="diagnostics-filter-empty"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="diagnostics-runs"]'),
    ).toBeNull();
  });

  it('distinguishes empty, failed and unavailable activity, and retries without resetting the other sections', async () => {
    await click('settings-nav-diagnostics');
    expect(
      container.querySelector('[data-testid="diagnostics-empty"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="diagnostics-ai-empty"]'),
    ).not.toBeNull();
    api.systemPing.mockResolvedValueOnce({
      appVersion: '1.0.0',
      apiVersion: 1,
      storageReady: false,
    });
    api.telemetryRunsList.mockRejectedValueOnce(new Error('private exception'));
    api.listInferenceDiagnostics.mockResolvedValueOnce([]);
    await click('diagnostics-refresh');
    expect(container.textContent).toContain('Diagnostics storage unavailable');
    expect(container.textContent).toContain(
      'No Local AI operations recorded yet',
    );
    expect(container.textContent).not.toContain('private exception');
    api.listInferenceDiagnostics.mockRejectedValueOnce(
      new Error('private exception'),
    );
    await click('diagnostics-refresh');
    expect(container.textContent).toContain(
      'Local AI activity could not be loaded',
    );
    await click('diagnostics-refresh');
    expect(
      container.querySelector('[data-testid="diagnostics-empty"]'),
    ).not.toBeNull();
    await click('settings-nav-system');
    expect(
      container.querySelector('[data-testid="system-details"]'),
    ).not.toBeNull();
  });

  describe('GND: Diagnostics inspector', () => {
    const run = (
      id: string,
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      id,
      moduleId: 'web',
      operation: `op-${id}`,
      outcome: 'success',
      startedAt: '2026-11-08T10:00:00Z',
      finishedAt: '2026-11-08T10:00:01Z',
      durationMs: 100,
      errorCode: null,
      ...overrides,
    });
    const text = (testId: string) =>
      container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? '';
    const rows = () =>
      container.querySelectorAll('[data-testid="diagnostics-runs"] tbody tr');
    async function choose(testId: string, value: string) {
      await act(async () => {
        const select = container.querySelector<HTMLSelectElement>(
          `[data-testid="${testId}"]`,
        )!;
        select.value = value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
    async function search(value: string) {
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="diagnostics-search"]',
        )!;
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
    }
    async function inspectRun(index: number) {
      await act(async () => {
        container
          .querySelectorAll<HTMLButtonElement>(
            '[data-testid="diagnostics-inspect-run"]',
          )
          [index].click();
        await tick();
      });
    }

    it('summarises only the loaded records, without a warning count', async () => {
      api.telemetryRunsList.mockResolvedValueOnce([
        run('a', { durationMs: 100 }),
        run('b', { outcome: 'failure', errorCode: 'X', durationMs: 300 }),
        run('c', { outcome: 'failure', durationMs: 200 }),
        run('d', { outcome: 'cancelled', durationMs: 400 }),
      ]);
      await click('settings-nav-diagnostics');
      expect(text('diagnostics-metric-loaded')).toContain('4');
      expect(text('diagnostics-metric-loaded')).toContain(
        'Avg 250 ms across loaded',
      );
      expect(text('diagnostics-metric-success')).toContain('1');
      expect(text('diagnostics-metric-failure')).toContain('2');
      expect(text('diagnostics-metric-cancelled')).toContain('1');
      expect(
        container.querySelectorAll('[data-testid^="diagnostics-metric-"]'),
      ).toHaveLength(4);
      expect(text('diagnostics-metrics')).not.toMatch(/warning|healthy/i);
      expect(container.textContent).toContain(
        'Showing up to 50 recent records · 4 loaded',
      );
      // Filters narrow the table but never the loaded-record counts.
      await choose('diagnostics-outcome', 'failure');
      expect(rows()).toHaveLength(2);
      expect(text('diagnostics-metric-loaded')).toContain('4');
    });

    it('shows unknown metrics while loading or after a failed list, not zeros', async () => {
      api.telemetryRunsList.mockImplementationOnce(() => new Promise(() => {}));
      await click('settings-nav-diagnostics');
      expect(text('diagnostics-metric-failure')).toContain('—');
      expect(text('diagnostics-metric-failure')).toContain('Loading');
      api.telemetryRunsList.mockRejectedValueOnce(new Error('private'));
      await click('diagnostics-refresh');
      expect(text('diagnostics-metric-loaded')).toContain('Unavailable');
      expect(text('diagnostics-metric-failure')).not.toMatch(/\d/);
    });

    it('reports storage readiness as a tri-state without claiming overall health', async () => {
      await click('settings-nav-diagnostics');
      expect(text('diagnostics-storage')).toBe('Local storage ready');
      api.systemPing.mockResolvedValueOnce({
        appVersion: '1.0.0',
        apiVersion: 1,
        storageReady: false,
      });
      await click('diagnostics-refresh');
      expect(text('diagnostics-storage')).toBe('Local storage unavailable');
      api.systemPing.mockRejectedValueOnce(new Error('private'));
      await click('diagnostics-refresh');
      expect(text('diagnostics-storage')).toBe('Storage status unavailable');
      expect(container.textContent).not.toMatch(/all systems|healthy/i);
    });

    it('searches only loaded records and can clear an empty match', async () => {
      api.telemetryRunsList.mockResolvedValueOnce([
        run('a', { operation: 'search', errorCode: 'RATE_LIMITED' }),
        run('b', { moduleId: 'custom.unknown', operation: 'profile.update' }),
      ]);
      await click('settings-nav-diagnostics');
      expect(text('diagnostics-runs')).toContain('custom.unknown');
      await search('rate_lim');
      expect(rows()).toHaveLength(1);
      expect(text('diagnostics-runs')).toContain('RATE_LIMITED');
      await search('custom');
      expect(text('diagnostics-runs')).toContain('profile.update');
      await search('nothing-here');
      expect(text('diagnostics-filter-empty')).toContain(
        'No matches in the loaded records',
      );
      expect(api.telemetryRunsList).toHaveBeenCalledTimes(1);
      await act(async () => {
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="diagnostics-filter-empty"] button',
          )!
          .click();
      });
      expect(rows()).toHaveLength(2);
    });

    it('inspects real run fields and keeps selection consistent across filters and refresh', async () => {
      const failed = run('run-0123456789-abcdef', {
        moduleId: 'web',
        operation: 'search',
        outcome: 'failure',
        errorCode: 'RATE_LIMITED',
        durationMs: 1234,
      });
      api.telemetryRunsList.mockResolvedValueOnce([
        failed,
        run('b', { moduleId: 'identity' }),
      ]);
      await click('settings-nav-diagnostics');
      expect(text('diagnostics-details')).toContain(
        'Select an operation to inspect',
      );

      await inspectRun(0);
      const button = container.querySelector(
        '[data-testid="diagnostics-inspect-run"]',
      )!;
      expect(button.tagName).toBe('BUTTON');
      expect(button.getAttribute('aria-pressed')).toBe('true');
      expect(button.getAttribute('aria-label')).toBe('Inspect search (web)');
      expect(rows()[0].className).toContain('is-selected');
      const details = text('diagnostics-details');
      expect(details).toContain('run-0123456789-abcdef');
      expect(details).toContain('RATE_LIMITED');
      expect(details).toContain('1,234 ms');
      expect(details).toContain('Failure');
      expect(details).toContain('web');

      await choose('diagnostics-module', 'identity');
      expect(
        container.querySelector('[data-testid="diagnostics-details-hidden"]'),
      ).not.toBeNull();
      expect(text('diagnostics-details')).toContain('run-0123456789-abcdef');
      await choose('diagnostics-module', 'all');

      // The same record ID survives a refresh and stays selected.
      api.telemetryRunsList.mockResolvedValueOnce([failed]);
      await click('diagnostics-refresh');
      expect(text('diagnostics-details')).toContain('run-0123456789-abcdef');

      // A refresh that no longer returns it clears the selection.
      api.telemetryRunsList.mockResolvedValueOnce([run('other')]);
      await click('diagnostics-refresh');
      expect(text('diagnostics-details')).toContain(
        'Select an operation to inspect',
      );
      expect(text('diagnostics-details')).not.toContain('RATE_LIMITED');

      // And it does not silently reappear if a later refresh returns it again.
      api.telemetryRunsList.mockResolvedValueOnce([failed]);
      await click('diagnostics-refresh');
      expect(text('diagnostics-details')).toContain(
        'Select an operation to inspect',
      );
    });

    it('never shows stale details while refreshing or after a failed list', async () => {
      api.telemetryRunsList.mockResolvedValueOnce([
        run('a', { errorCode: 'OLD_CODE', outcome: 'failure' }),
      ]);
      await click('settings-nav-diagnostics');
      await inspectRun(0);
      expect(text('diagnostics-details')).toContain('OLD_CODE');
      api.telemetryRunsList.mockImplementationOnce(() => new Promise(() => {}));
      await click('diagnostics-refresh');
      expect(text('diagnostics-details')).not.toContain('OLD_CODE');
      api.telemetryRunsList.mockRejectedValueOnce(new Error('private'));
      await click('diagnostics-refresh');
      expect(text('diagnostics-details')).toContain(
        'Select an operation to inspect',
      );
    });

    it('ignores responses from a superseded refresh', async () => {
      await click('settings-nav-diagnostics');
      let finishOld!: (value: unknown[]) => void;
      api.telemetryRunsList.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      );
      await click('diagnostics-refresh');
      api.telemetryRunsList.mockResolvedValueOnce([
        run('new', { operation: 'fresh.operation' }),
      ]);
      await click('diagnostics-refresh');
      await act(async () => {
        finishOld([run('old', { operation: 'stale.operation' })]);
        await tick();
      });
      expect(text('diagnostics-runs')).toContain('fresh.operation');
      expect(container.textContent).not.toContain('stale.operation');
      expect(text('diagnostics-metric-loaded')).toContain('1');
    });

    it('shows Local AI rows with only reported model IDs and full inspector fields', async () => {
      api.listInferenceDiagnostics.mockResolvedValueOnce([
        {
          id: 'inf-1',
          operation: 'generation',
          status: 'cancelled',
          startedAt: 'not a date',
          finishedAt: 'not a date',
          durationMs: 61_500,
          firstTokenMs: null,
          providerId: null,
          modelId: null,
          inputTokens: null,
          outputTokens: null,
          toolCalls: 2,
          errorCode: 'CANCELLED',
        },
      ]);
      await click('settings-nav-diagnostics');
      const table = text('diagnostics-inference');
      expect(table).toContain('Unknown time');
      expect(table).toContain('1m 01s');
      expect(table).toContain('Cancelled');
      expect(table).not.toContain('Not reported');
      await click('diagnostics-inspect-inference');
      const details = text('diagnostics-details');
      expect(details).toContain('Local AI');
      expect(details).toContain('61,500 ms');
      expect(details).toContain('CANCELLED');
      expect(details).toContain('inf-1');
      expect(details.match(/Not reported/g)).toHaveLength(5);
    });
  });

  it('measures storage, refreshes, and only resets after explicit typed confirmation', async () => {
    await click('settings-nav-storage');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('130 B');
    expect(
      container.querySelectorAll('.storage-grid .storage-tile'),
    ).toHaveLength(6);
    expect(
      container.querySelector('[data-testid="storage-category-audio"]')
        ?.textContent,
    ).toContain('0 B');
    expect(
      container.querySelector('[data-testid="storage-category-session"]')
        ?.textContent,
    ).toContain('App browser sessions');
    const scope =
      container.querySelector<HTMLDetailsElement>('.storage-scope')!;
    expect(scope.open).toBe(false);
    await act(async () => scope.querySelector('summary')!.click());
    expect(scope.open).toBe(true);
    expect(scope.textContent).toContain('personal browser profiles');
    await click('storage-open-reset');
    expect(api.startStorageReset).not.toHaveBeenCalled();
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.activeElement?.textContent).toBe('Cancel');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="storage-confirm-reset"]',
      )?.disabled,
    ).toBe(true);
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[role="dialog"] button')!
        .click();
    });
    expect(api.startStorageReset).not.toHaveBeenCalled();
    await click('storage-open-reset');
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="storage-confirm-input"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(input, 'DELETE ALL APPLICATION DATA');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('storage-confirm-reset');
    expect(api.startStorageReset).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="storage-restarting"]'),
    ).not.toBeNull();
  });

  it('shows partial readings and reset refusals without suggesting completion', async () => {
    api.getStorageUsage.mockResolvedValueOnce({
      categories: [
        { category: 'database', bytes: null },
        { category: 'documents', bytes: 20 },
        { category: 'audio', bytes: 0 },
        { category: 'logs', bytes: 0 },
        { category: 'cache', bytes: 0 },
        { category: 'session', bytes: 0 },
      ],
      totalBytes: null,
      partial: true,
    });
    await click('settings-nav-storage');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('Partial');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).not.toContain('20 B');
    expect(
      container.querySelector('[data-testid="storage-category-database"]')
        ?.textContent,
    ).toContain('Unknown');
    expect(container.textContent).toContain('no complete total');
    api.getStorageUsage.mockRejectedValueOnce(new Error('private path'));
    await click('storage-refresh');
    expect(container.textContent).toContain('Could not measure');
    expect(container.textContent).not.toContain('private path');
    expect(container.textContent).toContain(
      'Previous measurements may be out of date',
    );
    api.startStorageReset.mockRejectedValueOnce(new Error('private path'));
    await click('storage-open-reset');
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="storage-confirm-input"]',
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'DELETE ALL APPLICATION DATA');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click('storage-confirm-reset');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Reset was refused',
    );
    expect(
      container.querySelector('[data-testid="storage-restarting"]'),
    ).toBeNull();
  });

  it('shows unknown on a failed initial reading, then refreshes to real large and zero measurements', async () => {
    api.getStorageUsage.mockRejectedValueOnce(new Error('private path'));
    await click('settings-nav-storage');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('Unknown');
    expect(container.querySelectorAll('.storage-tile')).toHaveLength(0);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not measure',
    );
    expect(container.textContent).not.toContain('private path');

    api.getStorageUsage.mockResolvedValueOnce({
      categories: [
        { category: 'session', bytes: 0 },
        { category: 'cache', bytes: 0 },
        { category: 'logs', bytes: 0 },
        { category: 'audio', bytes: 0 },
        { category: 'documents', bytes: 5 * 1024 ** 3 },
        { category: 'database', bytes: 0 },
      ],
      totalBytes: 5 * 1024 ** 3,
      partial: false,
    });
    await click('storage-refresh');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('5.0 GiB');
    expect(
      container.querySelector('[data-testid="storage-category-documents"]')
        ?.textContent,
    ).toContain('5.0 GiB');
    expect(
      container.querySelector('.storage-tile')?.getAttribute('data-testid'),
    ).toBe('storage-category-database');
    expect(container.querySelector('[role="alert"]')).toBeNull();

    api.getStorageUsage.mockResolvedValueOnce({
      categories: [
        'database',
        'documents',
        'audio',
        'logs',
        'cache',
        'session',
      ].map((category) => ({ category, bytes: 0 })),
      totalBytes: 0,
      partial: false,
    });
    await click('storage-refresh');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('0 B');

    api.getStorageUsage.mockResolvedValueOnce({
      categories: [
        { category: 'database', bytes: 8 },
        { category: 'documents', bytes: null },
      ],
      totalBytes: 8,
      partial: true,
    });
    await click('storage-refresh');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('Partial');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).not.toContain('8 B');
    expect(container.querySelectorAll('.storage-tile')).toHaveLength(2);

    api.getStorageUsage.mockResolvedValueOnce({
      categories: [{ category: 'database', bytes: null }],
      totalBytes: null,
      partial: false,
    });
    await click('storage-refresh');
    expect(
      container.querySelector('[data-testid="storage-total"]')?.textContent,
    ).toContain('Unknown');
    expect(
      container.querySelector('[data-testid="storage-category-database"]')
        ?.textContent,
    ).toContain('Unknown');
  });
});

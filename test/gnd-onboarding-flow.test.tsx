// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Onboarding } from '../src/renderer/presentation/gnd/pages/onboarding/Onboarding';

const api = vi.hoisted(() => ({
  getInferenceSettings: vi.fn(),
  getInferenceHardware: vi.fn(),
  getProviderHealth: vi.fn(),
  listInferenceModels: vi.fn(),
  updateInferenceSettings: vi.fn(),
  importDocument: vi.fn(),
  startCvImport: vi.fn(),
  getCvImport: vi.fn(),
  applyProfileImport: vi.fn(),
  listConfirmedSkills: vi.fn(),
  replaceConfirmedSkills: vi.fn(),
  listTargets: vi.fn(),
  createTarget: vi.fn(),
  createSavedSearch: vi.fn(),
  startDiscoveryRun: vi.fn(),
  executeDiscoveryRun: vi.fn(),
  completeOnboarding: vi.fn(),
}));
vi.mock('../src/renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/api')>()),
  ...api,
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

const flush = () => act(async () => {});
function button(name: string | RegExp) {
  const match = [...container.querySelectorAll('button')].find((b) =>
    typeof name === 'string'
      ? b.textContent?.trim() === name
      : name.test(b.textContent ?? ''),
  );
  if (!match) throw new Error(`No button ${name}`);
  return match;
}
async function click(name: string | RegExp) {
  await act(async () => button(name).click());
  await flush();
}
function step() {
  return container
    .querySelector('[data-testid^="onboarding-step-"]')
    ?.getAttribute('data-testid');
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  play = vi
    .spyOn(HTMLMediaElement.prototype, 'play')
    .mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  api.getInferenceHardware.mockResolvedValue({
    totalMemoryBytes: 16 * 1024 ** 3,
  });
  api.getInferenceSettings.mockResolvedValue({ resolvedModel: null });
  api.getProviderHealth.mockResolvedValue({
    reachable: false,
    state: 'not_installed',
  });
  api.listTargets.mockResolvedValue([]);
  api.createTarget.mockImplementation(async (input) => ({ id: 't', ...input }));
  api.createSavedSearch.mockResolvedValue({ id: 'search-1' });
  api.startDiscoveryRun.mockResolvedValue({ id: 'run-1' });
  api.executeDiscoveryRun.mockResolvedValue({ id: 'run-1' });
  api.completeOnboarding.mockResolvedValue({ completed: true });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('GND onboarding', () => {
  it('without local AI: sets up roles and preferences, then saves the search, starts it and opens Jobs', async () => {
    const onComplete = vi.fn();
    await act(async () => root.render(<Onboarding onComplete={onComplete} />));
    expect(step()).toBe('onboarding-step-welcome');

    await click('Begin');
    expect(step()).toBe('onboarding-step-local-ai');
    expect(container.textContent).toContain(
      'curl -fsSL https://ollama.com/install.sh | sh',
    );

    expect(container.textContent).toContain('ollama pull');
    await click('Done');
    expect(container.textContent).toContain(
      'It looks like you haven’t installed Ollama yet',
    );

    await click('Continue without local AI');
    expect(step()).toBe('onboarding-step-roles');
    expect(button('That’s my direction').disabled).toBe(true);

    const search =
      container.querySelector<HTMLInputElement>('#gnd-role-search')!;
    await act(async () => type(search, 'Product Designer'));
    await act(async () =>
      search.form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    expect(button(/Product Designer/).getAttribute('aria-pressed')).toBe(
      'true',
    );

    await click('That’s my direction');
    expect(step()).toBe('onboarding-step-preferences');
    await act(async () =>
      type(
        container.querySelector<HTMLInputElement>('#gnd-location')!,
        'London',
      ),
    );
    const select =
      container.querySelector<HTMLSelectElement>('#gnd-arrangement')!;
    await act(async () => {
      select.value = 'remote';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('Find roles');

    expect(step()).toBe('onboarding-step-profile');
    expect(container.textContent).toContain('Product Designer');
    expect(container.textContent).toContain('London · Remote');
    expect(api.createSavedSearch).not.toHaveBeenCalled();

    await click('Looks right');
    expect(api.applyProfileImport).not.toHaveBeenCalled();
    expect(api.createTarget).toHaveBeenCalledWith({
      roleTitle: 'Product Designer',
      location: 'London',
      active: true,
    });
    const config = api.createSavedSearch.mock.calls[0][0];
    expect(config.intent).toMatchObject({
      targetRoles: ['Product Designer'],
      location: 'London',
      workArrangement: 'remote',
    });
    expect(api.startDiscoveryRun).toHaveBeenCalledWith('search-1');
    expect(api.executeDiscoveryRun).toHaveBeenCalledWith('run-1');
    expect(api.completeOnboarding).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ destination: 'jobs' });
  });

  it('retrying after a failure does not create a second saved search or run', async () => {
    api.completeOnboarding
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue({ completed: true });
    const onComplete = vi.fn();
    await act(async () => root.render(<Onboarding onComplete={onComplete} />));
    await click('Begin');
    await click('Continue without local AI');
    const search =
      container.querySelector<HTMLInputElement>('#gnd-role-search')!;
    await act(async () => type(search, 'Designer'));
    await act(async () =>
      search.form!.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await click('That’s my direction');
    await click('Find roles');
    await click('Looks right');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    await click('Looks right');
    expect(api.createSavedSearch).toHaveBeenCalledOnce();
    expect(api.startDiscoveryRun).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith({ destination: 'jobs' });
  });

  it('skipping setup still asks for the role, and has no skip there', async () => {
    const onComplete = vi.fn();
    await act(async () => root.render(<Onboarding onComplete={onComplete} />));
    await click('Skip setup');
    expect(api.completeOnboarding).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Your next role');
    expect(
      [...container.querySelectorAll('button')].some(
        (b) => b.textContent === 'Skip setup',
      ),
    ).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('checks Ollama and then the model on one screen, naming whichever is missing', async () => {
    api.getProviderHealth.mockResolvedValue({ reachable: true });
    api.listInferenceModels.mockResolvedValue([]);
    api.updateInferenceSettings.mockResolvedValue({});
    await act(async () => root.render(<Onboarding onComplete={vi.fn()} />));
    await click('Begin');
    await click('Done');
    expect(container.textContent).toContain(
      'Ollama is installed, but the model hasn’t downloaded yet',
    );
    expect(container.textContent).toContain('07728990467');
    api.listInferenceModels.mockResolvedValue([
      { id: 'qwen3.5:9b', installed: true },
    ]);
    await click('Done');
    expect(api.updateInferenceSettings).toHaveBeenCalledWith({
      providerId: 'ollama',
      modelId: 'qwen3.5:9b',
    });
    expect(step()).toBe('onboarding-step-upload');
  });

  it('plays the intro music, and the mute button stops it and is remembered', async () => {
    await act(async () => root.render(<Onboarding onComplete={vi.fn()} />));
    expect(play).toHaveBeenCalled();
    const mute = container.querySelector<HTMLButtonElement>('.gnd-sound')!;
    expect(mute.getAttribute('aria-label')).toBe('Mute music');
    await act(async () => mute.click());
    expect(mute.getAttribute('aria-label')).toBe('Play music');
    expect(window.localStorage.getItem('gnd.introMusic.muted')).toBe('1');
    act(() => root.unmount());
    root = createRoot(container);
    play.mockClear();
    await act(async () => root.render(<Onboarding onComplete={vi.fn()} />));
    expect(play).not.toHaveBeenCalled();
  });

  it('opened from Profile, it has no music and Close saves nothing', async () => {
    const onClose = vi.fn();
    await act(async () =>
      root.render(
        <Onboarding onComplete={vi.fn()} startWithCv onClose={onClose} />,
      ),
    );
    expect(container.querySelector('.gnd-sound')).toBeNull();
    expect(play).not.toHaveBeenCalled();
    await click('Close');
    expect(onClose).toHaveBeenCalled();
    expect(api.completeOnboarding).not.toHaveBeenCalled();
  });

  it('with a local model ready it goes straight to the CV upload', async () => {
    api.getInferenceSettings.mockResolvedValue({
      resolvedModel: { installed: true, locality: 'local' },
    });
    await act(async () => root.render(<Onboarding onComplete={vi.fn()} />));
    await click('Begin');
    expect(step()).toBe('onboarding-step-upload');
    expect(button('Find me roles').disabled).toBe(true);
  });
});

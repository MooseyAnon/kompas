// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Notifications } from '../src/renderer/app/Notifications';
import {
  ApplicationModal,
  AttachFileModal,
  StatusPanel,
} from '../src/renderer/presentation/gnd/pages/applications/ApplicationForms';
import { ApplicationDetailPage } from '../src/renderer/presentation/gnd/pages/applications/ApplicationDetailPage';
import { SearchFilters } from '../src/renderer/presentation/gnd/pages/jobs/SearchFilters';
import { FindingRoles } from '../src/renderer/presentation/gnd/pages/jobs/FindingRoles';
import { newJobDiscoveryConfiguration } from '../src/shared/contracts';

const api = vi.hoisted(() => ({
  recordApplicationStage: vi.fn(),
  createApplicationNote: vi.fn(),
  createApplication: vi.fn(),
  previewApplicationUrl: vi.fn(),
  updateApplication: vi.fn(),
  importDocument: vi.fn(),
  linkApplicationDocument: vi.fn(),
  getApplication: vi.fn(),
  listSavedSearches: vi.fn(),
  createSavedSearch: vi.fn(),
  updateSavedSearch: vi.fn(),
  getProfile: vi.fn(),
  listTargets: vi.fn(),
  listExperiences: vi.fn(),
  startDiscoveryRun: vi.fn(),
  executeDiscoveryWorkflow: vi.fn(),
  getDiscoveryWorkflowState: vi.fn(),
  cancelDiscoveryRun: vi.fn(),
  getInferenceSettings: vi.fn(),
  createExperience: vi.fn(),
  updateProfile: vi.fn(),
  replaceConfirmedSkills: vi.fn(),
}));
vi.mock('../src/renderer/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/renderer/api')>()),
  ...api,
}));

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const APP = '22222222-2222-4222-8222-222222222222';
const stage = (
  kind: string,
  label: string,
  at = '2026-11-05T09:00:00.000Z',
) => ({
  id: `s-${kind}`,
  applicationId: APP,
  stageLabel: label,
  stageKind: kind,
  stageSubtype: null,
  occurredAt: at,
  recordedAt: at,
  source: 'user',
  sourceRef: null,
  sourceEvidence: null,
  correctsEventId: null,
});
const application = (kind = 'applied', label = 'Applied', at?: string) => ({
  id: APP,
  companyName: 'Plaid',
  roleTitle: 'Senior Product Designer',
  location: 'London',
  jobUrl: null,
  appliedAt: '2026-11-05',
  createdAt: '2026-11-03T09:00:00.000Z',
  updatedAt: '2026-11-05T09:00:00.000Z',
  archivedAt: null,
  currentStage: stage(kind, label, at),
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  Object.values(api).forEach((fn) => fn.mockReset());
});
afterEach(() => {
  act(() => root.unmount());
  document.body.innerHTML = '';
});
const text = () => document.body.textContent ?? '';
const button = (label: string) =>
  [...document.body.querySelectorAll('button, a')].find(
    (el) =>
      el.textContent?.trim() === label ||
      el.getAttribute('aria-label') === label,
  ) as HTMLElement;
async function click(label: string) {
  const el = button(label);
  expect(el, label).toBeTruthy();
  await act(async () => el.click());
}
async function type(selector: string, value: string) {
  const input = document.body.querySelector(selector) as HTMLInputElement;
  const proto = Object.getPrototypeOf(input);
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const render = (node: React.ReactNode) =>
  act(async () => root.render(<Notifications>{node}</Notifications>));

describe('update status and fix', () => {
  it('records an interview named by its round, with date and time', async () => {
    api.recordApplicationStage.mockResolvedValue({ id: 'new' });
    const onSaved = vi.fn();
    await render(
      <StatusPanel
        application={application() as never}
        mode="update"
        onClose={vi.fn()}
        onSaved={onSaved}
      />,
    );
    await type('#gnd-round', 'Portfolio review');
    await type('#gnd-int-date', '2026-11-25');
    await type('#gnd-int-time', '14:00');
    await click('Save update');
    expect(api.recordApplicationStage).toHaveBeenCalledWith(
      {
        applicationId: APP,
        stageKind: 'interview',
        stageLabel: 'Portfolio review',
        occurredAt: new Date('2026-11-25T14:00').toISOString(),
      },
      false,
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('fixes the last update as a correction', async () => {
    api.recordApplicationStage.mockResolvedValue({ id: 'fix' });
    await render(
      <StatusPanel
        application={application('interview', 'Portfolio review') as never}
        mode="fix"
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />,
    );
    expect(text()).toContain('Interview · Portfolio review');
    const screening = [...document.body.querySelectorAll('.gnd-choice')].find(
      (el) => el.textContent?.includes('Screening call'),
    ) as HTMLElement;
    await act(async () => screening.querySelector('input')!.click());
    await click('Save fix');
    expect(api.recordApplicationStage).toHaveBeenCalledWith(
      expect.objectContaining({
        stageKind: 'screening',
        stageLabel: 'Screening call',
      }),
      true,
    );
  });
});

describe('add an application', () => {
  it('reads the link and fills in the details', async () => {
    api.previewApplicationUrl.mockResolvedValue({
      extractionSucceeded: true,
      snapshotAvailable: false,
      snapshot: null,
      roleTitle: 'Senior Product Designer',
      companyName: 'Plaid',
      location: 'London',
    });
    api.createApplication.mockResolvedValue({ application: { id: APP } });
    const onDone = vi.fn();
    await render(<ApplicationModal onClose={vi.fn()} onDone={onDone} />);
    await type('#gnd-app-url', 'https://jobs.example.com/plaid/1');
    await click('Continue');
    expect(text()).toContain('We read the listing');
    expect(
      (document.querySelector('#gnd-app-company') as HTMLInputElement).value,
    ).toBe('Plaid');
    await click('Add application');
    expect(api.createApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        companyName: 'Plaid',
        roleTitle: 'Senior Product Designer',
        jobUrl: 'https://jobs.example.com/plaid/1',
        initialStage: expect.objectContaining({ stageKind: 'applied' }),
      }),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it('falls back to typing the details when the page can’t be read', async () => {
    api.previewApplicationUrl.mockRejectedValue(new Error('blocked'));
    await render(<ApplicationModal onClose={vi.fn()} onDone={vi.fn()} />);
    await type('#gnd-app-url', 'https://jobs.example.com/x');
    await click('Continue');
    expect(text()).toContain('We couldn’t read that page');
    await click('Add application');
    expect(text()).toContain('Add the role and the company.');
    expect(api.createApplication).not.toHaveBeenCalled();
  });
});

describe('add a file', () => {
  it('imports the file then links it as the chosen kind', async () => {
    api.importDocument.mockResolvedValue({
      cancelled: false,
      item: { id: 'doc', originalName: 'Letter.pdf', sizeBytes: 86000 },
    });
    const onAdded = vi.fn();
    await render(
      <AttachFileModal
        application={application() as never}
        initialKind="submitted_cover_letter"
        onClose={vi.fn()}
        onAdded={onAdded}
      />,
    );
    await click('Choose file');
    expect(api.importDocument).toHaveBeenCalledWith('cover_letter');
    expect(text()).toContain('Letter.pdf');
    await click('Add file');
    expect(api.linkApplicationDocument).toHaveBeenCalledWith(
      APP,
      'doc',
      'submitted_cover_letter',
      undefined,
    );
    expect(onAdded).toHaveBeenCalled();
  });
});

describe('application details', () => {
  it('puts practice first at the interview stage', async () => {
    api.getApplication.mockResolvedValue({
      application: application(
        'interview',
        'Portfolio review',
        '2099-11-25T14:00:00.000Z',
      ),
      snapshot: null,
      stages: [
        stage('interview', 'Portfolio review', '2099-11-25T14:00:00.000Z'),
      ],
      notes: [],
      documents: [],
    });
    const onNavigate = vi.fn();
    await render(
      <ApplicationDetailPage
        applicationId={APP}
        onBack={vi.fn()}
        onNavigate={onNavigate}
      />,
    );
    const actions = document.querySelector('.gnd-app-where .gnd-actions-row')!;
    expect(actions.children[0].textContent).toContain('Practise interview');
    expect(actions.children[1].textContent).toContain('Update status');
    expect(text()).toContain('Change date');
    await click('Practise interview');
    expect(onNavigate).toHaveBeenCalledWith('interviews', {
      practice: expect.objectContaining({ method: 'deep_loop' }),
    });
  });
});

describe('search filters', () => {
  const key = async (selector: string, k: string) => {
    const input = document.body.querySelector(selector) as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: k, bubbles: true }),
      );
    });
  };
  const blur = async (selector: string) => {
    const input = document.body.querySelector(selector) as HTMLInputElement;
    await act(async () => {
      input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
  };
  const withSearch = (patch: Record<string, unknown> = {}) => {
    const config = newJobDiscoveryConfiguration();
    config.intent.targetRoles = ['Designer'];
    Object.assign(config.intent, patch);
    api.listSavedSearches.mockResolvedValue({
      items: [{ id: 'search', config }],
    });
    api.getProfile.mockResolvedValue({ location: 'Leeds, UK' });
    api.updateSavedSearch.mockResolvedValue({});
    return config;
  };
  const lastIntent = () => api.updateSavedSearch.mock.lastCall?.[1].intent;
  const places = 'input[role="combobox"]';

  it('saves each change and confirms with a toast', async () => {
    withSearch({ location: 'London' });
    await render(<SearchFilters onBack={vi.fn()} onStarted={vi.fn()} />);
    expect(text()).toContain('Your preferences');
    await click('Add role');
    await type(
      'input[placeholder="e.g. Staff Product Designer"]',
      'Design Lead',
    );
    await click('Add');
    expect(lastIntent().targetRoles).toEqual(['Designer', 'Design Lead']);
    await act(async () => new Promise((r) => setTimeout(r, 30)));
    expect(text()).toContain('Changes saved');
  });

  it('keeps at least one role', async () => {
    withSearch();
    await render(<SearchFilters onBack={vi.fn()} onStarted={vi.fn()} />);
    await click('Remove Designer');
    expect(text()).toContain('Keep at least one role');
    expect(api.updateSavedSearch).not.toHaveBeenCalled();
  });

  it('suggests London and the city you are in, and adds places from suggestions without repeats', async () => {
    withSearch();
    await render(<SearchFilters onBack={vi.fn()} onStarted={vi.fn()} />);
    expect(button('Remove London')).toBeTruthy();
    expect(button('Remove Leeds')).toBeTruthy();
    expect(text()).toContain('Suggestions are in yellow');
    await act(async () =>
      (document.body.querySelector(places) as HTMLInputElement).focus(),
    );
    await type(places, 'Manc');
    const option = document.body.querySelector('[role="option"]')!;
    expect(option.textContent).toContain('Manchester');
    await act(async () => (option as HTMLElement).click());
    expect(lastIntent().locations).toEqual(['London', 'Leeds', 'Manchester']);
    expect(lastIntent().location).toBe('London');
    await type(places, 'leeds');
    await key(places, 'Enter');
    expect(document.body.querySelector('[role="option"]')).toBeNull();
    await type(places, 'Leeds');
    await key(places, 'Enter');
    expect(text()).toContain('Leeds is already in your locations');
    await type(places, 'Lon');
    await key(places, 'Enter');
    expect(text()).toContain('London is already in your locations');
    expect(api.updateSavedSearch).toHaveBeenCalledTimes(1);
  });

  it('holds changes until there is a role, and says so beside Roles', async () => {
    const config = newJobDiscoveryConfiguration();
    api.listSavedSearches.mockResolvedValue({ items: [] });
    api.getProfile.mockResolvedValue({ location: null });
    api.listTargets.mockResolvedValue([]);
    api.listExperiences.mockResolvedValue([]);
    void config;
    await render(<SearchFilters onBack={vi.fn()} onStarted={vi.fn()} />);
    await type(places, 'Bristol');
    await key(places, 'Enter');
    expect(api.createSavedSearch).not.toHaveBeenCalled();
    expect(text()).toContain('Add a role first');
    expect(text()).not.toContain('Please check the entered fields');
  });

  it('picks several levels and contract types, and checks the salary inline', async () => {
    withSearch({ location: 'London' });
    await render(<SearchFilters onBack={vi.fn()} onStarted={vi.fn()} />);
    const pick = async (label: string) => {
      const el = [...document.body.querySelectorAll('.gnd-pref-pick')].find(
        (b) => b.textContent?.startsWith(label),
      ) as HTMLElement;
      await act(async () => el.click());
    };
    await pick('Senior');
    await pick('Mid-level');
    expect(lastIntent().experienceLevels).toEqual(['mid', 'senior']);
    await pick('Full-time');
    expect(lastIntent().contractTypes).toEqual(['full_time']);
    const salary = 'input[placeholder="e.g. 45,000"]';
    await type(salary, 'lots');
    await blur(salary);
    expect(text()).toContain('Enter an amount, like 45000 or 45k.');
    await type(salary, '60k');
    await blur(salary);
    expect(lastIntent().salary).toEqual({
      minimum: 60000,
      currency: 'GBP',
      onlyWithSalary: false,
    });
    expect(text()).toContain('£60k+ a year');
  });
});

describe('finding your roles', () => {
  it('opens the results by itself when the run finishes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getDiscoveryWorkflowState.mockResolvedValue({
      id: 'run',
      status: 'completed',
      workActive: false,
      discovery: { planned: 6, submitted: 6, settled: 6, search: {} },
      activeSteps: [],
      counts: {
        admitted: 14,
        verified: 14,
        jdReady: 14,
        matched: 14,
        failed: 0,
      },
      milestones: {},
      diagnostics: [],
      candidates: [],
    });
    const onDone = vi.fn();
    await render(
      <FindingRoles
        runId="run"
        onDone={onDone}
        onRetry={vi.fn()}
        onFilters={vi.fn()}
      />,
    );
    expect(text()).toContain('14');
    expect(button('Your applications')).toBeFalsy();
    await act(async () => vi.advanceTimersByTime(1000));
    expect(onDone).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe('a few questions instead of a CV', () => {
  it('asks for the job title beside the field, then saves it as current experience', async () => {
    const { QuickProfile } =
      await import('../src/renderer/presentation/gnd/pages/applications/ProfileSetup');
    api.createExperience.mockResolvedValue({ id: 'e' });
    api.updateProfile.mockResolvedValue({});
    const onDone = vi.fn();
    await render(
      <QuickProfile
        skills={[]}
        onSkills={vi.fn()}
        onClose={vi.fn()}
        onDone={onDone}
      />,
    );
    await click('Save');
    expect(text()).toContain('Add your job title');
    expect(api.createExperience).not.toHaveBeenCalled();
    await type('#gnd-q-role', 'Product Designer');
    await type('#gnd-q-company', 'Monzo');
    await type('#gnd-q-since', 'last year');
    await click('Save');
    expect(text()).toContain('Enter a year, like 2022.');
    await type('#gnd-q-since', '2022');
    await click('Save');
    expect(api.createExperience).toHaveBeenCalledWith({
      category: 'employment',
      roleTitle: 'Product Designer',
      organisation: 'Monzo',
      startDate: '2022',
      endDate: null,
      description: '',
    });
    expect(api.updateProfile).toHaveBeenCalledWith({
      currentRole: 'Product Designer',
    });
    expect(onDone).toHaveBeenCalled();
  });
});

describe('Ollama reminder in Settings', () => {
  it('asks people who skipped Ollama setup to install it, with the contact number', async () => {
    const { OllamaNudge } =
      await import('../src/renderer/presentation/gnd/pages/settings/OllamaNudge');
    const onSetUp = vi.fn();
    await render(<OllamaNudge onSetUp={onSetUp} />);
    expect(text()).toContain('haven’t installed Ollama yet');
    expect(text()).toContain('07728990467');
    await click('Set up Ollama');
    expect(onSetUp).toHaveBeenCalled();
  });
});

describe('copy buttons', () => {
  it('falls back to a hidden text box when the Clipboard API is refused', async () => {
    const { copyText } =
      await import('../src/renderer/presentation/gnd/pages/onboarding/steps/LocalAiStep');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    const exec = vi.fn().mockReturnValue(true);
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    expect(await copyText('ollama pull qwen3:8b')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(document.querySelector('textarea')).toBeNull();
  });
});

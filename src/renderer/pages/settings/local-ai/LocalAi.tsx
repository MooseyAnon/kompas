import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Box,
  CircleHelp,
  Leaf,
  Play,
  RefreshCw,
  Sparkles,
  Timer,
} from 'lucide-react';
import type {
  HardwareProfile,
  InferenceSettingsGetOutput,
  InferenceStatusGetOutput,
  InferenceTestSnapshot,
  ModelDescriptor,
  ModelRecommendations,
} from '../../../../shared/contracts';
import { INFERENCE_LIMITS } from '../../../../shared/contracts';
import {
  cancelInferenceTest,
  getInferenceHardware,
  getInferenceSettings,
  getInferenceStatus,
  getInferenceTest,
  listInferenceModels,
  recommendInferenceModels,
  runInferenceTest,
  updateInferenceSettings,
} from '../../../api';
import { errorText, sizeText } from '../shared';
import { Button } from '../../../presentation/components/Button';
import { Card, CardButton } from '../../../presentation/components/Card';
import { Disclosure } from '../../../presentation/components/Disclosure';
import ollamaLogo from '../../../presentation/icons/brands/ollama.png';
import { MeadowCardCorner } from '../../../presentation/meadow/decorations/MeadowCardCorner';
import { suggestionFit, suggestions } from './suggestions';
import './LocalAi.css';

type Data = {
  status: InferenceStatusGetOutput;
  hardware: HardwareProfile;
  preferences: InferenceSettingsGetOutput;
  models: ModelDescriptor[];
  recommendations: ModelRecommendations | null;
  recommendationError: string | null;
};
type Load = {
  state: 'loading' | 'error' | 'ready';
  error?: string;
  data?: Data;
};
const labels: Record<string, string> = {
  ready: 'Ready',
  not_running: 'Not running',
  not_installed: 'Not installed',
  error: 'Provider error',
  unknown: 'Status unknown',
  unconfigured: 'Not configured',
};
const terminal = (status: InferenceTestSnapshot['status']) =>
  status !== 'running';
const durationText = (ms: number) =>
  ms % 60_000 === 0 ? `${ms / 60_000} min` : `${ms / 1_000} sec`;

export function LocalAi({
  onHardware,
}: {
  onHardware?: (hardware: HardwareProfile) => void;
}) {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [saveId, setSaveId] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [timeoutSeconds, setTimeoutSeconds] = useState('');
  const [timeoutSaving, setTimeoutSaving] = useState(false);
  const [timeoutMessage, setTimeoutMessage] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  const [test, setTest] = useState<InferenceTestSnapshot | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const mounted = useRef(false);
  const loadSeq = useRef(0);
  const starting = useRef(false);

  const refresh = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoad({ state: 'loading' });
    try {
      const [status, hardware, preferences] = await Promise.all([
        getInferenceStatus(),
        getInferenceHardware(),
        getInferenceSettings(),
      ]);
      const provider = status.providers.find(
        (item) => item.providerId === 'ollama',
      );
      let models: ModelDescriptor[] = [];
      let recommendations: ModelRecommendations | null = null;
      let recommendationError: string | null = null;
      if (provider?.state === 'ready') {
        models = await listInferenceModels('ollama');
        try {
          recommendations = await recommendInferenceModels('ollama');
        } catch (error) {
          recommendationError = errorText(
            error,
            'Fit guidance could not be loaded.',
          );
        }
      }
      if (mounted.current && seq === loadSeq.current) {
        onHardware?.(hardware);
        setLoad({
          state: 'ready',
          data: {
            status,
            hardware,
            preferences,
            models,
            recommendations,
            recommendationError,
          },
        });
      }
    } catch (error) {
      if (mounted.current && seq === loadSeq.current)
        setLoad({
          state: 'error',
          error: errorText(error, 'Local AI status could not be loaded.'),
        });
    }
  }, [onHardware]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      loadSeq.current++;
    };
  }, [refresh]);

  const savedTimeout = load.data?.preferences.settings.generationTimeoutMs;
  useEffect(() => {
    if (savedTimeout !== undefined) {
      setTimeoutSeconds(
        String((savedTimeout ?? INFERENCE_LIMITS.defaultTimeoutMs) / 1_000),
      );
    }
  }, [savedTimeout]);

  useEffect(() => {
    if (!testId || !testBusy) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const snapshot = await getInferenceTest(testId!);
        if (!alive) return;
        setTest(snapshot);
        if (terminal(snapshot.status)) {
          setTestBusy(false);
          setCancelling(false);
        } else timer = setTimeout(() => void poll(), 450);
      } catch (error) {
        if (!alive) return;
        setTestError(errorText(error, 'The test could not be checked.'));
        setTestBusy(false);
        setCancelling(false);
      }
    }
    timer = setTimeout(() => void poll(), 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [testId, testBusy]);

  async function selectModel(id: string) {
    if (saveId) return;
    setSaveId(id);
    setSaveMessage(null);
    try {
      const result = await updateInferenceSettings({
        providerId: 'ollama',
        modelId: id,
      });
      if (!mounted.current) return;
      // The saved value is authoritative; do not optimistically check a radio.
      setLoad((previous) =>
        previous.data
          ? {
              state: 'ready',
              data: {
                ...previous.data,
                preferences: {
                  ...previous.data.preferences,
                  settings: result.settings,
                  resolvedModel:
                    previous.data.models.find((model) => model.id === id) ??
                    null,
                  warnings: [],
                },
              },
            }
          : previous,
      );
      setSaveMessage(`Selected ${id}.`);
    } catch (error) {
      if (mounted.current)
        setSaveMessage(
          errorText(
            error,
            'Could not save the model. Previous selection retained.',
          ),
        );
    } finally {
      if (mounted.current) setSaveId(null);
    }
  }

  async function saveTimeout(value: number | null) {
    if (timeoutSaving) return;
    setTimeoutSaving(true);
    setTimeoutMessage(null);
    try {
      const result = await updateInferenceSettings({
        generationTimeoutMs: value,
      });
      if (!mounted.current) return;
      setLoad((previous) =>
        previous.data
          ? {
              ...previous,
              data: {
                ...previous.data,
                preferences: {
                  ...previous.data.preferences,
                  settings: result.settings,
                },
              },
            }
          : previous,
      );
      setTimeoutSeconds(
        String(
          (result.settings.generationTimeoutMs ??
            INFERENCE_LIMITS.defaultTimeoutMs) / 1_000,
        ),
      );
      setTimeoutMessage(
        value === null ? 'Default restored.' : 'Timeout saved.',
      );
    } catch (error) {
      if (mounted.current)
        setTimeoutMessage(errorText(error, 'Could not save the timeout.'));
    } finally {
      if (mounted.current) setTimeoutSaving(false);
    }
  }

  async function startTest() {
    if (starting.current || testBusy) return;
    starting.current = true;
    setTestBusy(true);
    setTest(null);
    setTestId(null);
    setTestError(null);
    try {
      const started = await runInferenceTest();
      if (!mounted.current) {
        await cancelInferenceTest(started.testId).catch(() => {});
        return;
      }
      setTestId(started.testId);
    } catch (error) {
      if (mounted.current) {
        setTestError(errorText(error, 'Could not start the test.'));
        setTestBusy(false);
      }
    } finally {
      starting.current = false;
    }
  }

  async function cancelTest() {
    if (!testId || cancelling) return;
    setCancelling(true);
    setTestBusy(true);
    try {
      await cancelInferenceTest(testId);
    } catch (error) {
      if (mounted.current) {
        setTestError(errorText(error, 'Could not request cancellation.'));
        setCancelling(false);
      }
    }
    // Poll until the service reports a terminal state, including a late completion.
  }

  const data = load.data;
  const provider = data?.status.providers.find(
    (item) => item.providerId === 'ollama',
  );
  const local =
    data?.models.filter(
      (model) => model.installed && model.locality === 'local',
    ) ?? [];
  const other =
    data?.models.filter(
      (model) => !model.installed || model.locality !== 'local',
    ) ?? [];
  const selected = data?.preferences.settings.modelId;
  const canTest =
    provider?.state === 'ready' &&
    data?.preferences.resolvedModel?.installed &&
    data.preferences.resolvedModel.locality === 'local';
  const selectedFit = data?.recommendations?.items.find(
    (item) => item.modelId === selected,
  );
  const timeoutMs = Number(timeoutSeconds) * 1_000;
  const validTimeout =
    timeoutSeconds.trim() !== '' &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1_000 &&
    timeoutMs <= INFERENCE_LIMITS.maxConfigurableTimeoutMs;
  const effectiveTimeout = savedTimeout ?? INFERENCE_LIMITS.defaultTimeoutMs;

  return (
    <section className="settings-section local-ai" aria-label="Local AI">
      <div className="local-ai-runtime">
        <div className="local-ai-runtime-heading">
          <img
            className="settings-brand local-ai-brand"
            src={ollamaLogo}
            alt="Ollama logo"
          />
          <div>
            <div className="local-ai-runtime-title">
              <h2>Ollama</h2>
              {data && (
                <span
                  className={`settings-badge ${provider?.state === 'ready' ? 'is-ready' : 'is-warning'}`}
                  data-testid="ai-status"
                  role="status"
                >
                  {provider ? labels[provider.state] : 'Provider unknown'}
                </span>
              )}
            </div>
            <p>Private, on-device model runtime</p>
          </div>
        </div>
        <div className="local-ai-runtime-meta">
          <span className="settings-meta">
            {data
              ? `Version ${provider?.runtimeVersion ?? 'unknown'} · Worker ${data.status.worker.state}`
              : 'Check local runtime and models'}
          </span>
          <Button
            variant="secondary"
            onClick={() => void refresh()}
            data-testid="ai-refresh"
            leadingIcon={<RefreshCw aria-hidden="true" />}
          >
            Refresh
          </Button>
        </div>
        <MeadowCardCorner variant="floral" />
      </div>
      {load.state === 'loading' && (
        <p role="status">Checking Ollama and your device…</p>
      )}
      {load.state === 'error' && (
        <p role="alert" className="settings-error">
          {load.error} Try Refresh.
        </p>
      )}
      {data && (
        <>
          {provider?.state !== 'ready' && (
            <Card
              variant="subtle"
              padding="compact"
              className="local-ai-guidance"
            >
              <p>
                {provider?.state === 'not_installed'
                  ? data.hardware.platform === 'darwin'
                    ? 'Install Ollama using the official macOS app installer, then open the Ollama app. '
                    : data.hardware.platform === 'win32'
                      ? 'Install and open Ollama using the official Windows installer. '
                      : 'See the official Ollama instructions for your operating system. '
                  : null}
                {provider?.state === 'not_running'
                  ? 'Ollama is not responding. If installed, open the Ollama app, then Refresh; a failed connection does not prove it is absent.'
                  : provider?.state === 'not_installed'
                    ? 'Ollama is not installed. Use the official installer, open the app, then Refresh.'
                    : 'Ollama status could not be confirmed. If installed, open the app and retry Refresh.'}{' '}
                <a
                  href="https://ollama.com/download"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Official Ollama download
                </a>
                .
              </p>
            </Card>
          )}
          <div className="local-ai-peers">
            <Card padding="compact" className="local-ai-models">
              <h3>
                <Box size={19} aria-hidden="true" /> Installed models
              </h3>
              {provider?.state !== 'ready' ? (
                <p>Model inventory unavailable until Ollama is ready.</p>
              ) : local.length === 0 ? (
                <p>
                  No confirmed installed-local models reported. Ollama can be
                  ready without a model.
                </p>
              ) : (
                <div className="settings-model-list">
                  {local.map((model) => (
                    <CardButton
                      key={model.id}
                      selected={selected === model.id}
                      data-testid={`model-select-${model.id}`}
                      disabled={saveId !== null || selected === model.id}
                      onClick={() => void selectModel(model.id)}
                      className="settings-model-row"
                    >
                      <span className="settings-model-name">
                        <strong>{model.displayName}</strong>
                        <span>
                          {saveId === model.id
                            ? 'Saving…'
                            : selected === model.id
                              ? 'Selected'
                              : 'Select'}
                        </span>
                      </span>
                      <span className="settings-meta">
                        {model.displayName === model.id ? '' : `${model.id} · `}
                        {sizeText(model.sizeBytes)} download size
                        {model.quantization ? ` · ${model.quantization}` : ''}
                      </span>
                    </CardButton>
                  ))}
                </div>
              )}
            </Card>
            <Card padding="compact" className="local-ai-inference">
              <p className="local-ai-eyebrow">Selected model</p>
              <h3 className="local-ai-selected-name">
                {selected ?? 'No model selected'}
              </h3>
              {(!selected || !data.preferences.resolvedModel) && (
                <p className="settings-meta">
                  {selected
                    ? 'Saved selection is currently unavailable.'
                    : 'Choose an installed local model to begin.'}
                </p>
              )}
              <p className="local-ai-fit">
                <Leaf size={16} aria-hidden="true" />
                {selectedFit
                  ? `Fit: ${selectedFit.fit === 'likely' ? 'Possibly suitable' : 'Uncertain'} · memory guidance only`
                  : 'Fit unknown · memory guidance only'}
              </p>
              {selectedFit?.warnings.map((warning, index) => (
                <p className="local-ai-caution" key={index}>
                  {warning}
                </p>
              ))}
              {data.preferences.warnings.map((warning, index) => (
                <p className="settings-error" key={index}>
                  {warning}
                </p>
              ))}
              {data.recommendationError && (
                <p className="settings-error">
                  {data.recommendationError} Fit is unknown.
                </p>
              )}
              {saveMessage && (
                <p role="status" data-testid="model-save-state">
                  {saveMessage}
                </p>
              )}
              <p className="local-ai-test-note">
                Fixed app prompt, no personal content. Checks connectivity and
                response, not answer quality or benchmark speed.
              </p>
              <div className="local-ai-test-row">
                <div className="settings-controls">
                  <Button
                    data-testid="ai-test-start"
                    disabled={!canTest || testBusy || saveId !== null}
                    onClick={() => void startTest()}
                    leadingIcon={<Play aria-hidden="true" />}
                  >
                    {testBusy ? 'Testing…' : 'Run inference test'}
                  </Button>
                  {testId &&
                    (testBusy || testError) &&
                    test?.status !== 'completed' &&
                    test?.status !== 'cancelled' &&
                    test?.status !== 'failed' && (
                      <Button
                        variant="secondary"
                        data-testid="ai-test-cancel"
                        disabled={cancelling}
                        onClick={() => void cancelTest()}
                      >
                        {cancelling ? 'Cancelling…' : 'Cancel'}
                      </Button>
                    )}
                  {testError && testId && !testBusy && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setTestError(null);
                        setTestBusy(true);
                      }}
                    >
                      Check again
                    </Button>
                  )}
                </div>
                {test && (
                  <dl data-testid="ai-test-result" className="settings-result">
                    <dt>Outcome</dt>
                    <dd>
                      {test.status}
                      {test.status === 'completed'
                        ? test.passed
                          ? ' · Responded'
                          : ' · Empty reply'
                        : ''}
                      {test.errorCode ? ` · ${test.errorCode}` : ''}
                    </dd>
                    <dt>First token</dt>
                    <dd>
                      {test.firstTokenMs === null
                        ? 'Unknown'
                        : `${test.firstTokenMs} ms`}
                    </dd>
                    <dt>Total time</dt>
                    <dd>
                      {test.durationMs === null
                        ? 'Unknown'
                        : `${test.durationMs} ms`}
                    </dd>
                    {test.replyPreview !== null && (
                      <>
                        <dt>Reply preview</dt>
                        <dd className="settings-code">
                          {test.replyPreview || '(empty)'}
                        </dd>
                      </>
                    )}
                  </dl>
                )}
              </div>
              {!canTest && (
                <p>Select an installed local model to enable the test.</p>
              )}
              {testBusy && (
                <p role="status">
                  {cancelling
                    ? 'Cancellation requested…'
                    : 'Waiting for a response…'}
                </p>
              )}
              {testError && (
                <p role="alert" className="settings-error">
                  {testError}
                </p>
              )}
            </Card>
          </div>
          <div className="local-ai-extras">
            <Card padding="compact" className="local-ai-suggestions">
              <h3>
                <Sparkles size={19} aria-hidden="true" /> Suggested models
              </h3>
              <p className="settings-meta">
                Ideas to install yourself with Ollama; this app never installs
                them.
              </p>
              <ul className="local-ai-suggestion-list">
                {suggestions.map((item) => (
                  <li key={item.tag} className="local-ai-suggestion">
                    <Box size={20} aria-hidden="true" />
                    <span>
                      <strong>
                        {item.family} · {item.tag}
                      </strong>
                      <span className="settings-meta">
                        {item.weight} · {item.ramGb}+ GB RAM ·{' '}
                        {suggestionFit(
                          data.hardware.totalMemoryBytes,
                          item.ramGb,
                        )}
                      </span>
                    </span>
                    <code className="settings-code">
                      ollama pull {item.tag}
                    </code>
                  </li>
                ))}
              </ul>
              <p className="settings-meta">
                Check current tags:{' '}
                <a
                  href="https://ollama.com/library/qwen3.5"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Qwen 3.5
                </a>{' '}
                ·{' '}
                <a
                  href="https://ollama.com/library/gemma4"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Gemma 4
                </a>
              </p>
            </Card>
            <Card padding="compact" className="local-ai-timeout-card">
              <h3>
                <Timer size={19} aria-hidden="true" /> Response time limit
              </h3>
              <div className="local-ai-timeout">
                <label htmlFor="generation-timeout">
                  Generation target (seconds)
                </label>
                <p className="settings-meta" id="generation-timeout-help">
                  Default 5 min. A running model may continue for twice the
                  target before it stops.
                </p>
                <div className="settings-controls">
                  <input
                    id="generation-timeout"
                    data-testid="ai-timeout-input"
                    type="number"
                    min="1"
                    step="1"
                    value={timeoutSeconds}
                    aria-describedby="generation-timeout-help"
                    onChange={(event) => {
                      setTimeoutSeconds(event.target.value);
                      setTimeoutMessage(null);
                    }}
                  />
                  <Button
                    variant="secondary"
                    data-testid="ai-timeout-save"
                    disabled={
                      !validTimeout ||
                      timeoutSaving ||
                      timeoutMs === savedTimeout
                    }
                    onClick={() => void saveTimeout(timeoutMs)}
                  >
                    {timeoutSaving ? 'Saving…' : 'Save timeout'}
                  </Button>
                  <Button
                    variant="ghost"
                    data-testid="ai-timeout-reset"
                    disabled={timeoutSaving || savedTimeout === null}
                    onClick={() => void saveTimeout(null)}
                  >
                    Use default
                  </Button>
                </div>
                {!validTimeout && timeoutSeconds !== '' && (
                  <p role="alert" className="settings-error">
                    Enter a whole number of seconds within the supported timer
                    range.
                  </p>
                )}
                <p className="settings-meta" data-testid="ai-timeout-effective">
                  Saved target: {durationText(effectiveTimeout)} · Stop after:{' '}
                  {durationText(effectiveTimeout * 2)}
                </p>
                {timeoutMessage && <p role="status">{timeoutMessage}</p>}
              </div>
              <MeadowCardCorner variant="subtle" />
            </Card>
          </div>
          <div className="local-ai-secondary">
            <Disclosure
              label={
                <span>
                  <Box size={16} aria-hidden="true" /> Model inventory & memory
                  details
                </span>
              }
            >
              {other.length > 0 && (
                <p>
                  Other Ollama entries (not confirmed installed-local; cannot
                  select):{' '}
                  {other
                    .map(
                      (model) =>
                        `${model.displayName} · ${model.id} (${model.locality}, ${model.installed ? 'listed' : 'not installed'})`,
                    )
                    .join(', ')}
                  .
                </p>
              )}
              {selectedFit?.reasons.map((reason, index) => (
                <p key={index}>{reason}</p>
              ))}
              {data.recommendations?.notes.map((note, index) => (
                <p key={index}>{note}</p>
              ))}
              <dl>
                <dt>System</dt>
                <dd>
                  {data.hardware.platform} · {data.hardware.architecture}
                </dd>
                <dt>Total RAM</dt>
                <dd>{sizeText(data.hardware.totalMemoryBytes)}</dd>
                <dt>Available now</dt>
                <dd>{sizeText(data.hardware.freeMemoryBytes)}</dd>
                <dt>Acceleration</dt>
                <dd>{data.hardware.acceleration}</dd>
              </dl>
              {data.hardware.notes.map((note, index) => (
                <p key={index}>{note}</p>
              ))}
              <p>
                Memory and model fit are rough guidance, never a performance
                guarantee. File size is not runtime memory use.
              </p>
            </Disclosure>
          </div>
          <p className="settings-meta settings-footnote">
            <CircleHelp size={16} aria-hidden="true" /> This workspace never
            installs, starts or downloads Ollama or models for you.
          </p>
        </>
      )}
    </section>
  );
}

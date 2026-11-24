import React, { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import {
  getInferenceHardware,
  getProviderHealth,
  listInferenceModels,
  updateInferenceSettings,
} from '../../../../api';
import { Button } from '../../../components/Button';
import {
  suggestionFit,
  suggestions,
} from '../../../../pages/settings/local-ai/suggestions';
import './OllamaSetup.css';

const OLLAMA = 'ollama';
type Platform = 'unix' | 'windows';

const PLATFORMS: Record<
  Platform,
  { label: string; shell: string; install: string }
> = {
  unix: {
    label: 'Mac & Linux',
    shell: 'Terminal',
    install: 'curl -fsSL https://ollama.com/install.sh | sh',
  },
  windows: {
    label: 'Windows',
    shell: 'PowerShell',
    install: 'irm https://ollama.com/install.ps1 | iex',
  },
};

const HELP = 'If you get stuck, message 07728990467.';
export const NO_OLLAMA = `The Ollama program isn’t installed yet. Run the first command, then press Done. ${HELP}`;
export const NOT_RUNNING = `The Ollama program is installed but isn’t open. Open the Ollama app, then press Done. ${HELP}`;
export const NO_MODEL = `Ollama is installed, but the model hasn’t downloaded yet. Run the second command and wait for it to finish. ${HELP}`;

/** Which part is missing: the Ollama program, or the model it runs. */
export function setupMessage(
  health: {
    reachable: boolean;
    state?: string;
    runtimeVersion?: string | null;
  } | null,
  modelCount: number,
  model: string,
): string | null {
  if (!health?.reachable)
    return health?.state === 'not_running' ? NOT_RUNNING : NO_OLLAMA;
  if (modelCount > 0) return null;
  const version = health.runtimeVersion
    ? ` (you have Ollama ${health.runtimeVersion})`
    : '';
  return `The Ollama program is installed${version}, but the model ${model} isn’t downloaded yet. Run the second command and wait for it to finish. If it says it needs a newer version of Ollama, update Ollama from ollama.com, then run it again. ${HELP}`;
}

/** The largest suggested model that should fit this machine's memory. */
export function pickModel(totalBytes: number | null): string {
  const fitting = suggestions.filter(
    (item) =>
      item.family === 'Qwen 3.5' &&
      suggestionFit(totalBytes, item.ramGb) === 'Might fit',
  );
  return (fitting.at(-1) ?? suggestions[0]).tag;
}

/**
 * Install Ollama and download the model in one screen: pick your computer,
 * copy two commands into Terminal, press Done. Done checks Ollama first, then
 * the model, and says which one is missing.
 */
export function OllamaSetup({
  onReady,
  onSkip,
  skipLabel = 'Continue without local AI',
}: {
  onReady: () => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const [platform, setPlatform] = useState<Platform>(
    navigator.platform.startsWith('Win') ? 'windows' : 'unix',
  );
  const [model, setModel] = useState<string>(suggestions[1].tag);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void getInferenceHardware()
      .then((hardware) => setModel(pickModel(hardware.totalMemoryBytes)))
      .catch(() => {});
  }, []);

  async function check() {
    setBusy(true);
    setMessage('');
    try {
      const health = await getProviderHealth(OLLAMA).catch(() => null);
      const installed = health?.reachable
        ? (await listInferenceModels(OLLAMA)).filter((item) => item.installed)
        : [];
      const problem = setupMessage(health, installed.length, model);
      if (problem) return setMessage(problem);
      const chosen =
        installed.find((item) => item.id === model) ??
        installed.find((item) => item.id.startsWith(model.split(':')[0])) ??
        installed[0];
      await updateInferenceSettings({ providerId: OLLAMA, modelId: chosen.id });
      onReady();
    } catch {
      setMessage(`Couldn’t check Ollama. Please try again. ${HELP}`);
    } finally {
      setBusy(false);
    }
  }

  const keys = Object.keys(PLATFORMS) as Platform[];
  const { shell, install } = PLATFORMS[platform];

  return (
    <div className="gnd-ollama">
      <div
        className="gnd-segmented"
        role="radiogroup"
        aria-label="Your computer"
        style={
          {
            '--count': keys.length,
            '--index': keys.indexOf(platform),
          } as React.CSSProperties
        }
      >
        <span className="gnd-segmented-pill" aria-hidden="true" />
        {keys.map((key) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={platform === key}
            className="gnd-segment"
            onClick={() => setPlatform(key)}
          >
            {PLATFORMS[key].label}
          </button>
        ))}
      </div>

      <ol className="gnd-steps">
        <li>
          <span className="gnd-step-number" aria-hidden="true">
            1
          </span>
          <span>
            Open <strong>{shell}</strong>
          </span>
        </li>
        <li>
          <span className="gnd-step-number" aria-hidden="true">
            2
          </span>
          <span>Install Ollama: copy and run</span>
        </li>
        <li className="gnd-steps-command">
          <CommandBox key={install} command={install} />
        </li>
        <li>
          <span className="gnd-step-number" aria-hidden="true">
            3
          </span>
          <span>Then download the model Kompas uses</span>
        </li>
        <li className="gnd-steps-command">
          <CommandBox key={model} command={`ollama pull ${model}`} />
        </li>
        <li>
          <span className="gnd-step-number" aria-hidden="true">
            4
          </span>
          <span>Wait for both to finish, then press Done</span>
        </li>
      </ol>

      {message && (
        <p className="gnd-message is-error" role="alert">
          {message}
        </p>
      )}

      <div className="gnd-ollama-actions">
        <Button size="hero" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Done'}
        </Button>
        {onSkip && (
          <button type="button" className="gnd-text-link" onClick={onSkip}>
            {skipLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (await copyText(command)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <div className="gnd-command">
      <code>{command}</code>
      <button
        type="button"
        className="gnd-command-copy"
        aria-label={copied ? 'Copied' : 'Copy command'}
        onClick={() => void copy()}
      >
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
    </div>
  );
}

/** Copy text, falling back to a hidden text box when the Clipboard API is refused. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', '');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    box.remove();
    return ok;
  }
}

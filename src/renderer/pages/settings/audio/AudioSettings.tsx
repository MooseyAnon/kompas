import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, RefreshCw, AudioLines } from 'lucide-react';
import type { SttJob, SttProvider } from '../../../../shared/contracts';
import {
  audioSttJobsCancel,
  audioSttJobsGet,
  audioSttJobsStart,
  audioSttProvidersList,
  audioSttProvidersVerify,
  audioSttTranscriptsGet,
} from '../../../api';
import { MicrophoneRecorder } from '../../../audio/capture';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { errorText, sizeText } from '../shared';
import './AudioSettings.css';

const reasons: Record<string, string> = {
  model_missing: 'Model missing',
  model_corrupt: 'Model damaged',
  executable_missing: 'Engine missing',
  unsupported_platform: 'Unsupported on this device',
  provider_unavailable: 'Provider unavailable',
};
type Load = {
  state: 'loading' | 'error' | 'ready';
  items: SttProvider[];
  error?: string;
};

export function AudioSettings() {
  const [load, setLoad] = useState<Load>({ state: 'loading', items: [] });
  const [verifying, setVerifying] = useState<string | null>(null);
  const [verifyResult, setVerifyResult] = useState<string | null>(null);
  const [phase, setPhase] = useState<
    'idle' | 'starting' | 'recording' | 'transcribing'
  >('idle');
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [job, setJob] = useState<SttJob | null>(null);
  const [pollAttempt, setPollAttempt] = useState(0);
  const [pollError, setPollError] = useState(false);
  const [transcript, setTranscript] = useState<string | null>(null);
  const recorder = useRef<MicrophoneRecorder | null>(null);
  const activeJob = useRef<string | null>(null);
  const active = useRef(false);
  const seq = useRef(0);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    const current = ++seq.current;
    setLoad({ state: 'loading', items: [] });
    try {
      const items = await audioSttProvidersList();
      if (active.current && current === seq.current)
        setLoad({ state: 'ready', items });
    } catch (error) {
      if (active.current && current === seq.current)
        setLoad({
          state: 'error',
          items: [],
          error: errorText(error, 'Speech engine status could not be loaded.'),
        });
    }
  }, []);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      seq.current++;
      recorder.current?.dispose();
      if (activeJob.current)
        void audioSttJobsCancel(activeJob.current).catch(() => {});
    };
  }, [refresh]);

  useEffect(() => {
    if (!job) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await audioSttJobsGet(job!.id);
        if (!alive) return;
        setPollError(false);
        setJob(next);
        if (next.status === 'queued' || next.status === 'running') {
          timer = setTimeout(() => void poll(), 500);
          return;
        }
        activeJob.current = null;
        setPhase('idle');
        busy.current = false;
        if (next.status === 'succeeded' && next.transcriptId) {
          try {
            const result = await audioSttTranscriptsGet(next.transcriptId);
            if (alive) {
              setTranscript(
                result.empty ? '(No speech detected)' : result.text,
              );
              setTestMessage(
                'Transcription completed. The sample recording is retained in local Audio storage.',
              );
            }
          } catch (error) {
            if (alive)
              setTestMessage(
                errorText(
                  error,
                  'Transcription succeeded, but its text could not be loaded.',
                ),
              );
          }
        } else
          setTestMessage(
            `Transcription ${next.status}${next.errorCode ? ` · ${next.errorCode}` : ''}. The sample recording is retained locally.`,
          );
      } catch (error) {
        if (alive) {
          setPollError(true);
          setTestMessage(
            `${errorText(error, 'Could not check transcription.')} Retry the check or cancel the job.`,
          );
        }
      }
    }
    timer = setTimeout(() => void poll(), 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [job?.id, pollAttempt]);

  async function verify(providerId: string) {
    if (verifying) return;
    setVerifying(providerId);
    setVerifyResult(null);
    try {
      const result = await audioSttProvidersVerify(providerId);
      if (!active.current) return;
      setLoad((old) => ({
        ...old,
        items: old.items.map((item) =>
          item.providerId === providerId ? result.provider : item,
        ),
      }));
      setVerifyResult(
        result.verified
          ? `${providerId}: Engine and model verified as ready. This does not test microphone capture or transcription.`
          : `${providerId}: Not ready · ${result.provider.reason ? (reasons[result.provider.reason] ?? result.provider.reason) : 'Unknown reason'}.`,
      );
    } catch (error) {
      if (active.current)
        setVerifyResult(errorText(error, 'Verification failed.'));
    } finally {
      if (active.current) setVerifying(null);
    }
  }

  async function beginSample() {
    if (busy.current) return;
    busy.current = true;
    setPhase('starting');
    setTranscript(null);
    setTestMessage(null);
    setPollError(false);
    setJob(null);
    const capture = new MicrophoneRecorder({
      onError: () => {
        if (active.current)
          setTestMessage(
            'Microphone upload failed. Cancel the recording and retry.',
          );
      },
    });
    recorder.current = capture;
    try {
      await capture.start('Settings transcription sample');
      if (!active.current) {
        capture.dispose();
        return;
      }
      setPhase('recording');
    } catch (error) {
      capture.dispose();
      recorder.current = null;
      busy.current = false;
      if (active.current) {
        setPhase('idle');
        setTestMessage(
          errorText(
            error,
            'Microphone unavailable or permission denied. Check device permissions and try again.',
          ),
        );
      }
    }
  }

  async function finishSample(providerId: string) {
    const capture = recorder.current;
    if (!capture || phase !== 'recording') return;
    setPhase('transcribing');
    recorder.current = null;
    try {
      const recording = await capture.stop();
      if (!active.current) return;
      const started = await audioSttJobsStart(recording.id, { providerId });
      if (!active.current) {
        await audioSttJobsCancel(started.id).catch(() => {});
        return;
      }
      activeJob.current = started.id;
      setJob(started);
      setTestMessage('Sample saved locally. Transcribing…');
    } catch (error) {
      if (active.current) {
        busy.current = false;
        setPhase('idle');
        setTestMessage(
          errorText(error, 'The sample could not be transcribed.'),
        );
      }
    }
  }

  async function cancelSample() {
    if (recorder.current) {
      const capture = recorder.current;
      recorder.current = null;
      await capture.cancel();
      if (active.current) {
        busy.current = false;
        setPhase('idle');
        setTestMessage('Recording cancelled; no sample saved.');
      }
    } else if (job) {
      try {
        await audioSttJobsCancel(job.id);
        if (active.current)
          setTestMessage(
            'Cancellation requested. The sample recording remains locally stored.',
          );
      } catch (error) {
        if (active.current)
          setTestMessage(errorText(error, 'Could not cancel transcription.'));
      }
    }
  }

  const ready = load.items.find((item) => item.ready && item.state === 'ready');
  return (
    <section className="settings-section audio-settings" aria-label="Audio">
      <div className="audio-heading">
        <span className="audio-heading-icon" aria-hidden="true">
          <Mic size={25} />
        </span>
        <div>
          <h2>Audio</h2>
          <p>Check speech-to-text readiness and test a local sample.</p>
        </div>
      </div>
      <div className="audio-peers">
        <Card
          className="audio-panel audio-provider"
          header={
            <h3>
              <AudioLines size={20} aria-hidden="true" /> Whisper /
              speech-to-text
            </h3>
          }
        >
          <div className="audio-provider-toolbar">
            <p className="settings-meta">
              Provider check · not a microphone test
            </p>
            <Button
              variant="secondary"
              leadingIcon={<RefreshCw aria-hidden="true" />}
              data-testid="audio-refresh"
              onClick={() => void refresh()}
            >
              Refresh
            </Button>
          </div>
          {load.state === 'loading' && (
            <p role="status">Checking speech engines…</p>
          )}
          {load.state === 'error' && (
            <p role="alert" className="settings-error">
              {load.error} Try Refresh.
            </p>
          )}
          {load.state === 'ready' && load.items.length === 0 && (
            <p>No speech-to-text providers reported for this build.</p>
          )}
          {load.state === 'ready' && (
            <ul className="audio-provider-list">
              {load.items.map((item) => (
                <li className="audio-provider-detail" key={item.providerId}>
                  <div className="audio-provider-name">
                    <strong>{item.engine}</strong>
                    <span
                      className={`settings-badge ${item.ready && item.state === 'ready' ? 'is-ready' : 'is-warning'}`}
                      data-testid={`audio-status-${item.providerId}`}
                    >
                      {item.ready
                        ? 'Ready'
                        : `Unavailable · ${item.reason ? (reasons[item.reason] ?? item.reason) : 'Unknown reason'}`}
                    </span>
                  </div>
                  <dl>
                    <dt>Version</dt>
                    <dd>{item.engineVersion ?? 'Unknown'}</dd>
                    <dt>Model</dt>
                    <dd>
                      {item.model
                        ? `${item.model.displayName} · ${sizeText(item.model.bytes)}`
                        : 'Not reported'}
                    </dd>
                    <dt>Offline</dt>
                    <dd>{item.offline ? 'Yes' : 'No'}</dd>
                  </dl>
                  <Button
                    variant="secondary"
                    data-testid={`audio-verify-${item.providerId}`}
                    disabled={verifying !== null}
                    onClick={() => void verify(item.providerId)}
                  >
                    {verifying === item.providerId
                      ? 'Verifying…'
                      : 'Verify engine/model'}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {verifyResult && (
            <p
              role="status"
              className="audio-result"
              data-testid="audio-verify-result"
            >
              {verifyResult}
            </p>
          )}
        </Card>
        <Card
          className="audio-panel audio-test"
          header={
            <h3>
              <Mic size={19} aria-hidden="true" /> Test transcription
            </h3>
          }
        >
          <p className="audio-test-intro">
            Record a few seconds with microphone permission, then transcribe it
            on this device. The completed sample remains in local Audio storage;
            no interview is created.
          </p>
          <div className="audio-test-controls">
            {phase === 'idle' && (
              <Button
                leadingIcon={<Mic aria-hidden="true" />}
                data-testid="audio-test-start"
                disabled={!ready}
                onClick={() => void beginSample()}
              >
                Record sample
              </Button>
            )}
            {phase === 'recording' && (
              <Button
                data-testid="audio-test-stop"
                onClick={() => void finishSample(ready!.providerId)}
              >
                Stop & transcribe
              </Button>
            )}
            {phase === 'transcribing' && job && pollError && (
              <Button
                variant="secondary"
                onClick={() => setPollAttempt((value) => value + 1)}
              >
                Check again
              </Button>
            )}
            {phase !== 'idle' && (
              <Button
                variant="secondary"
                data-testid="audio-test-cancel"
                disabled={
                  phase === 'starting' || (phase === 'transcribing' && !job)
                }
                onClick={() => void cancelSample()}
              >
                Cancel
              </Button>
            )}
          </div>
          <div className="audio-test-status" role="status">
            {phase === 'starting' && 'Requesting microphone permission…'}
            {phase === 'recording' && 'Recording sample…'}
            {phase === 'transcribing' &&
              `Transcribing sample… ${job?.status ?? 'saving'}`}
            {phase === 'idle' && !testMessage && 'No recording yet.'}
            {testMessage && (
              <span data-testid="audio-test-result">{testMessage}</span>
            )}
          </div>
          {!ready && (
            <p>No ready provider is available for a transcription test.</p>
          )}
          {transcript !== null && (
            <div className="audio-transcript">
              <span className="settings-meta">Transcript</span>
              <p
                className="settings-code"
                role="region"
                aria-label="Sample transcript"
                tabIndex={0}
              >
                {transcript}
              </p>
            </div>
          )}
        </Card>
      </div>
    </section>
  );
}

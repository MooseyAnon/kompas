import { vi } from 'vitest';

/** Deterministic microphone: a stream with one track and a fake graph. */
export class FakeMedia {
  track = { stop: vi.fn() };
  processor: { onaudioprocess: ((event: unknown) => void) | null } | null =
    null;
  getUserMedia = vi.fn(async () => ({ getTracks: () => [this.track] }));
  contexts = 0;
  closed = 0;

  install() {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: this.getUserMedia },
    });
    const opened = () => (this.contexts += 1);
    const closed = () => (this.closed += 1);
    const attach = (processor: FakeMedia['processor']) =>
      (this.processor = processor);
    vi.stubGlobal(
      'AudioContext',
      class {
        sampleRate = 16000;
        state = 'running';
        destination = {};
        constructor() {
          opened();
        }
        createMediaStreamSource() {
          return { connect() {}, disconnect() {} };
        }
        createScriptProcessor() {
          const processor = {
            onaudioprocess: null,
            connect() {},
            disconnect() {},
          };
          attach(processor);
          return processor;
        }
        close() {
          this.state = 'closed';
          closed();
          return Promise.resolve();
        }
      },
    );
  }

  /** Feed one frame of a constant-amplitude signal. */
  emit(amplitude: number, samples = 4096) {
    const data = new Float32Array(samples).fill(amplitude);
    this.processor?.onaudioprocess?.({
      inputBuffer: { getChannelData: () => data },
    });
  }
}

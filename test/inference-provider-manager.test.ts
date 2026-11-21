import { describe, expect, it } from 'vitest';
import os from 'node:os';
import { ProviderManager } from '../src/main/modules/inference/provider-manager';
import { collectHardwareProfile } from '../src/main/modules/inference/hardware';
import { hardwareProfileSchema } from '../src/shared/contracts';

describe('ProviderManager', () => {
  function register(manager: ProviderManager) {
    manager.register({
      providerId: 'mock',
      kind: 'mock',
      configured: true,
      dev: true,
    });
  }

  it('registers a provider and reports an unknown status until observed', () => {
    const manager = new ProviderManager();
    register(manager);
    expect(manager.has('mock')).toBe(true);
    const status = manager.getStatus('mock');
    expect(status.state).toBe('unknown');
    expect(status.reachable).toBe(false);
    expect(status.capabilities.text).toBe('unknown');
  });

  it('rejects a duplicate provider id (collision)', () => {
    const manager = new ProviderManager();
    register(manager);
    expect(() => register(manager)).toThrow(/Duplicate/);
  });

  it('throws NOT_FOUND for an unknown provider', () => {
    const manager = new ProviderManager();
    expect(() => manager.get('ghost')).toThrow();
  });

  it('records a worker observation into a status', () => {
    const manager = new ProviderManager();
    register(manager);
    const at = new Date().toISOString();
    manager.updateObservation(
      'mock',
      {
        state: 'ready',
        capabilities: {
          text: 'supported',
          streaming: 'supported',
          structuredOutput: 'supported',
          tools: 'unsupported',
        },
        runtimeVersion: 'mock-1',
      },
      at,
    );
    const status = manager.getStatus('mock');
    expect(status.state).toBe('ready');
    expect(status.reachable).toBe(true);
    expect(status.capabilities.tools).toBe('unsupported');
    expect(status.runtimeVersion).toBe('mock-1');
  });

  it('clears to unknown when the worker is unavailable', () => {
    const manager = new ProviderManager();
    register(manager);
    manager.updateObservation('mock', null, new Date().toISOString());
    const status = manager.getStatus('mock');
    expect(status.state).toBe('unknown');
    expect(status.reachable).toBe(false);
  });

  it('exposes worker configs without secrets', () => {
    const manager = new ProviderManager();
    register(manager);
    expect(manager.workerConfigs()).toEqual([
      { providerId: 'mock', kind: 'mock', dev: true },
    ]);
  });
});

describe('hardware profile', () => {
  it('produces a schema-valid snapshot with no machine identifiers', () => {
    const profile = collectHardwareProfile();
    expect(hardwareProfileSchema.safeParse(profile).success).toBe(true);

    expect(profile.cpuLogicalCount).toBeGreaterThan(0);
    expect(profile.totalMemoryBytes).toBeGreaterThan(0);
    // Unknown GPU data stays null; VRAM is never invented.
    expect(profile.gpuName).toBeNull();
    expect(profile.gpuMemoryBytes).toBeNull();

    const serialised = JSON.stringify(profile).toLowerCase();
    expect(serialised).not.toContain(String(os.hostname()).toLowerCase());
    expect(serialised).not.toContain(
      String(os.userInfo().username).toLowerCase(),
    );
  });

  it('is internally consistent across repeated reads', () => {
    const a = collectHardwareProfile();
    const b = collectHardwareProfile();
    expect(b.platform).toBe(a.platform);
    expect(b.architecture).toBe(a.architecture);
    expect(b.cpuLogicalCount).toBe(a.cpuLogicalCount);
  });
});

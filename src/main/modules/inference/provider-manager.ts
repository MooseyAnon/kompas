import {
  type ProviderCapabilities,
  type ProviderKind,
  type ProviderStatus,
} from '../../../shared/contracts';
import type { ProviderConfig } from '../../../shared/contracts/inference-worker';
import { AppError } from '../../ipc/errors';
import type { WorkerProviderObservation } from './worker-supervisor';

export interface ProviderRegistration {
  providerId: string;
  kind: ProviderKind;
  configured: boolean;
  dev: boolean;
  /** Provider-specific loopback endpoint handed to the worker adapter. */
  endpoint?: string;
}

const UNKNOWN_CAPABILITIES: ProviderCapabilities = {
  text: 'unknown',
  streaming: 'unknown',
  structuredOutput: 'unknown',
  tools: 'unknown',
};

/**
 * Main-process registry of inference providers. Owns registration,
 * collision/unknown-provider checks and the last observed health status.
 * Capabilities are observations (unknown until the worker reports them); the
 * manager never asserts capability from a provider or model name alone and
 * performs no outbound network calls or installation.
 */
export class ProviderManager {
  private readonly registrations = new Map<string, ProviderRegistration>();
  private readonly statuses = new Map<string, ProviderStatus>();

  register(registration: ProviderRegistration): void {
    if (this.registrations.has(registration.providerId)) {
      throw new Error(
        `Duplicate inference provider id: ${registration.providerId}`,
      );
    }

    this.registrations.set(registration.providerId, registration);
  }

  has(providerId: string): boolean {
    return this.registrations.has(providerId);
  }

  get(providerId: string): ProviderRegistration {
    const registration = this.registrations.get(providerId);
    if (!registration) {
      throw new AppError('NOT_FOUND', 'That provider is not registered.');
    }

    return registration;
  }

  list(): ProviderRegistration[] {
    return [...this.registrations.values()];
  }

  /** Provider configs to hand the worker at init (secrets excluded). */
  workerConfigs(): ProviderConfig[] {
    return this.list().map((registration) => ({
      providerId: registration.providerId,
      kind: registration.kind,
      dev: registration.dev,
      endpoint: registration.endpoint,
    }));
  }

  /** Record (or clear) the worker's latest health observation for a provider. */
  updateObservation(
    providerId: string,
    observation: WorkerProviderObservation | null,
    at: string,
  ): void {
    const registration = this.registrations.get(providerId);
    if (!registration) {
      return;
    }

    const status: ProviderStatus = observation
      ? {
          providerId,
          kind: registration.kind,
          configured: registration.configured,
          reachable: observation.state === 'ready',
          runtimeVersion: observation.runtimeVersion ?? null,
          lastCheckedAt: at,
          state: observation.state,
          messageCode: observation.messageCode,
          capabilities: observation.capabilities,
          dev: registration.dev,
        }
      : unobservedStatus(registration, at);

    this.statuses.set(providerId, status);
  }

  getStatus(
    providerId: string,
    at: string = new Date().toISOString(),
  ): ProviderStatus {
    const existing = this.statuses.get(providerId);
    if (existing) {
      return existing;
    }

    return unobservedStatus(this.get(providerId), at);
  }

  listStatuses(at: string = new Date().toISOString()): ProviderStatus[] {
    return this.list().map((registration) =>
      this.getStatus(registration.providerId, at),
    );
  }
}

/** Status for a provider with no (usable) worker observation yet. */
function unobservedStatus(
  registration: ProviderRegistration,
  at: string,
): ProviderStatus {
  return {
    providerId: registration.providerId,
    kind: registration.kind,
    configured: registration.configured,
    reachable: false,
    runtimeVersion: null,
    lastCheckedAt: at,
    state: 'unknown',
    capabilities: UNKNOWN_CAPABILITIES,
    dev: registration.dev,
  };
}

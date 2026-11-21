import type { CandidateObservation } from './collection';
import type { DiscoveryRunsRepository } from './runs.repository';
import type { DiscoveryCandidate } from '../../../shared/contracts';
import { jobReference } from '../web/job-reference';

/**
 * The Applications domain owns the lookup; Discovery never reads its tables.
 */
export interface DiscoveryApplicationReader {
  findByJobReference(url: string): { id: string; applied: boolean } | null;
}

export class DiscoveryIdentityService {
  constructor(
    private readonly runs: DiscoveryRunsRepository,
    private readonly applications?: DiscoveryApplicationReader,
  ) {}

  observe(
    runId: string,
    observation: CandidateObservation,
    at: string,
  ): DiscoveryCandidate | null {
    const reference = jobReference(observation.discoveredUrl);
    if (!reference) return null;

    // Stable provider IDs take precedence over transient search
    // position/trackers.
    const key = reference.startsWith(`${observation.provider}:`)
      ? reference.slice(observation.provider.length + 1)
      : observation.key;

    return this.runs.observe(
      runId,
      { ...observation, key },
      at,
      () =>
        this.applications?.findByJobReference(observation.discoveredUrl) ??
        null,
    );
  }
}

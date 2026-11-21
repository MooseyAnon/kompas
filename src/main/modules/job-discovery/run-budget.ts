import type {
  DiscoveryRun,
  DiscoveryRunStats,
} from '../../../shared/contracts';
import { AppError } from '../../ipc/errors';

/**
 * Executor gate for later stages; all limits come from the frozen run snapshot.
 */
export class RunBudget {
  constructor(
    private readonly run: DiscoveryRun,
    private readonly clock: () => number = Date.now,
    private readonly signal?: AbortSignal,
  ) {}

  assertAvailable(): void {
    if (this.run.status !== 'running' || this.signal?.aborted) {
      throw new AppError('CONFLICT', 'Discovery run is no longer active.');
    }

    const elapsedMs = this.clock() - Date.parse(this.run.startedAt);
    if (elapsedMs >= this.run.configSnapshot.run.deadlineMs) {
      throw new AppError('CONFLICT', 'Discovery run deadline reached.');
    }
  }

  canInspect(stats: DiscoveryRunStats): boolean {
    this.assertAvailable();

    return (
      stats.inspectedCandidates <
      this.run.configSnapshot.run.maxInspectedCandidates
    );
  }

  canAdmit(stats: DiscoveryRunStats): boolean {
    this.assertAvailable();

    return stats.newCandidates < this.run.configSnapshot.run.maxNewCandidates;
  }

  canReadCollection(stats: DiscoveryRunStats): boolean {
    this.assertAvailable();

    return (
      stats.collectionPagesRead < this.run.configSnapshot.run.maxCollectionPages
    );
  }

  canSearchCandidate(attemptsForCandidate: number): boolean {
    this.assertAvailable();

    return (
      attemptsForCandidate <
      this.run.configSnapshot.run.maxTargetedSearchesPerCandidate
    );
  }

  canReadTargetedPage(pagesForSearch: number): boolean {
    this.assertAvailable();

    return (
      pagesForSearch < this.run.configSnapshot.run.maxPagesPerTargetedSearch
    );
  }

  canRetry(attemptsForOperation: number): boolean {
    this.assertAvailable();

    return (
      attemptsForOperation < this.run.configSnapshot.run.maxTransientRetries
    );
  }
}

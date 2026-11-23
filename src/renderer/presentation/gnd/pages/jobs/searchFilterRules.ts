// Search filters and the "Finding your roles" screen: pure helpers, no I/O.
import type {
  DiscoveryWorkflowState,
  Experience,
  JobDiscoveryConfigurationV1,
  Target,
} from '../../../../../shared/contracts';
import { summaryChips } from './searchPreferences';

export const LIST_LIMITS = { roles: 5, companies: 10, keywords: 10 } as const;
export type ListKey = keyof typeof LIST_LIMITS;

/** Add a typed entry unless it is blank, a duplicate or over the limit. */
export function addEntry(
  list: readonly string[],
  typed: string,
  max: number,
): { list: string[]; problem: 'blank' | 'duplicate' | 'full' | null } {
  const value = typed.replace(/\s+/gu, ' ').trim().slice(0, 200);
  if (!value) return { list: [...list], problem: 'blank' };
  if (list.some((item) => item.toLowerCase() === value.toLowerCase()))
    return { list: [...list], problem: 'duplicate' };
  if (list.length >= max) return { list: [...list], problem: 'full' };
  return { list: [...list, value], problem: null };
}

/** How many filters are set, for the badge on the Filters button. */
export function filterCount(
  config: JobDiscoveryConfigurationV1 | null,
): number {
  if (!config) return 0;
  return (
    summaryChips(config.intent).length + (config.intent.targetYear ? 1 : 0)
  );
}

/** Roles to suggest on a first visit: target roles, then recent job titles. */
export function suggestedRoles(
  targets: Pick<Target, 'roleTitle' | 'active'>[],
  experiences: Pick<Experience, 'roleTitle' | 'category'>[],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const title of [
    ...targets.filter((t) => t.active).map((t) => t.roleTitle),
    ...experiences
      .filter((e) => e.category !== 'education')
      .map((e) => e.roleTitle ?? ''),
  ]) {
    const role = title.trim();
    if (!role || seen.has(role.toLowerCase())) continue;
    seen.add(role.toLowerCase());
    out.push(role);
    if (out.length === 3) break;
  }
  return out;
}

export type ProgressStep = {
  label: string;
  state: 'done' | 'now';
  summary: string;
};

/**
 * Turn the run's workflow state into the three steps on screen, the line of
 * detail under the current step, and the "roles found" counter.
 */
export function progressFor(state: DiscoveryWorkflowState | null): {
  steps: ProgressStep[];
  detail: string;
  found: number;
  percent: number;
  finished: boolean;
} {
  if (!state)
    return {
      steps: [
        { label: 'Searching LinkedIn and Indeed', state: 'now', summary: '' },
      ],
      detail: 'Getting started',
      found: 0,
      percent: 4,
      finished: false,
    };
  const { discovery, counts, candidates, activeSteps } = state;
  const settled = discovery.settled ?? 0;
  const searching = settled < discovery.planned && state.status === 'running';
  const found = counts.admitted;
  const reading = counts.jdReady + counts.failed < found;
  const finished = state.status !== 'running' && !state.workActive;
  const titleOf = (sourceId: string) =>
    candidates.find((c) => c.sourceId === sourceId)?.title ?? '';
  const active = activeSteps[0];
  const steps: ProgressStep[] = [
    {
      label: 'Searching LinkedIn and Indeed',
      state: searching ? 'now' : 'done',
      summary: `${discovery.planned} searches · ${found} listings`,
    },
  ];
  if (!searching)
    steps.push({
      label: 'Reading each listing',
      state: reading && !finished ? 'now' : 'done',
      summary: `${counts.jdReady} listings read`,
    });
  if (!searching && (!reading || finished))
    steps.push({
      label: 'Checking them against your skills',
      state: finished ? 'done' : 'now',
      summary: 'Sorted by match',
    });
  const detail = searching
    ? `Search ${Math.min(settled + 1, discovery.planned)} of ${discovery.planned}`
    : active
      ? `${active.step === 'matching' ? 'Checking' : 'Reading'} ${titleOf(active.sourceId)}`.trim()
      : reading
        ? `${counts.jdReady} of ${found} read`
        : 'Sorting your best matches first';
  const searchShare = discovery.planned ? settled / discovery.planned : 0;
  const readShare = found ? (counts.jdReady + counts.failed) / found : 1;
  const matchShare = found ? counts.matched / found : 1;
  const percent = finished
    ? 100
    : Math.round(
        4 +
          searchShare * 40 +
          (searching ? 0 : readShare * 36 + matchShare * 18),
      );
  return {
    steps,
    detail,
    found,
    percent: finished ? 100 : Math.min(percent, 98),
    finished,
  };
}

/** A plain-English line for why a search stopped short, if it did. */
export function stoppedShort(
  state: Pick<DiscoveryWorkflowState, 'status' | 'diagnostics'> | null,
): string | null {
  if (!state) return null;
  const codes = new Set(state.diagnostics.map((d) => d.code));
  if (
    codes.has('WEB_RATE_LIMITED') ||
    codes.has('WEB_CHALLENGE') ||
    codes.has('PAGE_BLOCKED')
  )
    return 'A job board stopped returning results, so a few roles may be missing.';
  if (codes.has('WEB_UNAVAILABLE'))
    return 'We couldn’t reach the job boards. Check your internet connection.';
  if (codes.has('DEADLINE_REACHED'))
    return 'The search ran out of time, so a few roles may be missing.';
  if (codes.has('INTERRUPTED_ON_RESTART'))
    return 'The search stopped when Kompas was closed.';
  if (state.status === 'cancelled') return 'You stopped the search early.';
  if (
    state.status === 'failed' ||
    codes.has('EXECUTION_FAILED') ||
    codes.has('WEB_FAILED')
  )
    return 'Something went wrong while searching.';
  return null;
}

import {
  createSavedSearch,
  executeDiscoveryWorkflow,
  getProfile,
  listSavedSearches,
  startDiscoveryRun,
  updateSavedSearch,
} from '../../../../api';
import {
  addRole,
  MAX_ROLES,
  searchConfigFor,
} from '../onboarding/onboardingPlan';

export type RoleSearchResult =
  | { status: 'started'; runId: string }
  | { status: 'full' }
  | { status: 'blank' };

/**
 * "Search more roles that we missed": add the role to the person's active
 * saved search (or create one), then start a run straight away. A saved search
 * holds at most five roles; when full, the person is told rather than a role
 * being silently dropped.
 */
export async function searchForRole(typed: string): Promise<RoleSearchResult> {
  const role = typed.replace(/\s+/gu, ' ').trim();
  if (!role) return { status: 'blank' };

  const { items } = await listSavedSearches({ limit: 50 });
  const search = items.find((item) => item.config.active) ?? items[0];
  let searchId: string;

  if (!search) {
    const profile = await getProfile();
    const created = await createSavedSearch(
      searchConfigFor([role], profile.location ?? '', 'any'),
    );
    searchId = created.id;
  } else {
    const roles = search.config.intent.targetRoles;
    const next = addRole(roles, role);
    const alreadyThere = roles.some(
      (existing) => existing.toLowerCase() === role.toLowerCase(),
    );
    if (next === roles && !alreadyThere && roles.length >= MAX_ROLES)
      return { status: 'full' };
    if (next !== roles || !search.config.active)
      await updateSavedSearch(search.id, {
        ...search.config,
        active: true,
        intent: { ...search.config.intent, targetRoles: next },
      });
    searchId = search.id;
  }

  return { status: 'started', runId: await startSearch(searchId) };
}

/**
 * Start a run for a saved search and hand its work to the background
 * workflow, which the "Finding your roles" screen then follows.
 */
export async function startSearch(searchId: string): Promise<string> {
  const run = await startDiscoveryRun(searchId);
  await executeDiscoveryWorkflow(run.id);
  return run.id;
}

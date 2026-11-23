import { useEffect, useMemo, useState } from 'react';
import { listTargets } from '../../../../api';
import { useJobs } from '../jobs/useJobs';
import { interviewStages, repeatedSkills, type Focus } from './interviewView';

/**
 * The role you're applying for, the interview stages it usually has, and the
 * skills its job descriptions keep asking for.
 */
export function useRoleFocus() {
  const [role, setRole] = useState<string | null>(null);
  const [loadingRole, setLoadingRole] = useState(true);
  const jobs = useJobs('all', 30);

  useEffect(() => {
    let live = true;
    void listTargets()
      .then((targets) => {
        const target = targets.find((t) => t.active) ?? targets[0];
        if (live) setRole(target?.roleTitle ?? null);
      })
      .catch(() => undefined)
      .finally(() => live && setLoadingRole(false));
    return () => {
      live = false;
    };
  }, []);

  const stages: Focus[] = useMemo(() => interviewStages(role), [role]);
  const skills: Focus[] = useMemo(() => repeatedSkills(jobs.jobs), [jobs.jobs]);
  return { role, stages, skills, loading: loadingRole || jobs.loading };
}

export type RoleFocus = ReturnType<typeof useRoleFocus>;

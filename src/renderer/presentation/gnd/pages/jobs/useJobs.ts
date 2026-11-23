import { useCallback, useEffect, useState } from 'react';
import { getReviewOpportunity, listReviewOpportunities } from '../../../../api';
import { byMatch, jobView, type JobView } from './jobView';

/**
 * Discovered jobs with their details, best match first. Details are read per
 * job (local and quick) because cards show salary and work setup, which only
 * exist once a listing has been read.
 */
export function useJobs(decision: 'new' | 'saved' | 'all', limit = 50) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const page = await listReviewOpportunities({ decision, limit });
      const details = await Promise.all(
        page.items.map((item) =>
          getReviewOpportunity(item.opportunityId).catch(() => null),
        ),
      );
      setJobs(
        page.items
          .filter((item) => item.decision !== 'dismissed')
          .map((item) =>
            jobView(
              item,
              details.find((d) => d?.opportunityId === item.opportunityId),
            ),
          )
          .sort(byMatch),
      );
    } catch {
      setError('Couldn’t load roles. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [decision, limit]);

  useEffect(() => {
    void load();
  }, [load]);

  return { jobs, loading, error, reload: load };
}

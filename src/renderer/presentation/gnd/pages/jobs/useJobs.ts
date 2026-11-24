import { useCallback, useEffect, useState } from 'react';
import {
  focusDiscovery,
  getReviewOpportunity,
  listReviewOpportunities,
} from '../../../../api';
import { byMatch, jobView, type JobView } from './jobView';

/**
 * Discovered jobs with their details, best match first. Details are read per
 * job (local and quick) because cards show salary and work setup, which only
 * exist once a listing has been read.
 */
/** About how many cards a screen shows at once. */
const VISIBLE = 12;
const REFRESH_MS = 20_000;

export function useJobs(decision: 'new' | 'saved' | 'all', limit = 50) {
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState<string[]>([]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      setError('');
      try {
        const page = await listReviewOpportunities({ decision, limit });
        const details = await Promise.all(
          page.items.map((item) =>
            getReviewOpportunity(item.opportunityId).catch(() => null),
          ),
        );
        const shown = page.items.filter(
          (item) => item.decision !== 'dismissed',
        );
        setUnread(
          shown
            .filter((item) =>
              ['missing', 'running'].includes(item.extractionStatus),
            )
            .map((item) => item.opportunityId),
        );
        setJobs(
          shown
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
    },
    [decision, limit],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // Roles on screen whose listing isn't read yet go to the front of the queue,
  // and the list refreshes quietly until they're read.
  const unreadKey = unread.slice(0, VISIBLE).join(',');
  useEffect(() => {
    if (!unreadKey) return;
    void focusDiscovery(unreadKey.split(',')).catch(() => undefined);
    const timer = window.setInterval(() => void load(true), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [unreadKey, load]);

  return { jobs, loading, error, reload: () => load() };
}

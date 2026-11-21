import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  InsightsSession,
  InterviewWorkflowState,
} from '../../../../shared/contracts';
import { getInterviewWorkflowState, listInsightsSessions } from '../../../api';

type Page = {
  items: InsightsSession[];
  nextCursor: string | null;
  snapshots: Record<string, InterviewWorkflowState>;
};

export function useHistory() {
  const [page, setPage] = useState<Page>({
    items: [],
    nextCursor: null,
    snapshots: {},
  });
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [moreError, setMoreError] = useState(false);
  const request = useRef(0);
  const busy = useRef(false);

  const load = useCallback(async (cursor?: string) => {
    if (busy.current) return;
    busy.current = true;
    const current = ++request.current;
    if (!cursor) setStatus('loading');
    setMoreError(false);
    try {
      const next = await listInsightsSessions({ cursor, limit: 20 });
      // A snapshot is a read: no starting, resuming or polling from History.
      const snapshots = await Promise.all(
        next.items.map(async (item) => {
          if (item.status === 'draft') return null;
          try {
            return [item.id, await getInterviewWorkflowState(item.id)] as const;
          } catch {
            return null; // The row remains navigable if its snapshot is unavailable.
          }
        }),
      );
      if (current !== request.current) return;
      setPage((previous) => ({
        items: cursor ? [...previous.items, ...next.items] : next.items,
        nextCursor: next.nextCursor,
        snapshots: {
          ...(cursor ? previous.snapshots : {}),
          ...Object.fromEntries(snapshots.filter((entry) => entry !== null)),
        },
      }));
      setStatus('ready');
    } catch {
      if (current === request.current) {
        if (cursor) setMoreError(true);
        else setStatus('error');
      }
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      request.current++;
    };
  }, [load]);

  return {
    page,
    status,
    moreError,
    refresh: () => load(),
    loadMore: () => page.nextCursor && load(page.nextCursor),
  };
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DiscoveryRun,
  DiscoveryRunSummary,
  SavedSearch,
} from '../../../shared/contracts/job-discovery';
import {
  ApiError,
  createSavedSearch,
  executeDiscoveryWorkflow,
  getDiscoveryRun,
  listDiscoveryRuns,
  listSavedSearches,
  previewDiscoveryRun,
  setSavedSearchActive,
  startDiscoveryRun,
  updateSavedSearch,
} from '../../api';
import { searchForm, validateSearch, type SearchForm } from './searchForm';

type Page<T> = {
  items: T[];
  cursor: string | null;
  loading: boolean;
  error: string | null;
};
const emptyPage = <T>(): Page<T> => ({
  items: [],
  cursor: null,
  loading: true,
  error: null,
});
const message = (error: unknown) =>
  error instanceof ApiError
    ? error.message
    : 'Something went wrong. Please try again.';

export function useJobsController() {
  const [searches, setSearches] = useState<Page<SavedSearch>>(emptyPage);
  const [runs, setRuns] = useState<Page<DiscoveryRunSummary>>(emptyPage);
  const [searchMore, setSearchMore] = useState(false);
  const [runMore, setRunMore] = useState(false);
  const [editor, setEditor] = useState<{
    id: string | null;
    form: SearchForm;
    saved: SavedSearch | null;
  } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    id: string;
    queries: string[];
  } | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [runDetail, setRunDetail] = useState<DiscoveryRun | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const searchRequest = useRef(0);
  const runRequest = useRef(0);
  const detailRequest = useRef(0);
  const currentRun = useRef<string | null>(null);

  const loadSearches = useCallback(async (cursor?: string) => {
    const request = ++searchRequest.current;
    if (cursor) setSearchMore(true);
    else setSearches((current) => ({ ...current, loading: true, error: null }));
    try {
      const page = await listSavedSearches({
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (!mounted.current || request !== searchRequest.current) return;
      setSearches((current) => ({
        items: cursor ? [...current.items, ...page.items] : page.items,
        cursor: page.nextCursor,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (mounted.current && request === searchRequest.current)
        setSearches((current) => ({
          ...current,
          loading: false,
          error: message(error),
        }));
    } finally {
      if (mounted.current && request === searchRequest.current)
        setSearchMore(false);
    }
  }, []);

  const loadRuns = useCallback(async (cursor?: string) => {
    const request = ++runRequest.current;
    if (cursor) setRunMore(true);
    else setRuns((current) => ({ ...current, loading: true, error: null }));
    try {
      const page = await listDiscoveryRuns({
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      if (!mounted.current || request !== runRequest.current) return;
      setRuns((current) => ({
        items: cursor ? [...current.items, ...page.items] : page.items,
        cursor: page.nextCursor,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (mounted.current && request === runRequest.current)
        setRuns((current) => ({
          ...current,
          loading: false,
          error: message(error),
        }));
    } finally {
      if (mounted.current && request === runRequest.current) setRunMore(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadSearches();
    void loadRuns();
    return () => {
      mounted.current = false;
      searchRequest.current++;
      runRequest.current++;
      detailRequest.current++;
    };
  }, [loadSearches, loadRuns]);

  const activeRun = runs.items.find((run) => run.status === 'running') ?? null;
  const latest = new Map<string, DiscoveryRunSummary>();
  for (const run of runs.items)
    if (run.savedSearchId && !latest.has(run.savedSearchId))
      latest.set(run.savedSearchId, run);

  function openEditor(item?: SavedSearch) {
    if (inFlight.current) return;
    setEditor({
      id: item?.id ?? null,
      saved: item ?? null,
      form: searchForm(item?.config),
    });
    setErrors({});
    setNotice(null);
    setPreview(null);
  }
  function changeForm(form: SearchForm) {
    setEditor((current) => (current ? { ...current, form } : current));
    setErrors({});
    setNotice(null);
    setPreview(null);
  }
  function closeEditor() {
    if (!inFlight.current) {
      setEditor(null);
      setNotice(null);
      setPreview(null);
    }
  }

  async function exclusive(action: string, task: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setNotice(null);
    try {
      await task();
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  async function persist(): Promise<SavedSearch | null> {
    if (!editor) return null;
    const result = validateSearch(editor.form);
    if (!result.config) {
      setErrors(result.errors);
      return null;
    }
    if (
      editor.saved &&
      JSON.stringify(editor.saved.config) === JSON.stringify(result.config)
    )
      return editor.saved;
    const item = editor.id
      ? await updateSavedSearch(editor.id, result.config)
      : await createSavedSearch(result.config);
    if (mounted.current) {
      setEditor({ id: item.id, saved: item, form: searchForm(item.config) });
      void loadSearches();
    }
    return item;
  }

  function save() {
    void exclusive('save', async () => {
      try {
        const item = await persist();
        if (mounted.current && item) setNotice('Search saved.');
      } catch (error) {
        if (mounted.current) setNotice(message(error));
      }
    });
  }

  function toggle(item: SavedSearch) {
    void exclusive('toggle', async () => {
      try {
        await setSavedSearchActive(item.id, !item.config.active);
        if (mounted.current) {
          setPreview(null);
          await loadSearches();
        }
      } catch (error) {
        if (mounted.current) setNotice(message(error));
      }
    });
  }

  function showPreview(item: SavedSearch) {
    if (!item.config.active) {
      setNotice('Activate this saved search before previewing queries.');
      return;
    }
    if (editor && editor.id === item.id) {
      const result = validateSearch(editor.form);
      if (
        !result.config ||
        JSON.stringify(result.config) !== JSON.stringify(item.config)
      ) {
        setNotice('Save your changes before previewing the saved query plan.');
        return;
      }
    }
    void exclusive('preview', async () => {
      try {
        const queries = await previewDiscoveryRun(item.id);
        if (mounted.current) setPreview({ id: item.id, queries });
      } catch (error) {
        if (mounted.current) setNotice(message(error));
      }
    });
  }

  const refreshRun = useCallback(
    async (id: string) => {
      const request = ++detailRequest.current;
      try {
        const detail = await getDiscoveryRun(id);
        if (
          !mounted.current ||
          request !== detailRequest.current ||
          currentRun.current !== id
        )
          return;
        setRunDetail(detail);
        void loadRuns();
      } catch (error) {
        if (
          mounted.current &&
          request === detailRequest.current &&
          currentRun.current === id
        )
          setRunError(message(error));
      }
    },
    [loadRuns],
  );

  function openRun(id: string) {
    currentRun.current = id;
    setRunId(id);
    setRunDetail(null);
    setRunError(null);
    void refreshRun(id);
  }

  function start(item?: SavedSearch) {
    void exclusive('start', async () => {
      if (activeRun) {
        setNotice(
          'A discovery is already running. View the active run instead.',
        );
        return;
      }
      let search = item;
      try {
        if (!search) search = (await persist()) ?? undefined;
        if (!search) return;
        if (!search.config.active) {
          setNotice('Activate this saved search before starting discovery.');
          return;
        }
        // A start conflict is not retried: the backend enforces one running run.
        const run = await startDiscoveryRun(search.id);
        if (!mounted.current) return;
        currentRun.current = run.id;
        setRunId(run.id);
        setRunDetail(run);
        setRunError(null);
        setEditor(null);
        void loadRuns();
        try {
          await executeDiscoveryWorkflow(run.id);
          if (mounted.current && currentRun.current === run.id)
            setRunError(null);
        } catch (error) {
          if (mounted.current && currentRun.current === run.id)
            setRunError(
              `Run ${run.id} was created, but execution was not confirmed: ${message(error)} Check its status before taking another action.`,
            );
        }
        if (mounted.current && currentRun.current === run.id)
          void refreshRun(run.id);
      } catch (error) {
        if (mounted.current) {
          setNotice(message(error));
          if (error instanceof ApiError && error.code === 'CONFLICT')
            void loadRuns();
        }
      }
    });
  }

  return {
    searches,
    runs,
    latest,
    activeRun,
    editor,
    errors,
    notice,
    busy,
    preview,
    runId,
    runDetail,
    runError,
    searchMore,
    runMore,
    loadSearches,
    loadRuns,
    openEditor,
    changeForm,
    closeEditor,
    save,
    toggle,
    showPreview,
    start,
    openRun,
    refreshRun,
  };
}

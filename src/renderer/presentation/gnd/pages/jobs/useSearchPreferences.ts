import { useEffect, useRef, useState } from 'react';
import {
  createSavedSearch,
  getProfile,
  listExperiences,
  listSavedSearches,
  listTargets,
  updateSavedSearch,
} from '../../../../api';
import { failureNotice } from '../../../../app/Notifications';
import { useToast } from '../../components/Overlay';
import type { JobDiscoveryConfigurationV1 } from '../../../../../shared/contracts';
import { searchConfigFor } from '../onboarding/onboardingPlan';
import { defaultPlaces } from './places';
import { startSearch } from './roleSearch';
import { suggestedRoles } from './searchFilterRules';
import { preferencesOf, withPreferences } from './searchPreferences';

type Config = JobDiscoveryConfigurationV1;
export type Section =
  | 'roles'
  | 'location'
  | 'setup'
  | 'level'
  | 'contract'
  | 'salary'
  | 'field'
  | 'companies'
  | 'keywords'
  | 'boards';

const NEED_ROLE =
  'Add a role first. Your other choices save as soon as you do.';

/**
 * The search's preferences, always editable and saved as you go. Errors are
 * kept per section so each shows beside the field that caused it.
 * Suggestions (roles from the CV, London and your city) show in yellow and
 * are saved with your first change.
 */
export function useSearchPreferences() {
  const [config, setConfig] = useState<Config | null>(null);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [suggested, setSuggested] = useState<string[]>([]);
  const [errors, setErrors] = useState<Partial<Record<Section, string>>>({});
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const saving = useRef(Promise.resolve());
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const [{ items }, profile] = await Promise.all([
          listSavedSearches({ limit: 50 }),
          getProfile(),
        ]);
        const search = items.find((item) => item.config.active) ?? items[0];
        const places = defaultPlaces(profile.location);
        if (!live) return;
        if (search) {
          idRef.current = search.id;
          setSearchId(search.id);
          if (preferencesOf(search.config.intent).locations.length) {
            setConfig(search.config);
          } else {
            setSuggested(places);
            setConfig({
              ...search.config,
              intent: withPreferences(search.config.intent, {
                locations: places,
              }),
            });
          }
          return;
        }
        const [targets, experiences] = await Promise.all([
          listTargets(),
          listExperiences(),
        ]);
        const roles = suggestedRoles(targets, experiences);
        if (!live) return;
        const base = searchConfigFor(roles, '', 'any');
        setSuggested([...roles, ...places]);
        setConfig({
          ...base,
          intent: withPreferences(base.intent, { locations: places }),
        });
      } catch (e) {
        if (live)
          setLoadError(
            failureNotice(e, 'Couldn’t load your preferences.').message,
          );
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const clear = (section: Section) =>
    setErrors((now) => {
      const { [section]: _gone, roles: _roles, ...rest } = now;
      return rest;
    });
  const fail = (section: Section, message: string) =>
    setErrors((now) => ({ ...now, [section]: message }));

  /** Keep a change and save it, one save at a time, then confirm. */
  function save(next: Config, section: Section) {
    setConfig(next);
    setSuggested([]);
    if (!next.intent.targetRoles.length) {
      setErrors((now) => ({ ...now, roles: NEED_ROLE }));
      return Promise.resolve();
    }
    clear(section);
    const config = {
      ...next,
      name: next.name.trim() || `${next.intent.targetRoles[0]} roles`,
    };
    saving.current = saving.current.then(async () => {
      try {
        if (idRef.current) await updateSavedSearch(idRef.current, config);
        else {
          const created = await createSavedSearch(config);
          idRef.current = created.id;
          setSearchId(created.id);
        }
        toast.show('Changes saved');
      } catch (e) {
        const notice = failureNotice(e, '');
        fail(
          section,
          notice.code === 'INVALID_INPUT' || !notice.message
            ? 'This couldn’t be saved. Check it and try again.'
            : notice.message,
        );
      }
    });
    return saving.current;
  }

  const setIntent = (patch: Partial<Config['intent']>, section: Section) =>
    config &&
    save({ ...config, intent: { ...config.intent, ...patch } }, section);

  async function searchNow(onStarted: (runId: string) => void) {
    if (!config || busy) return;
    if (!config.intent.targetRoles.length) {
      fail('roles', 'Add at least one role to search for.');
      return;
    }
    setBusy(true);
    try {
      await saving.current;
      let id = idRef.current;
      const ready = {
        ...config,
        active: true,
        name: config.name.trim() || `${config.intent.targetRoles[0]} roles`,
      };
      if (!id) {
        id = (await createSavedSearch(ready)).id;
        idRef.current = id;
        setSearchId(id);
      } else if (!config.active || suggested.length) {
        await updateSavedSearch(id, ready);
      }
      onStarted(await startSearch(id));
    } catch (e) {
      fail('roles', failureNotice(e, 'Couldn’t start the search.').message);
      setBusy(false);
    }
  }

  return {
    config,
    searchId,
    suggested,
    errors,
    loadError,
    busy,
    toast,
    save,
    setIntent,
    fail,
    clear,
    searchNow,
  };
}

export type SearchPreferences = ReturnType<typeof useSearchPreferences>;

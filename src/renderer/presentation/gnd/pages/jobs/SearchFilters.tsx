import React from 'react';
import { ArrowLeft, Search, Sparkles } from 'lucide-react';
import { Button } from '../../../components/Button';
import { Toast } from '../../components/Overlay';
import { PreferencesPanel } from './PreferencesPanel';
import { useSearchPreferences } from './useSearchPreferences';
import './SearchFilters.css';

/**
 * Search filters: "Your preferences" at the top, each preference editable
 * underneath, saved as you go. A first visit starts from roles in the CV,
 * London and the city you're in; nothing is saved until the first change.
 */
export function SearchFilters({
  onBack,
  onStarted,
}: {
  onBack: () => void;
  onStarted: (runId: string) => void;
}) {
  const prefs = useSearchPreferences();
  const { config, searchId, suggested, loadError, busy } = prefs;

  if (!config)
    return (
      <section className="gnd-filters">
        <button type="button" className="gnd-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> All roles
        </button>
        <p className="gnd-state" role={loadError ? 'alert' : 'status'}>
          {loadError || 'Loading…'}
        </p>
      </section>
    );

  const firstVisit = !searchId && suggested.length > 0;

  return (
    <section className="gnd-filters" aria-labelledby="gnd-filters-title">
      <button type="button" className="gnd-back" onClick={onBack}>
        <ArrowLeft aria-hidden="true" /> All roles
      </button>
      <header className="gnd-filters-head">
        <div>
          <h1 id="gnd-filters-title" className="gnd-page-title">
            Search filters
          </h1>
          <p className="gnd-muted">
            What Kompas looks for on LinkedIn and Indeed. Change anything at any
            time, it saves as you go.
          </p>
        </div>
        <Button disabled={busy} onClick={() => void prefs.searchNow(onStarted)}>
          <Search aria-hidden="true" />
          {firstVisit ? 'Search with these filters' : 'Search now'}
        </Button>
      </header>
      {suggested.length > 0 && (
        <p className="gnd-filters-intro">
          <Sparkles aria-hidden="true" />
          <span>
            <strong>
              {firstVisit
                ? 'We’ve filled these in from your CV.'
                : 'We’ve suggested some locations.'}
            </strong>{' '}
            Suggestions are in yellow. Change anything, then search.
          </span>
        </p>
      )}
      <div className="gnd-filters-body">
        <PreferencesPanel prefs={prefs} variant="page" />
      </div>
      <Toast message={prefs.toast.message} />
    </section>
  );
}

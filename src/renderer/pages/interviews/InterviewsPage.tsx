import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ArrowLeft, History, NotebookPen, Radar } from 'lucide-react';
import type { InterviewWorkflowState } from '../../../shared/contracts';
import type { Destination } from '../../app/destinations';
import { Button } from '../../presentation/components/Button';
import { Card } from '../../presentation/components/Card';
import {
  PillTabs,
  pillTabId,
  pillTabPanelId,
  type PillTab,
} from '../../presentation/components/PillTabs';
import { CompetenciesTab } from './competencies/CompetenciesTab';
import { HistoryTab } from './history/HistoryTab';
import {
  useInterviewsNavigation,
  type InterviewsLocation,
  type InterviewsTab,
} from './navigation';
import { PrepareTab } from './prepare/PrepareTab';
import { SessionOutlet } from './session/SessionOutlet';
import './InterviewsPage.css';

const tabs: readonly PillTab<InterviewsTab>[] = [
  { id: 'prepare', label: 'Prepare', icon: NotebookPen },
  { id: 'history', label: 'History', icon: History },
  { id: 'competencies', label: 'Competencies', icon: Radar },
];
const ID_PREFIX = 'interviews';

function tabLabel(tab: InterviewsTab) {
  return tabs.find((item) => item.id === tab)!.label;
}

export function InterviewsPage({
  initialLocation,
  onNavigate,
}: {
  initialLocation?: InterviewsLocation;
  onNavigate?: (next: Destination) => void;
}) {
  const { location, selectTab, openSession, leaveSession } =
    useInterviewsNavigation(initialLocation);
  const outlet = useRef<HTMLDivElement>(null);
  const previousView = useRef(location.view);
  // The snapshot read right after Start/Resume, so the outlet needn't re-read.
  const [primedState, setPrimedState] = useState<InterviewWorkflowState>();

  const enterSession = useCallback(
    (sessionId: string, state?: InterviewWorkflowState) => {
      setPrimedState(state);
      openSession(sessionId);
    },
    [openSession],
  );
  // Settings opens on Local AI.
  const openLocalAi = useCallback(() => onNavigate?.('settings'), [onNavigate]);

  // Every destination starts at its beginning; the header and scene stay put.
  useLayoutEffect(() => {
    if (outlet.current) outlet.current.scrollTop = 0;
  }, [location]);

  // Entering or leaving a session swaps the tab row, so move focus deliberately.
  useEffect(() => {
    if (previousView.current === location.view) return;
    previousView.current = location.view;

    if (location.view === 'session') outlet.current?.focus();
    else document.getElementById(pillTabId(ID_PREFIX, location.tab))?.focus();
  }, [location]);

  const outletSemantics =
    location.view === 'tab'
      ? {
          role: 'tabpanel',
          id: pillTabPanelId(ID_PREFIX),
          'aria-labelledby': pillTabId(ID_PREFIX, location.tab),
        }
      : { role: 'region', 'aria-label': 'Interview session' };

  return (
    <section
      className="interviews-page"
      data-testid="interviews-page"
      aria-labelledby="interviews-title"
    >
      <header className="interviews-intro">
        <span className="interviews-eyebrow">PRACTICE</span>
        <h1 id="interviews-title">Interviews</h1>
        <p>
          Build confidence, sharpen your answers and feel ready for the real
          thing.
        </p>
      </header>

      {location.view === 'tab' ? (
        <PillTabs
          tabs={tabs}
          selected={location.tab}
          onSelect={selectTab}
          label="Interview sections"
          idPrefix={ID_PREFIX}
        />
      ) : (
        <div className="interviews-session-bar">
          <Button
            variant="secondary"
            leadingIcon={<ArrowLeft size={18} aria-hidden="true" />}
            data-testid="interviews-session-back"
            onClick={leaveSession}
          >
            Back to {tabLabel(location.returnTo)}
          </Button>
        </div>
      )}

      <Card className="interviews-main-card" padding="regular">
        <div
          ref={outlet}
          {...outletSemantics}
          tabIndex={0}
          className="interviews-outlet"
          data-testid={`interviews-view-${location.view === 'tab' ? location.tab : 'session'}`}
        >
          <div
            key={location.view === 'tab' ? location.tab : location.sessionId}
            className="interviews-arrival"
          >
            {location.view === 'session' ? (
              <SessionOutlet
                sessionId={location.sessionId}
                initialState={primedState}
                onOpenLocalAi={openLocalAi}
              />
            ) : location.tab === 'prepare' ? (
              <PrepareTab
                onOpenSession={enterSession}
                onOpenLocalAi={openLocalAi}
              />
            ) : location.tab === 'history' ? (
              <HistoryTab onOpenSession={enterSession} />
            ) : (
              <CompetenciesTab onOpenSession={enterSession} />
            )}
          </div>
        </div>
      </Card>
    </section>
  );
}

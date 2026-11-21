import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Archive,
  BriefcaseBusiness,
  CalendarDays,
  CircleCheck,
  Hourglass,
  Inbox,
  LayoutGrid,
  List,
  Plus,
  Search,
  Send,
  Star,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import type { Application } from '../../../../shared/contracts/applications';
import { ApiError, listApplications } from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { EmptyState } from '../../../presentation/components/EmptyState';
import { ApplicationCreate } from './ApplicationCreate';
import { ApplicationDetailView } from './ApplicationDetailView';
import { lanes, stageLane, type Lane } from './stages';
import './ApplicationsBoard.css';

const pageSize = 20;

const laneIcons: Record<Lane, LucideIcon> = {
  Pending: Hourglass,
  Applied: Send,
  Screening: UsersRound,
  Interviewing: CalendarDays,
  Offer: Star,
  Closed: CircleCheck,
};

export function ApplicationsBoard({
  outlet,
  openApplicationId,
  onApplicationClosed,
}: {
  outlet: React.RefObject<HTMLDivElement | null>;
  openApplicationId?: string | null;
  onApplicationClosed?: () => void;
}) {
  const [items, setItems] = useState<Application[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [archived, setArchived] = useState(false);
  const [view, setView] = useState<'board' | 'list'>('board');
  const [selected, setSelected] = useState<Application | null>(null);
  const [creating, setCreating] = useState(false);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const request = useRef(0);
  const busy = useRef(false);
  const add = useRef<HTMLButtonElement>(null);
  const opened = useRef<HTMLButtonElement | null>(null);
  const boardScroll = useRef(0);

  const load = useCallback(
    async (isArchived: boolean, text: string, next?: string) => {
      if (busy.current) return;
      busy.current = true;
      const id = ++request.current;
      if (next) setMore(true);
      else {
        setLoading(true);
        setError(null);
      }
      try {
        const page = await listApplications({
          archived: isArchived,
          search: text,
          limit: pageSize,
          ...(next ? { cursor: next } : {}),
        });
        if (id !== request.current) return;
        setItems((current) => {
          const seen = new Set<string>();
          return [...(next ? current : []), ...page.items].filter((item) => {
            if (seen.has(item.id)) return false;
            seen.add(item.id);
            return true;
          });
        });
        setCursor(page.nextCursor);
        setFailedCursor(null);
        setError(null);
      } catch (failure) {
        if (id === request.current) {
          setFailedCursor(next ?? null);
          setError(
            failure instanceof ApiError
              ? failure.message
              : 'Could not load applications. Retry.',
          );
        }
      } finally {
        busy.current = false;
        if (id === request.current) {
          setLoading(false);
          setMore(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    void load(archived, query);
    return () => {
      request.current++;
      busy.current = false;
    };
  }, [archived, query, load]);

  function filter(nextArchived: boolean, nextQuery: string) {
    if (nextArchived === archived && nextQuery === query) {
      void load(nextArchived, nextQuery);
      return;
    }
    request.current++;
    busy.current = false;
    setItems([]);
    setCursor(null);
    setError(null);
    setArchived(nextArchived);
    setQuery(nextQuery);
    if (outlet.current) outlet.current.scrollTop = 0;
  }

  useEffect(() => {
    if (!selected && !creating && opened.current) {
      if (outlet.current) outlet.current.scrollTop = boardScroll.current;
      opened.current.focus();
    }
  }, [selected, creating, outlet]);

  function open(item: Application, button: HTMLButtonElement) {
    opened.current = button;
    boardScroll.current = outlet.current?.scrollTop ?? 0;
    setSelected(item);
    if (outlet.current) outlet.current.scrollTop = 0;
  }

  if (creating)
    return (
      <ApplicationCreate
        onCancel={() => {
          setCreating(false);
          requestAnimationFrame(() => add.current?.focus());
        }}
        onCreated={(item) => {
          setCreating(false);
          setSelected(item);
          filter(false, '');
          setSearch('');
        }}
      />
    );

  if (selected)
    return (
      <ApplicationDetailView
        id={selected.id}
        onBack={() => {
          setSelected(null);
          void load(archived, query);
        }}
      />
    );

  if (openApplicationId)
    return (
      <ApplicationDetailView
        id={openApplicationId}
        onBack={() => {
          onApplicationClosed?.();
          void load(archived, query);
        }}
      />
    );

  return (
    <div className="ats-board" data-testid="applications-board">
      <div className="jobs-heading ats-header">
        <span className="ats-header-icon" aria-hidden="true">
          <BriefcaseBusiness size={34} strokeWidth={1.6} />
        </span>
        <div className="ats-header-text">
          <h2>Applications</h2>
          <p>Keep track of applications you add, at every stage.</p>
        </div>
        <Button
          ref={add}
          className="ats-add"
          leadingIcon={<Plus size={18} />}
          onClick={() => setCreating(true)}
        >
          Add application
        </Button>
      </div>
      <div className="ats-toolbar">
        <div className="ats-switches" aria-label="Application filters">
          <div className="ats-segment ats-segment-view">
            <Button
              variant={view === 'board' ? 'primary' : 'secondary'}
              leadingIcon={<LayoutGrid size={14} />}
              onClick={() => setView('board')}
            >
              Board
            </Button>
            <Button
              variant={view === 'list' ? 'primary' : 'secondary'}
              leadingIcon={<List size={14} />}
              onClick={() => setView('list')}
            >
              List
            </Button>
          </div>
          <div className="ats-segment ats-segment-filter">
            <Button
              variant={!archived ? 'primary' : 'secondary'}
              leadingIcon={<Inbox size={14} />}
              onClick={() => filter(false, query)}
            >
              Active
            </Button>
            <Button
              variant={archived ? 'primary' : 'secondary'}
              leadingIcon={<Archive size={14} />}
              onClick={() => filter(true, query)}
            >
              Archived
            </Button>
          </div>
        </div>
        <form
          className="ats-search"
          onSubmit={(event) => {
            event.preventDefault();
            filter(archived, search.trim());
          }}
        >
          <label className="jobs-field">
            <span className="ats-sr-only">Search company or role</span>
            <Search size={18} className="ats-search-icon" aria-hidden="true" />
            <input
              value={search}
              maxLength={200}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search applications…"
            />
          </label>
          <Button variant="secondary" type="submit">
            Search
          </Button>
        </form>
      </div>
      <p className="jobs-meta">
        {items.length} loaded application{items.length === 1 ? '' : 's'}
        {cursor ? ' · More available' : ''}
      </p>
      {loading && <p role="status">Loading applications…</p>}
      {error && (
        <p role="alert" className="jobs-error">
          {error}{' '}
          <Button
            variant="secondary"
            onClick={() =>
              void load(archived, query, failedCursor ?? undefined)
            }
          >
            Retry
          </Button>
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={BriefcaseBusiness}
          title={
            archived
              ? 'No archived applications found'
              : query
                ? 'No matching applications'
                : 'No applications yet'
          }
        >
          <p>Add an application manually or from a job URL.</p>
        </EmptyState>
      )}
      {view === 'board' && !archived ? (
        <div className="ats-lanes" aria-label="Application board">
          {lanes.map((lane) => {
            const LaneIcon = laneIcons[lane];
            const laneItems = items.filter(
              (item) => stageLane(item.currentStage.stageKind) === lane,
            );
            return (
              <section
                className={`ats-lane ats-lane-${lane.toLowerCase()}`}
                key={lane}
                aria-label={lane}
              >
                <h3>
                  <LaneIcon size={20} aria-hidden="true" />
                  <span className="ats-lane-title">{lane}</span>{' '}
                  <span className="ats-lane-count">
                    {laneItems.length}
                    <span className="ats-sr-only"> loaded</span>
                  </span>
                </h3>
                {laneItems.map((item) => (
                  <ApplicationCard
                    key={item.id}
                    item={item}
                    onOpen={(button) => open(item, button)}
                  />
                ))}
              </section>
            );
          })}
        </div>
      ) : (
        <div className="ats-list">
          {items.map((item) => (
            <ApplicationCard
              key={item.id}
              item={item}
              onOpen={(button) => open(item, button)}
            />
          ))}
        </div>
      )}
      {cursor && !error && (
        <Button
          variant="secondary"
          disabled={more || loading}
          onClick={() => void load(archived, query, cursor)}
        >
          {' '}
          {more ? 'Loading…' : 'Load more applications'}
        </Button>
      )}
    </div>
  );
}

function ApplicationCard({
  item,
  onOpen,
}: {
  item: Application;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const lane = stageLane(item.currentStage.stageKind).toLowerCase();
  return (
    <Card
      padding="compact"
      className={`ats-item ats-stage-${lane}`}
      data-application-id={item.id}
    >
      <div className="ats-item-identity">
        <span className="ats-logo" aria-hidden="true">
          {item.companyName.trim().charAt(0).toUpperCase()}
        </span>
        <div>
          <h4>{item.companyName}</h4>
          <p>{item.roleTitle}</p>
        </div>
      </div>
      <span className="ats-stage-pill">{item.currentStage.stageLabel}</span>
      {item.location && <p className="jobs-meta">{item.location}</p>}
      <p className="jobs-meta ats-item-date">
        <CalendarDays size={14} aria-hidden="true" />
        {new Date(item.currentStage.occurredAt).toLocaleDateString()}
      </p>
      <Button
        variant="ghost"
        className="ats-item-open"
        aria-label={`Open application: ${item.roleTitle} at ${item.companyName}`}
        onClick={(event) => onOpen(event.currentTarget)}
      >
        <span className="ats-sr-only">Open application</span>
      </Button>
    </Card>
  );
}

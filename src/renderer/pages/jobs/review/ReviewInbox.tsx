import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownUp,
  ArrowRight,
  Bookmark,
  Building2,
  CheckCircle2,
  Globe,
  Inbox,
  Layers,
  MapPin,
  Minus,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { OpportunitySummary } from '../../../../shared/contracts/job-discovery';
import {
  ApiError,
  decideReviewOpportunity,
  listReviewOpportunities,
} from '../../../api';
import { Button } from '../../../presentation/components/Button';
import { Card } from '../../../presentation/components/Card';
import { EmptyState } from '../../../presentation/components/EmptyState';
import { OpportunityDetailView } from './OpportunityDetailView';
import { ApplyOpportunity } from './ApplyOpportunity';
import './ReviewInbox.css';

type Filter = 'new' | 'saved' | 'dismissed' | 'all';
const filters: Filter[] = ['new', 'saved', 'dismissed', 'all'];
const filterIcons: Record<Filter, LucideIcon> = {
  new: Sparkles,
  saved: Bookmark,
  dismissed: Trash2,
  all: Layers,
};
const pageSize = 20;

function errorText(error: unknown) {
  if (error instanceof ApiError) {
    if (error.code === 'NOT_FOUND')
      return 'This opportunity is no longer available. Refresh the list.';
    if (error.code === 'CONFLICT')
      return 'This decision is no longer available. Refresh the list.';
    return error.message;
  }
  return 'Could not reach the local data store. Please try again.';
}

function evidence(item: OpportunitySummary) {
  if (!item.verified) return 'Unverified · JD unavailable';
  if (item.extractionStatus !== 'ready') return 'JD unavailable';
  return 'JD available';
}

function assessment(item: OpportunitySummary) {
  if (item.matchStatus === 'scored' && item.coverage !== null)
    return `Required skills matched: ${Math.round(item.coverage * 100)}%`;
  if (item.matchStatus === 'stale_extraction') return 'Assessment out of date';
  return 'Not scored';
}

function assessmentTone(item: OpportunitySummary) {
  if (item.matchStatus === 'scored' && item.coverage !== null) return 'scored';
  if (item.matchStatus === 'stale_extraction') return 'stale';
  return 'none';
}

const assessmentIcons: Record<string, LucideIcon> = {
  scored: CheckCircle2,
  stale: TriangleAlert,
  none: Minus,
};

export function ReviewInbox({
  outlet,
  onOpenApplication,
}: {
  outlet: React.RefObject<HTMLDivElement | null>;
  onOpenApplication: (id: string) => void;
}) {
  const [filter, setFilter] = useState<Filter>('new');
  const [items, setItems] = useState<OpportunitySummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [cardErrors, setCardErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<string | null>(null);
  const [selected, setSelected] = useState<OpportunitySummary | null>(null);
  const request = useRef(0);
  const activeFilter = useRef<Filter>('new');
  const mutation = useRef(false);
  const more = useRef(false);
  const alive = useRef(true);
  const savedScroll = useRef(0);
  const backButton = useRef<HTMLButtonElement>(null);
  const returningId = useRef<string | null>(null);
  const listChanged = useRef(false);

  const load = useCallback(async (decision: Filter, next?: string) => {
    if (next && more.current) return;
    const id = ++request.current;
    if (next) {
      more.current = true;
      setLoadingMore(true);
    } else {
      setLoading(true);
      setError(null);
    }
    try {
      const page = await listReviewOpportunities({
        decision,
        limit: pageSize,
        ...(next ? { cursor: next } : {}),
      });
      if (
        !alive.current ||
        id !== request.current ||
        decision !== activeFilter.current
      )
        return;
      setItems((current) => {
        const seen = new Set<string>();
        return [...(next ? current : []), ...page.items].filter((item) => {
          if (seen.has(item.opportunityId)) return false;
          seen.add(item.opportunityId);
          return true;
        });
      });
      setCursor(page.nextCursor);
      setError(null);
    } catch (failure) {
      if (
        alive.current &&
        id === request.current &&
        decision === activeFilter.current
      )
        setError(errorText(failure));
    } finally {
      if (alive.current && id === request.current) {
        setLoading(false);
        setLoadingMore(false);
      }
      if (next && id === request.current) more.current = false;
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void load('new');
    return () => {
      alive.current = false;
      request.current++;
    };
  }, [load]);

  function changeFilter(next: Filter) {
    if (next === activeFilter.current) return;
    activeFilter.current = next;
    request.current++;
    more.current = false;
    setLoadingMore(false);
    setFilter(next);
    setItems([]);
    setCursor(null);
    setError(null);
    setCardErrors({});
    setNotice('');
    if (outlet.current) outlet.current.scrollTop = 0;
    void load(next);
  }

  async function decide(
    item: OpportunitySummary,
    decision: 'new' | 'saved' | 'dismissed',
  ) {
    if (mutation.current) return;
    mutation.current = true;
    request.current++;
    more.current = false;
    setLoadingMore(false);
    setLoading(false);
    setPending(item.opportunityId);
    setCardErrors((current) => {
      const next = { ...current };
      delete next[item.opportunityId];
      return next;
    });
    const initialFilter = activeFilter.current;
    try {
      const confirmed = await decideReviewOpportunity(
        item.opportunityId,
        decision,
      );
      if (!alive.current) return;
      setNotice(
        `${confirmed.title}: ${decision === 'new' ? 'restored' : decision}.`,
      );
      if (initialFilter === activeFilter.current) {
        setItems((current) =>
          current
            .map((entry) =>
              entry.opportunityId === confirmed.opportunityId
                ? confirmed
                : entry,
            )
            .filter(
              (entry) =>
                initialFilter === 'all' ||
                (entry.decision === initialFilter && !entry.applicationId),
            ),
        );
        // A decision can remove an item from an already loaded page. Restart the
        // keyset so the next cursor always describes the visible filter.
        setCursor(null);
        void load(initialFilter);
      } else {
        void load(activeFilter.current);
      }
    } catch (failure) {
      if (alive.current)
        setCardErrors((current) => ({
          ...current,
          [item.opportunityId]: errorText(failure),
        }));
    } finally {
      mutation.current = false;
      if (alive.current) setPending(null);
    }
  }

  function open(item: OpportunitySummary) {
    returningId.current = item.opportunityId;
    savedScroll.current = outlet.current?.scrollTop ?? 0;
    setSelected(item);
    if (outlet.current) outlet.current.scrollTop = 0;
    requestAnimationFrame(() => backButton.current?.focus());
  }
  function back() {
    setSelected(null);
    if (listChanged.current) {
      listChanged.current = false;
      void load(activeFilter.current);
    }
    requestAnimationFrame(() => {
      if (outlet.current) outlet.current.scrollTop = savedScroll.current;
      const button = Array.from(
        outlet.current?.querySelectorAll<HTMLButtonElement>(
          '[data-review-id]',
        ) ?? [],
      ).find((node) => node.dataset.reviewId === returningId.current);
      (
        button ??
        outlet.current?.querySelector<HTMLButtonElement>(
          '.jobs-review-filter[aria-pressed="true"]',
        )
      )?.focus();
    });
  }

  if (selected)
    return (
      <OpportunityDetailView
        key={selected.opportunityId}
        summary={selected}
        backButton={backButton}
        onBack={back}
        onOpenApplication={onOpenApplication}
        onDecision={(confirmed) => {
          listChanged.current = true;
          setSelected(confirmed);
          setItems((current) =>
            current.map((entry) =>
              entry.opportunityId === confirmed.opportunityId
                ? confirmed
                : entry,
            ),
          );
        }}
      />
    );

  return (
    <div className="jobs-review" data-testid="review-inbox">
      <div className="jobs-heading jobs-review-header">
        <span className="jobs-review-header-icon" aria-hidden="true">
          <Inbox size={34} strokeWidth={1.8} />
        </span>
        <div className="jobs-review-header-text">
          <h2>Review opportunities</h2>
          <p>Decide which discovered roles to keep for later.</p>
        </div>
        <Button
          variant="secondary"
          leadingIcon={<RotateCw size={16} />}
          disabled={loading || loadingMore || !!pending}
          onClick={() => void load(filter)}
        >
          Refresh
        </Button>
      </div>
      <div className="jobs-review-toolbar">
        <div
          className="jobs-review-filters"
          role="group"
          aria-label="Filter opportunities"
        >
          {filters.map((value) => {
            const Icon = filterIcons[value];
            return (
              <button
                key={value}
                type="button"
                className="jobs-review-filter"
                aria-pressed={filter === value}
                onClick={() => changeFilter(value)}
              >
                <Icon size={16} aria-hidden="true" />
                {value[0].toUpperCase() + value.slice(1)}
              </button>
            );
          })}
        </div>
        <p className="jobs-review-order">
          <ArrowDownUp size={15} aria-hidden="true" />
          Newest first
        </p>
      </div>
      <p role="status" className="jobs-review-announcement">
        {notice || (loading ? 'Loading opportunities…' : '')}
      </p>
      {error && (
        <p role="alert" className="jobs-error">
          {error}{' '}
          <Button variant="secondary" onClick={() => void load(filter)}>
            Retry
          </Button>
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={Inbox}
          title={
            filter === 'new'
              ? 'No new opportunities'
              : `No ${filter === 'all' ? '' : filter + ' '}opportunities yet`
          }
        >
          <p>
            {filter === 'new'
              ? 'Newly discovered roles will appear here when available.'
              : 'Try another filter or refresh the inbox.'}
          </p>
        </EmptyState>
      )}
      <div className="jobs-review-list">
        {items.map((item) => {
          const tracked = !!item.applicationId || item.decision === 'applied';
          const tone = assessmentTone(item);
          const AssessmentIcon = assessmentIcons[tone];
          return (
            <Card
              key={item.opportunityId}
              padding="compact"
              variant="subtle"
              className="jobs-review-card"
              data-opportunity-id={item.opportunityId}
            >
              <span className="jobs-review-logo" aria-hidden="true">
                <Building2 size={26} strokeWidth={1.8} />
              </span>
              <div className="jobs-review-identity">
                <h3>{item.title}</h3>
                <strong>{item.company ?? 'Employer not provided'}</strong>
                <span className="jobs-meta jobs-review-meta">
                  {!item.location && !item.latestSource?.provider ? (
                    'Location and source not provided'
                  ) : (
                    <>
                      {item.location && (
                        <span>
                          <MapPin size={15} aria-hidden="true" />
                          {item.location}
                        </span>
                      )}
                      {item.location && item.latestSource?.provider && (
                        <span className="jobs-review-sr-only"> · </span>
                      )}
                      {item.latestSource?.provider && (
                        <span>
                          <Globe size={15} aria-hidden="true" />
                          {item.latestSource.provider}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
              <div className="jobs-review-evidence">
                <span className={`jobs-review-chip jobs-review-chip-${tone}`}>
                  <AssessmentIcon size={15} aria-hidden="true" />
                  {assessment(item)}
                </span>
                <span>{evidence(item)}</span>
                {filter === 'all' && (
                  <span>
                    {tracked ? 'Tracked as application' : item.decision}
                  </span>
                )}
              </div>
              <div className="jobs-review-actions">
                {!tracked && item.decision !== 'saved' && (
                  <Button
                    variant="secondary"
                    disabled={!!pending}
                    onClick={() => void decide(item, 'saved')}
                    leadingIcon={<Bookmark size={15} />}
                  >
                    Save
                  </Button>
                )}
                {!tracked && item.decision !== 'dismissed' && (
                  <Button
                    variant="secondary"
                    disabled={!!pending}
                    onClick={() => void decide(item, 'dismissed')}
                    leadingIcon={<Trash2 size={15} />}
                  >
                    Dismiss
                  </Button>
                )}
                {!tracked && item.decision === 'dismissed' && (
                  <Button
                    variant="secondary"
                    disabled={!!pending}
                    onClick={() => void decide(item, 'new')}
                    leadingIcon={<RotateCcw size={15} />}
                  >
                    Restore
                  </Button>
                )}
                <Button
                  className="jobs-review-open"
                  data-review-id={item.opportunityId}
                  disabled={!!pending}
                  onClick={() => open(item)}
                  trailingIcon={<ArrowRight size={15} />}
                  aria-label={`Review ${item.title} at ${item.company ?? 'unknown employer'}`}
                >
                  Review
                </Button>
                {(tracked || item.decision !== 'dismissed') && (
                  <ApplyOpportunity
                    opportunityId={item.opportunityId}
                    applicationId={item.applicationId}
                    dismissed={item.decision === 'dismissed'}
                    onOpen={onOpenApplication}
                  />
                )}
              </div>
              {pending === item.opportunityId && (
                <p role="status">Saving decision…</p>
              )}
              {cardErrors[item.opportunityId] && (
                <p role="alert" className="jobs-error">
                  {cardErrors[item.opportunityId]}
                </p>
              )}
            </Card>
          );
        })}
      </div>
      {cursor && (
        <Button
          variant="secondary"
          disabled={loading || loadingMore || !!pending}
          onClick={() => void load(filter, cursor)}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

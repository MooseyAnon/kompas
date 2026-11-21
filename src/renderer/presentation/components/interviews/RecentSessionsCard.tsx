import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { History, RotateCw } from 'lucide-react';
import { Button } from '../Button';
import { Card } from '../Card';
import { MeadowCardCorner } from '../../meadow/decorations/MeadowCardCorner';
import './RecentSessionsCard.css';

export type RecentSessionAction = {
  id: string;
  label: string;
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  /** Visible label stays short; this names the row for assistive technology. */
  accessibleLabel: string;
  onClick: () => void;
};

export type RecentSessionConfirmation = {
  message: string;
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export type RecentSessionItem = {
  id: string;
  title: string;
  meta: string;
  statusLabel: string;
  statusTone: 'draft' | 'active';
  methodIcon: LucideIcon;
  methodLabel: string;
  current?: boolean;
  actions: readonly RecentSessionAction[];
  confirmation?: RecentSessionConfirmation | null;
};

/** Drafts and unfinished sessions; the caller decides which actions exist. */
export function RecentSessionsCard({
  title,
  status,
  items,
  errorMessage,
  alert,
  emptyText,
  onRetry,
}: {
  title: string;
  status: 'loading' | 'ready' | 'error';
  items: readonly RecentSessionItem[];
  errorMessage?: string;
  /** A failed row action, shown above the list. */
  alert?: string;
  emptyText: string;
  onRetry?: () => void;
}) {
  return (
    <section
      className="recent-sessions"
      aria-labelledby="recent-sessions-title"
      aria-busy={status === 'loading'}
      data-testid="recent-sessions"
    >
      <Card variant="subtle" padding="compact" className="recent-sessions-card">
        <h2 id="recent-sessions-title" className="recent-sessions-title">
          <History size={17} aria-hidden="true" />
          {title}
        </h2>

        {alert && (
          <p
            className="recent-sessions-alert"
            role="alert"
            data-testid="recent-sessions-alert"
          >
            {alert}
          </p>
        )}

        {status === 'loading' && (
          <p className="recent-sessions-quiet">Loading your sessions…</p>
        )}

        {status === 'error' && (
          <div className="recent-sessions-error" role="alert">
            <p>{errorMessage ?? 'Your sessions couldn’t be loaded.'}</p>
            {onRetry && (
              <Button
                variant="ghost"
                leadingIcon={<RotateCw aria-hidden="true" />}
                onClick={onRetry}
              >
                Try again
              </Button>
            )}
          </div>
        )}

        {status === 'ready' && items.length === 0 && (
          <p
            className="recent-sessions-quiet"
            data-testid="recent-sessions-empty"
          >
            {emptyText}
          </p>
        )}

        {status === 'ready' && items.length > 0 && (
          <ul className="recent-sessions-list">
            {items.map((item) => (
              <RecentSessionRow key={item.id} item={item} />
            ))}
          </ul>
        )}
        <MeadowCardCorner variant="subtle" />
      </Card>
    </section>
  );
}

function RecentSessionRow({ item }: { item: RecentSessionItem }) {
  const MethodIcon = item.methodIcon;
  const confirmation = item.confirmation;

  return (
    <li
      className={`recent-session${item.current ? ' is-current' : ''}`}
      data-testid={`recent-session-${item.id}`}
      aria-current={item.current ? 'true' : undefined}
    >
      <span
        className="recent-session-icon"
        title={item.methodLabel}
        aria-hidden="true"
      >
        <MethodIcon size={17} />
      </span>
      <div className="recent-session-copy">
        <strong>{item.title}</strong>
        <span>
          <span className={`recent-session-status is-${item.statusTone}`}>
            {item.statusLabel}
          </span>
          <span className="recent-session-sr">, {item.methodLabel}, </span>
          {item.meta}
        </span>
      </div>

      {confirmation ? (
        <div
          className="recent-session-confirm"
          role="group"
          aria-label={confirmation.message}
        >
          <span>{confirmation.message}</span>
          <Button
            variant="secondary"
            autoFocus
            disabled={confirmation.busy}
            onClick={confirmation.onCancel}
            data-testid="recent-session-confirm-cancel"
          >
            Keep
          </Button>
          <Button
            variant="primary"
            className="recent-session-danger"
            disabled={confirmation.busy}
            onClick={confirmation.onConfirm}
            data-testid="recent-session-confirm"
          >
            {confirmation.busy ? 'Working…' : confirmation.confirmLabel}
          </Button>
        </div>
      ) : (
        <div className="recent-session-actions">
          {item.actions.map((action) => (
            <Button
              key={action.id}
              variant={action.variant ?? 'ghost'}
              disabled={action.disabled}
              aria-label={action.accessibleLabel}
              leadingIcon={
                action.icon ? <action.icon aria-hidden="true" /> : undefined
              }
              onClick={action.onClick}
              data-testid={`recent-session-${action.id}`}
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </li>
  );
}

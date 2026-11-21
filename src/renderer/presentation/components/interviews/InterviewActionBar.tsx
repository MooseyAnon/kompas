import React, { useEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '../Button';
import './InterviewActionBar.css';

export interface InterviewAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  variant?: 'primary' | 'secondary' | 'ghost';
  /** A short second line explaining the effect, for example `Re-answer`. */
  description?: string;
  disabled?: boolean;
  /** Shown while this action's request runs; disables the whole bar. */
  busyLabel?: string;
  busy?: boolean;
  /** Ask inline before running a destructive action (Keep gets focus). */
  confirm?: { message: string; confirmLabel: string };
  onSelect: () => void;
}

/**
 * Contextual session actions. Callers decide which actions exist (from
 * `availableActions`); this only lays them out, shows busy state and runs an
 * inline confirmation. `trailing` actions sit apart, for Leave/Abandon.
 */
export function InterviewActionBar({
  label,
  actions,
  trailing = [],
  'data-testid': testId = 'interview-actions',
}: {
  label: string;
  actions: readonly InterviewAction[];
  trailing?: readonly InterviewAction[];
  'data-testid'?: string;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const returnFocusTo = useRef<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const all = [...actions, ...trailing];
  const busy = all.some((action) => action.busy);
  const pendingConfirm = all.find((action) => action.id === confirming);

  // Keep gets focus when asking; the trigger gets it back after Keep.
  useEffect(() => {
    const root = rootRef.current;
    if (pendingConfirm) {
      root?.querySelector<HTMLButtonElement>('[data-confirm="keep"]')?.focus();
      return;
    }
    const id = returnFocusTo.current;
    returnFocusTo.current = null;
    if (id)
      root?.querySelector<HTMLButtonElement>(`[data-action="${id}"]`)?.focus();
  }, [pendingConfirm]);

  // A confirmation for an action that is no longer offered is dropped.
  useEffect(() => {
    if (confirming && !pendingConfirm) setConfirming(null);
  }, [confirming, pendingConfirm]);

  function keep() {
    setConfirming(null);
  }

  function select(action: InterviewAction) {
    if (action.confirm) {
      returnFocusTo.current = action.id;
      setConfirming(action.id);
      return;
    }
    action.onSelect();
  }

  function renderAction(action: InterviewAction) {
    const Icon = action.icon;
    return (
      <Button
        key={action.id}
        variant={action.variant ?? 'secondary'}
        className={action.description ? 'has-description' : undefined}
        leadingIcon={Icon ? <Icon aria-hidden="true" /> : undefined}
        disabled={busy || action.disabled}
        aria-busy={action.busy || undefined}
        onClick={() => select(action)}
        data-action={action.id}
        data-testid={`${testId}-${action.id}`}
      >
        <span className="interview-action-text">
          <span>
            {action.busy && action.busyLabel ? action.busyLabel : action.label}
          </span>
          {action.description && (
            <span className="interview-action-description">
              {action.description}
            </span>
          )}
        </span>
      </Button>
    );
  }

  return (
    <div
      ref={rootRef}
      className="interview-action-bar"
      role="group"
      aria-label={label}
      data-testid={testId}
    >
      {pendingConfirm?.confirm ? (
        <div
          className="interview-action-confirm"
          role="group"
          aria-label={pendingConfirm.confirm.message}
          data-testid={`${testId}-confirm`}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              keep();
            }
          }}
        >
          <span>{pendingConfirm.confirm.message}</span>
          <Button
            variant="secondary"
            onClick={keep}
            data-confirm="keep"
            data-testid={`${testId}-confirm-keep`}
          >
            Keep
          </Button>
          <Button
            variant="secondary"
            className="is-destructive"
            disabled={busy}
            onClick={() => {
              setConfirming(null);
              returnFocusTo.current = null;
              pendingConfirm.onSelect();
            }}
            data-testid={`${testId}-confirm-accept`}
          >
            {pendingConfirm.confirm.confirmLabel}
          </Button>
        </div>
      ) : (
        <>
          <div className="interview-action-main">
            {actions.map(renderAction)}
          </div>
          {trailing.length > 0 && (
            <div className="interview-action-trailing">
              {trailing.map(renderAction)}
            </div>
          )}
        </>
      )}
    </div>
  );
}

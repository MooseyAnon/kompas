import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import './Overlay.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal pop-up or side panel: Escape and the backdrop close it, focus moves
 * in on open, stays inside while open, and returns to where it was on close.
 */
export function Overlay({
  title,
  subtitle,
  onClose,
  variant = 'modal',
  children,
  labelledBy = 'gnd-overlay-title',
}: {
  title: string;
  subtitle?: React.ReactNode;
  onClose: () => void;
  variant?: 'modal' | 'drawer';
  children: React.ReactNode;
  labelledBy?: string;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const first = panel.current?.querySelector<HTMLElement>(
      '[data-autofocus], ' + FOCUSABLE,
    );
    first?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close.current();
        return;
      }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = Array.from(
        panel.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ).filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const firstItem = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        firstItem.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      before?.focus?.();
    };
  }, []);

  return createPortal(
    <div className={`gnd-overlay gnd-overlay-${variant}`}>
      <div
        className="gnd-overlay-scrim"
        aria-hidden="true"
        onClick={() => close.current()}
      />
      <div
        ref={panel}
        className="gnd-overlay-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
      >
        <div className="gnd-overlay-head">
          <div className="gnd-overlay-titles">
            <h2 id={labelledBy} className="gnd-overlay-title">
              {title}
            </h2>
            {subtitle && <p className="gnd-muted">{subtitle}</p>}
          </div>
          <button
            type="button"
            className="gnd-overlay-close"
            aria-label="Close"
            onClick={() => close.current()}
          >
            <X aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** A short-lived confirmation at the bottom of the window. */
export function Toast({ message }: { message: string | null }) {
  return createPortal(
    <div className="gnd-toast-region" aria-live="polite">
      {message && (
        <div className="gnd-toast" role="status" key={message}>
          {message}
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Show a toast for a moment; calling again restarts the timer. */
export function useToast(duration = 2400) {
  const [message, setMessage] = React.useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = React.useCallback(
    (text: string) => {
      window.clearTimeout(timer.current);
      setMessage(null);
      window.requestAnimationFrame(() => setMessage(text));
      timer.current = window.setTimeout(() => setMessage(null), duration);
    },
    [duration],
  );
  return { message, show };
}

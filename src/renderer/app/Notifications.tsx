import React, { createContext, useContext, useState } from 'react';
import { ApiError } from '../api';
import './Feedback.css';

type Notice = {
  message: string;
  code?: string;
  correlationId?: string;
  kind: 'error' | 'info';
};
type Notify = (notice: Notice) => void;
const NotificationContext = createContext<Notify | null>(null);

export function useNotify(): Notify {
  const notify = useContext(NotificationContext);
  if (!notify) throw new Error('Notification provider missing');
  return notify;
}

export function failureNotice(error: unknown, message: string): Notice {
  if (error instanceof ApiError) {
    return { kind: 'error', message: error.message, code: error.code };
  }
  // Never display an arbitrary exception's message (it could contain user content).
  return { kind: 'error', message };
}

export function Notifications({ children }: { children: React.ReactNode }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  return (
    <NotificationContext.Provider value={setNotice}>
      {children}
      {notice && (
        <div
          className="shell-notice"
          role={notice.kind === 'error' ? 'alert' : 'status'}
          data-testid="shell-notice"
        >
          <span>{notice.message}</span>
          {notice.code && (
            <span className="shell-notice-meta">Code: {notice.code}</span>
          )}
          {notice.correlationId && (
            <span className="shell-notice-meta">
              Reference: {notice.correlationId}
            </span>
          )}
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      )}
    </NotificationContext.Provider>
  );
}

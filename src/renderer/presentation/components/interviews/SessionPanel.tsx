import React, { type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { MeadowCardCorner } from '../../meadow/decorations/MeadowCardCorner';
import './SessionPanel.css';

/** A titled state panel for the session outlet (paused, failed, finished…). */
export function SessionPanel({
  icon: Icon,
  title,
  tone = 'default',
  'data-testid': testId,
  children,
}: {
  icon: LucideIcon;
  title: string;
  tone?: 'default' | 'error';
  'data-testid': string;
  children: ReactNode;
}) {
  const titleId = `${testId}-title`;

  return (
    <section
      className={`session-panel is-${tone}`}
      aria-labelledby={titleId}
      data-testid={testId}
    >
      <span className="session-panel-icon" aria-hidden="true">
        <Icon size={22} />
      </span>
      <div className="session-panel-copy">
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
      {tone === 'default' && <MeadowCardCorner variant="subtle" />}
    </section>
  );
}

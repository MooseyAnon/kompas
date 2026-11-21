import React, { type ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { MeadowCardCorner } from '../meadow/decorations/MeadowCardCorner';
import { Card } from './Card';
import './EmptyState.css';

/** An honest "nothing here yet" panel. It never implies data that does not exist. */
export function EmptyState({
  icon: Icon,
  title,
  headingLevel = 2,
  children,
  className,
  ...props
}: {
  icon: LucideIcon;
  title: string;
  headingLevel?: 2 | 3;
  children?: ReactNode;
  className?: string;
  'data-testid'?: string;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';

  return (
    <Card
      {...props}
      variant="subtle"
      className={`ui-empty-state${className ? ` ${className}` : ''}`}
    >
      <span className="ui-empty-state-icon" aria-hidden="true">
        <Icon size={24} strokeWidth={2} />
      </span>
      <div className="ui-empty-state-copy">
        <Heading>{title}</Heading>
        {children}
      </div>
      <MeadowCardCorner variant="floral" />
    </Card>
  );
}

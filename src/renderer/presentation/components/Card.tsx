import React, {
  type ButtonHTMLAttributes,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import './Card.css';

type CardProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'onClick' | 'onKeyDown' | 'tabIndex'
> & {
  variant?: 'default' | 'subtle';
  padding?: 'regular' | 'compact';
  header?: ReactNode;
};

/** A static content surface; put controls in its children or optional header. */
export function Card({
  variant = 'default',
  padding = 'regular',
  header,
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      {...props}
      className={`ui-card ui-card-${variant} ui-card-${padding}${className ? ` ${className}` : ''}`}
    >
      {header && <div className="ui-card-header">{header}</div>}
      {children}
    </div>
  );
}

type CardButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  selected?: boolean;
  padding?: 'regular' | 'compact';
};

/** A whole-card action. Do not place other interactive controls inside it. */
export function CardButton({
  selected,
  padding = 'compact',
  className,
  children,
  type = 'button',
  ...props
}: CardButtonProps) {
  return (
    <button
      {...props}
      type={type}
      aria-pressed={selected}
      className={`ui-card ui-card-interactive ui-card-${padding}${selected ? ' ui-card-selected' : ''}${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
}

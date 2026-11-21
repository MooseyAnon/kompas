import React, { type HTMLAttributes, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import './Disclosure.css';

type DisclosureProps = HTMLAttributes<HTMLDetailsElement> & {
  label: ReactNode;
  children: ReactNode;
  open?: boolean;
};

/** Native details keeps its contents mounted and handles keyboard/expanded semantics. */
export function Disclosure({
  label,
  children,
  className,
  ...props
}: DisclosureProps) {
  return (
    <details
      {...props}
      className={`ui-disclosure${className ? ` ${className}` : ''}`}
    >
      <summary className="ui-disclosure-summary">
        <span>{label}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className="ui-disclosure-content">{children}</div>
    </details>
  );
}

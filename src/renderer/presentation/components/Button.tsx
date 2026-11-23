import React, {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import './Button.css';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'light';
  /** `hero`: the GND call to action (uppercase, 51px tall). */
  size?: 'default' | 'hero';
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export function Button({
  variant = 'primary',
  size = 'default',
  leadingIcon,
  trailingIcon,
  className,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`ui-button ui-button-${variant}${size === 'hero' ? ' ui-button-hero' : ''}${className ? ` ${className}` : ''}`}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}

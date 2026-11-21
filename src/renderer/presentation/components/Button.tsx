import React, {
  type ButtonHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';
import './Button.css';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: 'primary' | 'secondary' | 'ghost';
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
};

export function Button({
  variant = 'primary',
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
      className={`ui-button ui-button-${variant}${className ? ` ${className}` : ''}`}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
}

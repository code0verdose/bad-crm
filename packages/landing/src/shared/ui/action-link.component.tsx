import clsx from 'clsx';
import { type ReactNode } from 'react';

import classes from './action-link.module.css';

/**
 * Every call to action on this page is a link, never a `<button>`.
 *
 * There is nothing to submit here: the page is static and every action navigates somewhere. An
 * element that looks like a button but navigates should still be an anchor, because that is what
 * gives it a target, a context menu, middle-click and the role a screen reader announces.
 */
interface ActionLinkProps {
  href: string;
  children: ReactNode;
  variant?: 'primary' | 'ghost';
  size?: 'md' | 'lg';
  className?: string | undefined;
}

export const ActionLink = ({
  href,
  children,
  variant = 'primary',
  size = 'md',
  className,
}: ActionLinkProps) => (
  <a
    href={href}
    className={clsx(
      classes['link'],
      classes[variant],
      size === 'lg' && classes['large'],
      className,
    )}
  >
    {children}
  </a>
);

import clsx from 'clsx';
import { type ReactNode } from 'react';

import classes from './page-section.module.css';

/**
 * The rhythm of the page: one vertical measure, one content width, one landmark per section.
 *
 * `id` is not decoration — it is what the header navigation scrolls to, so every section that
 * appears in the navigation has one.
 */
interface PageSectionProps {
  children: ReactNode;
  id?: string | undefined;
  /** Sections that own their own vertical space — pinned and sticky scenes — opt out of padding. */
  flush?: boolean;
  className?: string | undefined;
  labelledBy?: string | undefined;
}

export const PageSection = ({
  children,
  id,
  flush = false,
  className,
  labelledBy,
}: PageSectionProps) => (
  <section
    id={id}
    aria-labelledby={labelledBy}
    className={clsx(classes['section'], flush && classes['flush'], className)}
  >
    <div className={classes['inner']}>{children}</div>
  </section>
);

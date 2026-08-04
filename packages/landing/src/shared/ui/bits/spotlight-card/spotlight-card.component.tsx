import clsx from 'clsx';
import { type MouseEventHandler, type ReactNode, useRef } from 'react';

import { useMediaQuery } from '@/shared/lib/use-media-query.hook.js';

import classes from './spotlight-card.module.css';

/*
 * Ported from React Bits (MIT) — see `SOURCE.md` for the origin and the list of changes.
 *
 * The highlight is a CSS radial gradient positioned by two custom properties, so following the
 * pointer costs one style write per move and no React render at all.
 */

interface SpotlightCardProps {
  children: ReactNode;
  className?: string | undefined;
}

export const SpotlightCard = ({ children, className }: SpotlightCardProps) => {
  const ref = useRef<HTMLDivElement>(null);
  const finePointer = useMediaQuery('(hover: hover) and (pointer: fine)');

  const handleMouseMove: MouseEventHandler<HTMLDivElement> = (event) => {
    const node = ref.current;
    if (!node || !finePointer) return;

    const box = node.getBoundingClientRect();
    node.style.setProperty(
      '--bcl-spotlight-x',
      `${((event.clientX - box.left) / box.width) * 100}%`,
    );
    node.style.setProperty(
      '--bcl-spotlight-y',
      `${((event.clientY - box.top) / box.height) * 100}%`,
    );
  };

  return (
    <div ref={ref} onMouseMove={handleMouseMove} className={clsx(classes['card'], className)}>
      {children}
    </div>
  );
};

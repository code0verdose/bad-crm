import { Stack } from '@mantine/core';
import { type ReactNode } from 'react';

import classes from './centered-screen.module.css';

export interface CenteredScreenProps {
  readonly children: ReactNode;
}

/**
 * The layout every screen outside the shell wears: one column, centred in the viewport.
 *
 * Sign-in, password recovery and password reset are all the same shape — a heading, one short form,
 * one link — and all three render outside `AppShell`, which is what makes the landmark part
 * load-bearing rather than cosmetic. The public branch has no `AppShell.Main`, so content here sits
 * in no landmark at all unless somebody remembers to say `component="main"`; that is an `axe`
 * violation and a screen reader with nothing to jump to (`rules/a11y.mdc` §20). Remembering it once
 * is better than remembering it three times.
 *
 * The full-height centring is a class rather than style props, and not only because style props are
 * inline styles by another name (`rules/design-system.mdc` §5): `h="100dvh"` also broke the runner,
 * because jsdom cannot resolve `dvh` in `getComputedStyle` and threw while looking for a heading.
 */
export function CenteredScreen({ children }: CenteredScreenProps) {
  return (
    <Stack align="center" className={classes['root']} component="main" gap="lg" justify="center">
      {children}
    </Stack>
  );
}

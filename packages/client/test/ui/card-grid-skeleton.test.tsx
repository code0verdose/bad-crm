import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';

import { SharedUi } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * The placeholder of a card grid: as many cards as are coming, busy for assistive technology and
 * silent about the bars themselves (`rules/a11y.mdc` §16).
 */
const wrap = (ui: ReactNode, colorScheme: 'light' | 'dark' = 'light') =>
  render(
    <MantineProvider env="test" forceColorScheme={colorScheme}>
      {ui}
    </MantineProvider>,
  );

describe('CardGridSkeleton', () => {
  it('draws the number of cards it is asked for, three lines each', () => {
    wrap(<SharedUi.CardGridSkeleton cards={4} />);

    const grid = screen.getByTestId('card-grid-skeleton');

    expect(grid.children).toHaveLength(4);
    expect([...grid.children].map((card) => card.children.length)).toEqual([3, 3, 3, 3]);
  });

  it('draws six cards by default', () => {
    wrap(<SharedUi.CardGridSkeleton />);

    expect(screen.getByTestId('card-grid-skeleton').children).toHaveLength(6);
  });

  it('tells assistive technology the region is busy and hides every bar', () => {
    wrap(<SharedUi.CardGridSkeleton cards={2} />);

    const grid = screen.getByTestId('card-grid-skeleton');
    const bars = grid.querySelectorAll('.mantine-Skeleton-root');

    expect(grid).toHaveAttribute('aria-busy', 'true');
    expect(bars).toHaveLength(6);
    for (const bar of bars) expect(bar).toHaveAttribute('aria-hidden', 'true');
  });

  it.each(['light', 'dark'] as const)(
    'has no accessibility violation in the %s scheme',
    async (scheme) => {
      const { container } = wrap(<SharedUi.CardGridSkeleton cards={2} />, scheme);

      expect(await axeViolationsIn(container, { control: 'aria-allowed-attr' })).toEqual([]);
    },
  );
});

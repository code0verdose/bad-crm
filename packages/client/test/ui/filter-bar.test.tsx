import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SharedUi } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * What is currently narrowing a list, shown as things that can be taken off.
 *
 * The failure this exists to prevent is the quiet one: a filter left on from a previous visit, a list
 * that looks empty, and no way to see why. So an active filter is a visible chip with its own remove
 * control — and «Сбросить» appears only when there is something to reset, because a permanently
 * visible reset button is one more thing to read and mean nothing.
 *
 * Presentational: it neither reads the URL nor decides what a filter means. The unit that owns the
 * list passes what is active and gets told what was removed (`rules/lists-and-filters.mdc`).
 */
const wrap = (ui: ReactNode) => render(<MantineProvider env="test">{ui}</MantineProvider>);

/**
 * No anchor: where focus goes when a control of the bar leaves is proven on the screens that own
 * one (`projects-list-screen.test.tsx`) and on the hook itself (`focus-handoff.test.tsx`).
 */
const NO_ANCHOR = { current: null };

const FILTERS = [
  { id: 'status', labelKey: 'filter.status.active' },
  { id: 'team', labelKey: 'filter.team.platform' },
];

describe('FilterBar', () => {
  it('shows one chip per active filter', () => {
    wrap(
      <SharedUi.FilterBar
        active={FILTERS}
        onRemove={vi.fn()}
        onReset={vi.fn()}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    expect(screen.getByText('filter.status.active')).toBeInTheDocument();
    expect(screen.getByText('filter.team.platform')).toBeInTheDocument();
  });

  it('names which filter was taken off, not merely that one was', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    wrap(
      <SharedUi.FilterBar
        active={FILTERS}
        onRemove={onRemove}
        onReset={vi.fn()}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    // One static key with the filter's name interpolated in — ADR-0019 forbids composing a key at
    // runtime, so every chip's remove button shares this name and the chips are told apart by order.
    await user.click(screen.getAllByRole('button', { name: 'filter.remove' })[0] as HTMLElement);

    expect(onRemove).toHaveBeenCalledWith('status');
  });

  it('offers a reset while anything is on', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    wrap(
      <SharedUi.FilterBar
        active={FILTERS}
        onRemove={vi.fn()}
        onReset={onReset}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'filter.reset' }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  /**
   * Nothing active means nothing to draw — including no reset. A bar that is always there occupies a
   * row of the screen to say «no filters», which is what the unfiltered list already says.
   */
  it('renders nothing at all when no filter is on', () => {
    wrap(
      <SharedUi.FilterBar
        active={[]}
        onRemove={vi.fn()}
        onReset={vi.fn()}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    expect(screen.queryByRole('button', { name: 'filter.reset' })).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  /**
   * And the control is reachable without a mouse, which Mantine's default would have prevented: a
   * `Pill` renders its remove button `aria-hidden` with `tabIndex={-1}`, because inside `PillsInput`
   * removal is Backspace and the cross is a mouse affordance. A chip standing on its own has no such
   * keyboard path — the filter could be applied and never taken off. axe does not report it, because
   * an `aria-hidden` button is not a button it examines, so it is asserted here.
   */
  it('lets a filter be taken off with the keyboard', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    wrap(
      <SharedUi.FilterBar
        active={FILTERS}
        onRemove={onRemove}
        onReset={vi.fn()}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    (screen.getAllByRole('button', { name: 'filter.remove' })[0] as HTMLElement).focus();
    await user.keyboard('{Enter}');

    expect(onRemove).toHaveBeenCalledWith('status');
  });

  /**
   * The count is what a collapsed filter panel shows on a narrow screen, so it has to be readable
   * rather than inferred from how many chips happen to fit.
   */
  it('announces how many filters are on', () => {
    wrap(
      <SharedUi.FilterBar
        active={FILTERS}
        onRemove={vi.fn()}
        onReset={vi.fn()}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('2');
  });

  it('has no accessibility violation', async () => {
    const { container } = wrap(
      <SharedUi.FilterBar
        active={FILTERS}
        onRemove={vi.fn()}
        onReset={vi.fn()}
        returnFocusTo={NO_ANCHOR}
      />,
    );

    // The bar is made of buttons — one per chip, plus the reset — so `button-name` is the rule it
    // is known to answer, and a scan that reports nothing without exercising it scanned nothing.
    expect(await axeViolationsIn(container, { control: 'button-name' })).toEqual([]);
  });
});

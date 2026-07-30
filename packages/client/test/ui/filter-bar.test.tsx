import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SharedUi } from '@shared';

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

const FILTERS = [
  { id: 'status', labelKey: 'filter.status.active' },
  { id: 'team', labelKey: 'filter.team.platform' },
];

describe('FilterBar', () => {
  it('shows one chip per active filter', () => {
    wrap(<SharedUi.FilterBar active={FILTERS} onRemove={vi.fn()} onReset={vi.fn()} />);

    expect(screen.getByText('filter.status.active')).toBeInTheDocument();
    expect(screen.getByText('filter.team.platform')).toBeInTheDocument();
  });

  it('names which filter was taken off, not merely that one was', async () => {
    const user = userEvent.setup();
    const onRemove = vi.fn();
    wrap(<SharedUi.FilterBar active={FILTERS} onRemove={onRemove} onReset={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'filter.remove.status' }));

    expect(onRemove).toHaveBeenCalledWith('status');
  });

  it('offers a reset while anything is on', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    wrap(<SharedUi.FilterBar active={FILTERS} onRemove={vi.fn()} onReset={onReset} />);

    await user.click(screen.getByRole('button', { name: 'filter.reset' }));

    expect(onReset).toHaveBeenCalledTimes(1);
  });

  /**
   * Nothing active means nothing to draw — including no reset. A bar that is always there occupies a
   * row of the screen to say «no filters», which is what the unfiltered list already says.
   */
  it('renders nothing at all when no filter is on', () => {
    wrap(<SharedUi.FilterBar active={[]} onRemove={vi.fn()} onReset={vi.fn()} />);

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
    wrap(<SharedUi.FilterBar active={FILTERS} onRemove={onRemove} onReset={vi.fn()} />);

    screen.getByRole('button', { name: 'filter.remove.status' }).focus();
    await user.keyboard('{Enter}');

    expect(onRemove).toHaveBeenCalledWith('status');
  });

  /**
   * The count is what a collapsed filter panel shows on a narrow screen, so it has to be readable
   * rather than inferred from how many chips happen to fit.
   */
  it('announces how many filters are on', () => {
    wrap(<SharedUi.FilterBar active={FILTERS} onRemove={vi.fn()} onReset={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('2');
  });

  it('has no accessibility violation', async () => {
    const { container } = wrap(
      <SharedUi.FilterBar active={FILTERS} onRemove={vi.fn()} onReset={vi.fn()} />,
    );

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});

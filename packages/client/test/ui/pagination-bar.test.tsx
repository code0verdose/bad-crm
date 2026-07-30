import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SharedUi } from '@shared';

/**
 * The bar under a list, and the one number people actually look for.
 *
 * «Показано N из M» is not decoration: a list that says only «страница 3» leaves the reader unable to
 * tell a filter that matched little from a filter that matched nothing, and unable to judge whether
 * paging further is worth it. So the count is part of the component rather than something each screen
 * remembers to add.
 *
 * It is presentational on purpose — it owns no page state, reads no URL and fetches nothing. Where
 * the numbers come from is the list's business (`rules/lists-and-filters.mdc`: the URL is the source
 * of truth); this draws them and reports what was clicked.
 */
const wrap = (ui: ReactNode) => render(<MantineProvider env="test">{ui}</MantineProvider>);

describe('PaginationBar', () => {
  it('says how much of the whole is on screen', () => {
    wrap(<SharedUi.PaginationBar page={2} perPage={25} total={137} onPageChange={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('26–50 / 137');
  });

  it('does not promise more rows than exist on the last page', () => {
    wrap(<SharedUi.PaginationBar page={6} perPage={25} total={137} onPageChange={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('126–137 / 137');
  });

  /**
   * Nothing found is a state, not an absence of one. Rendering «0–0 / 0» beside a disabled pager is
   * how a list says «the filter is doing something» rather than looking broken.
   */
  it('reports an empty result without pretending there is a first row', () => {
    wrap(<SharedUi.PaginationBar page={1} perPage={25} total={0} onPageChange={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('0 / 0');
  });

  it('reports the page a reader asked for', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    wrap(<SharedUi.PaginationBar page={1} perPage={25} total={137} onPageChange={onPageChange} />);

    // By text rather than by role and name: computing an accessible name for a Mantine control makes
    // jsdom walk `getComputedStyle`, which throws inside its own font-size resolver on these nodes.
    // The property under test is the callback, not the name — the names are asserted by axe below.
    await user.click(screen.getByText('2'));

    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  /**
   * One page is no paging. The control is hidden rather than disabled, because a disabled pager is a
   * thing to look at and decide about, and there is nothing to decide.
   */
  it('offers no pager when everything fits on one page', () => {
    wrap(<SharedUi.PaginationBar page={1} perPage={25} total={12} onPageChange={vi.fn()} />);

    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1–12 / 12');
  });

  it('has no accessibility violation', async () => {
    const { container } = wrap(
      <SharedUi.PaginationBar page={2} perPage={25} total={137} onPageChange={vi.fn()} />,
    );

    const { violations } = await axe.run(container, {
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(violations.map((violation) => violation.id)).toEqual([]);
  });
});

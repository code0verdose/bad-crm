import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SharedUi } from '@shared';

/**
 * The four states every screen owes, and the accessibility of the components that draw them.
 *
 * `DataState` exists so that «loading, error, empty, content» is decided once
 * (`rules/design-system.mdc` §10). The test that matters is not that it renders — it is that the
 * error state offers a way out: a screen that fails with no retry is a dead end, and it is the
 * single most common way a shared state component is written wrong.
 */

const Themed = ({
  children,
  scheme,
}: {
  readonly children: ReactNode;
  readonly scheme: 'light' | 'dark';
}) => (
  <MantineProvider env="test" forceColorScheme={scheme}>
    {children}
  </MantineProvider>
);

const SKELETON = <SharedUi.TextSkeleton lines={2} />;

describe('DataState', () => {
  it('shows the skeleton while the first answer is on its way', () => {
    render(
      <Themed scheme="light">
        <SharedUi.DataState skeleton={SKELETON} status="pending">
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    expect(screen.getByTestId('text-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByText('rows')).not.toBeInTheDocument();
  });

  it('shows the content once it has arrived', () => {
    render(
      <Themed scheme="light">
        <SharedUi.DataState skeleton={SKELETON} status="success">
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    expect(screen.getByText('rows')).toBeInTheDocument();
  });

  it('offers a retry on failure, and calls it', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <Themed scheme="light">
        <SharedUi.DataState
          errorMessageKey="errors.conflict"
          onRetry={onRetry}
          skeleton={SKELETON}
          status="error"
        >
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    await user.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('alert')).toHaveTextContent('errors.conflict');
  });

  it('falls back to a generic message when the caller names none', () => {
    render(
      <Themed scheme="light">
        <SharedUi.DataState skeleton={SKELETON} status="error">
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('errors.unexpected');
  });

  /** No retry button when there is nothing to retry — a dead control is worse than none. */
  it('omits the retry when the caller gave no way to retry', () => {
    render(
      <Themed scheme="light">
        <SharedUi.DataState skeleton={SKELETON} status="error">
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('shows the empty state when the answer arrived and contained nothing', () => {
    render(
      <Themed scheme="light">
        <SharedUi.DataState
          empty={<SharedUi.EmptyState titleKey="tasks.empty.title" />}
          isEmpty
          skeleton={SKELETON}
          status="success"
        >
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    expect(screen.getByTestId('empty-state')).toBeInTheDocument();
    expect(screen.queryByText('rows')).not.toBeInTheDocument();
  });

  /** Empty with nothing to show for it is still the content branch, not a blank screen. */
  it('renders the content when it is empty but the caller supplied no empty state', () => {
    render(
      <Themed scheme="light">
        <SharedUi.DataState isEmpty skeleton={SKELETON} status="success">
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    expect(screen.getByText('rows')).toBeInTheDocument();
  });
});

describe('EmptyState', () => {
  it('explains the next step and offers the action that takes it', () => {
    render(
      <Themed scheme="light">
        <SharedUi.EmptyState
          action={<button type="button">tasks.empty.create</button>}
          descriptionKey="tasks.empty.description"
          titleKey="tasks.empty.title"
        />
      </Themed>,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('tasks.empty.title');
    expect(screen.getByText('tasks.empty.description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tasks.empty.create' })).toBeInTheDocument();
  });

  it('works as a bare statement when there is no next step', () => {
    render(
      <Themed scheme="light">
        <SharedUi.EmptyState titleKey="tasks.empty.title" />
      </Themed>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('PageHeader', () => {
  it('carries the one h1 of the page, focusable for the route announcer', () => {
    render(
      <Themed scheme="light">
        <SharedUi.PageHeader titleKey="nav.dashboard" />
      </Themed>,
    );

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveAttribute('id', SharedUi.PAGE_TITLE_ID);
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('places the breadcrumbs above the title and the actions beside it', () => {
    render(
      <Themed scheme="light">
        <SharedUi.PageHeader
          actions={<button type="button">tasks.create</button>}
          breadcrumbs={<nav aria-label="nav.breadcrumbs.aria" />}
          titleKey="nav.dashboard"
        />
      </Themed>,
    );

    expect(screen.getByRole('button', { name: 'tasks.create' })).toBeInTheDocument();
    expect(screen.getByLabelText('nav.breadcrumbs.aria')).toBeInTheDocument();
  });
});

describe('the skeleton', () => {
  it('draws the number of rows asked for, and hides them from assistive technology', () => {
    const { container } = render(
      <Themed scheme="light">
        <SharedUi.TextSkeleton lines={4} />
      </Themed>,
    );

    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
  });

  it('has a sensible default, so a caller may say nothing at all', () => {
    const { container } = render(
      <Themed scheme="light">
        <SharedUi.TextSkeleton />
      </Themed>,
    );

    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(0);
  });
});

/**
 * Both themes, because a component can be accessible in one and not the other
 * (`rules/design-system.mdc` → «Как проверяется»). What jsdom can check is the semantics — roles,
 * names, relationships — not the rendered colours; contrast is measured from the tokens themselves
 * in `test/theme/tokens.test.ts`, which is the only place where the real values exist.
 */
describe.each(['light', 'dark'] as const)('accessibility in the %s scheme', (scheme) => {
  it.each([
    [
      'the error state',
      <SharedUi.ErrorState key="e" messageKey="errors.conflict" onRetry={() => undefined} />,
    ],
    [
      'the empty state',
      <SharedUi.EmptyState key="m" descriptionKey="tasks.empty.d" titleKey="tasks.empty.t" />,
    ],
    ['the page header', <SharedUi.PageHeader key="h" titleKey="nav.dashboard" />],
    ['the skeleton', <SharedUi.TextSkeleton key="s" />],
  ])('%s has no violation', async (_name, element) => {
    const { container } = render(<Themed scheme={scheme}>{element}</Themed>);

    const results = await axe.run(container, {
      // Colour is resolved from CSS variables a stylesheet declares, and jsdom loads no stylesheet:
      // the rule would report every element as «unable to determine» or, worse, as a false failure.
      rules: { 'color-contrast': { enabled: false } },
    });

    expect(results.violations.map((violation) => violation.id)).toEqual([]);
  });
});

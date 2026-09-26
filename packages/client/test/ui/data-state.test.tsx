import { MantineProvider } from '@mantine/core';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { SharedUi } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

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
    const onRetry = vi.fn(() => Promise.resolve());
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

  /**
   * Where focus goes around a retry, and when.
   *
   * Focus stays on «Retry» until the reload answers: if it fails again, the alert is the same DOM
   * with the same sentence and a live region says nothing — the button the reader is on is the only
   * thing that can tell them. Only a success unmounts the button, and only then does focus move, to
   * the heading of the section it sat in; without that it would fall to `<body>`.
   */
  describe('around a retry', () => {
    const TEAM = 'projects.overview.team';

    /** A reload the case settles by hand. */
    const reload = () => {
      let settle = (): void => undefined;
      const promise = new Promise<void>((resolve) => {
        settle = resolve;
      });

      return { onRetry: vi.fn(() => promise), settle };
    };

    const inSections = (status: SharedUi.DataStatus, onRetry: () => Promise<unknown>) => (
      <Themed scheme="light">
        {/* CONTROL: a section before it, so «the first section heading» is not the answer. */}
        <SharedUi.Section titleKey="projects.overview.about">
          <input aria-label="elsewhere" />
        </SharedUi.Section>
        <SharedUi.Section titleKey={TEAM}>
          <SharedUi.DataState onRetry={onRetry} skeleton={SKELETON} status={status}>
            <p>rows</p>
          </SharedUi.DataState>
        </SharedUi.Section>
      </Themed>
    );

    it('keeps focus on the button, busy, while the reload is on its way', async () => {
      const user = userEvent.setup();
      const { onRetry } = reload();

      render(inSections('error', onRetry));

      const retry = screen.getByRole('button', { name: 'common.retry' });

      await user.click(retry);

      expect(retry).toHaveFocus();
      expect(retry).toHaveAttribute('aria-disabled', 'true');
      // Unavailable *and why*: `aria-busy` says the control is working, not merely switched off
      // (`rules/a11y.mdc` §16).
      expect(retry).toHaveAttribute('aria-busy', 'true');
      // Busy and still focusable: a native `disabled` would push focus off the one control the
      // reader is waiting on (the HTML focus fixup rule), which is the failure this state avoids.
      expect(retry).not.toBeDisabled();
    });

    it('does not ask twice while the first reload is still on its way', async () => {
      const user = userEvent.setup();
      const { onRetry } = reload();

      render(inSections('error', onRetry));

      const retry = screen.getByRole('button', { name: 'common.retry' });

      await user.click(retry);
      await user.click(retry);
      await user.keyboard('{Enter}');

      expect(onRetry).toHaveBeenCalledOnce();
    });

    it('leaves focus on the button, ready again, when the reload fails once more', async () => {
      const user = userEvent.setup();
      const { onRetry, settle } = reload();

      render(inSections('error', onRetry));

      const retry = screen.getByRole('button', { name: 'common.retry' });

      await user.click(retry);
      await act(async () => {
        settle();
        await Promise.resolve();
      });

      expect(retry).toHaveFocus();
      expect(retry).not.toHaveAttribute('aria-disabled');
      expect(retry).not.toHaveAttribute('aria-busy');
      expect(screen.getByRole('heading', { name: TEAM })).not.toHaveFocus();
    });

    it('moves focus to the heading of its section once the reload succeeds — not the neighbouring one', async () => {
      const user = userEvent.setup();
      const { onRetry } = reload();
      const { rerender } = render(inSections('error', onRetry));

      await user.click(screen.getByRole('button', { name: 'common.retry' }));
      rerender(inSections('success', onRetry));

      expect(screen.getByText('rows')).toBeInTheDocument();
      expect(screen.getByRole('heading', { name: TEAM })).toHaveFocus();
    });

    /**
     * The hand-off is for a button that *had* focus. `StrictMode` — how the application mounts —
     * detaches and re-attaches every new ref once, outside the commit, so a hand-off that did not
     * ask where focus was would pull it into the section each time an error state appears.
     *
     * (A reader who moved elsewhere before a *success* needs no case of its own: React puts focus
     * back on the element that held it before the commit when that element is still in the document,
     * so that outcome is the renderer's, not this component's — measured: the case stays green with
     * the check removed.)
     */
    it('takes no focus when it appears — not even under the double mount of StrictMode', () => {
      const { onRetry } = reload();
      const { rerender } = render(<StrictMode>{inSections('pending', onRetry)}</StrictMode>);
      const elsewhere = screen.getByRole('textbox', { name: 'elsewhere' });

      act(() => {
        elsewhere.focus();
      });
      rerender(<StrictMode>{inSections('error', onRetry)}</StrictMode>);

      expect(screen.getByRole('button', { name: 'common.retry' })).toBeInTheDocument();
      expect(elsewhere).toHaveFocus();
    });

    it('asks again once the previous reload has answered', async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn(() => Promise.resolve());

      render(inSections('error', onRetry));

      const retry = screen.getByRole('button', { name: 'common.retry' });

      await user.click(retry);
      await waitFor(() => {
        expect(retry).not.toHaveAttribute('aria-disabled');
      });
      await user.click(retry);

      expect(onRetry).toHaveBeenCalledTimes(2);
    });

    it('is ready again when the reload itself rejects', async () => {
      const user = userEvent.setup();
      const onRetry = vi.fn(() => Promise.reject(new Error('router gave up')));

      render(inSections('error', onRetry));

      const retry = screen.getByRole('button', { name: 'common.retry' });

      await user.click(retry);

      await waitFor(() => {
        expect(retry).not.toHaveAttribute('aria-disabled');
      });
      expect(retry).toHaveFocus();
    });
  });

  it('leaves focus on the button outside a section — the route announcer owns that case', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn(() => Promise.resolve());
    render(
      <Themed scheme="light">
        <SharedUi.DataState onRetry={onRetry} skeleton={SKELETON} status="error">
          <p>rows</p>
        </SharedUi.DataState>
      </Themed>,
    );

    const retry = screen.getByRole('button', { name: 'common.retry' });

    await user.click(retry);

    expect(onRetry).toHaveBeenCalledOnce();
    expect(retry).toHaveFocus();
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
          empty={<SharedUi.EmptyState titleKey="common.loading" />}
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
          descriptionKey="common.retry"
          titleKey="common.loading"
        />
      </Themed>,
    );

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('common.loading');
    expect(screen.getByText('common.retry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'tasks.empty.create' })).toBeInTheDocument();
  });

  it('works as a bare statement when there is no next step', () => {
    render(
      <Themed scheme="light">
        <SharedUi.EmptyState titleKey="common.loading" />
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
  /**
   * The third column is the control the scan is asserted to have exercised, and it differs per
   * state because the markup does: the error state offers a button, the two headed states carry a
   * heading, and the skeleton is a set of `aria-hidden` boxes with neither. Naming a rule the state
   * is known to answer is what separates «clean» from «scanned nothing» — an empty run reports no
   * violation just as convincingly as a correct one.
   */
  it.each([
    [
      'the error state',
      <SharedUi.ErrorState
        key="e"
        messageKey="errors.conflict"
        onRetry={() => Promise.resolve()}
      />,
      'button-name',
    ],
    [
      'the empty state',
      <SharedUi.EmptyState key="m" descriptionKey="tasks.empty.d" titleKey="tasks.empty.t" />,
      'heading-order',
    ],
    ['the page header', <SharedUi.PageHeader key="h" titleKey="nav.dashboard" />, 'empty-heading'],
    ['the skeleton', <SharedUi.TextSkeleton key="s" />, 'aria-hidden-focus'],
  ])('%s has no violation', async (_name, element, control) => {
    const { container } = render(<Themed scheme={scheme}>{element}</Themed>);

    expect(await axeViolationsIn(container, { control })).toEqual([]);
  });
});

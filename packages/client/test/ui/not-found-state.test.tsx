import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { SharedI18n, SharedUi } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * The screen a person meets at an address that leads nowhere — or to something they may not know
 * exists (`ux-architecture.md` → «403 vs 404»). The counterpart of `ForbiddenState`, under the same
 * contract: it replaces the route's content, so its heading is the page's.
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

describe('NotFoundState', () => {
  /**
   * The heading is the page's `h1` and carries the id the route announcer moves focus to
   * (`rules/a11y.mdc` §21). As an `EmptyState` it was an `h2` without one, and focus fell to
   * `<body>` after a navigation to a missing project.
   */
  it('is the page heading, and can take focus after the navigation', () => {
    render(
      <Themed scheme="light">
        <SharedUi.NotFoundState />
      </Themed>,
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'errors.not_found.title' });

    expect(heading).toHaveAttribute('id', SharedUi.PAGE_TITLE_ID);
    expect(heading).toHaveAttribute('tabindex', '-1');

    heading.focus();
    expect(heading).toHaveFocus();
    expect(screen.getByText('errors.not_found.description')).toBeInTheDocument();
  });

  it('renders the way out its caller supplied', () => {
    render(
      <Themed scheme="light">
        <SharedUi.NotFoundState action={<button type="button">errors.not_found.action</button>} />
      </Themed>,
    );

    expect(screen.getByRole('button', { name: 'errors.not_found.action' })).toBeInTheDocument();
  });

  /**
   * CONTROL: the empty state keeps its `h2` and no id. It sits under a page that already has the
   * `h1`, and a second page heading — or a second element with the announcer's id — is the defect
   * this split exists to prevent.
   */
  it('CONTROL: leaves the in-page empty state a section heading', () => {
    render(
      <Themed scheme="light">
        <SharedUi.EmptyState titleKey="teams.empty.title" />
      </Themed>,
    );

    const heading = screen.getByRole('heading', { name: 'teams.empty.title' });

    expect(heading.tagName).toBe('H2');
    expect(heading).not.toHaveAttribute('id');
  });
});

describe.each(['en', 'ru'] as const)('NotFoundState in %s', (language) => {
  it('is translated, and says something other than its key', () => {
    render(
      <I18nextProvider i18n={SharedI18n.createI18n(language)}>
        <Themed scheme="light">
          <SharedUi.NotFoundState />
        </Themed>
      </I18nextProvider>,
    );

    const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    const body = screen.getByTestId('not-found-state').textContent ?? '';

    expect(heading).not.toMatch(/^errors\./);
    expect(heading.length).toBeGreaterThan(3);
    expect(body).not.toMatch(/errors\.not_found\./);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s scheme', (scheme) => {
  it('has no violation', async () => {
    const { container } = render(
      <Themed scheme={scheme}>
        <SharedUi.NotFoundState action={<button type="button">errors.not_found.action</button>} />
      </Themed>,
    );

    expect(await axeViolationsIn(container, { control: 'empty-heading' })).toEqual([]);
  });
});

import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it, vi } from 'vitest';

import { SharedI18n, SharedUi } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * The screen of a page that did not load — a route's error boundary. It replaces the route's
 * content, heading included, so it is the page: its heading is the page's `h1`, the target the
 * route announcer moves focus to (`rules/a11y.mdc` §20–21). The counterpart of `NotFoundState` and
 * `ForbiddenState`, under the same contract.
 */

const Themed = ({
  children,
  scheme = 'light',
}: {
  readonly children: ReactNode;
  readonly scheme?: 'light' | 'dark';
}) => (
  <MantineProvider env="test" forceColorScheme={scheme}>
    {children}
  </MantineProvider>
);

const MESSAGE = 'errors.route.failed';

describe('PageErrorState', () => {
  it('is the page heading, and can take focus after the navigation', () => {
    render(
      <Themed>
        <SharedUi.PageErrorState messageKey={MESSAGE} />
      </Themed>,
    );

    const heading = screen.getByRole('heading', { level: 1, name: 'errors.route.title' });

    expect(heading).toHaveAttribute('id', SharedUi.PAGE_TITLE_ID);
    expect(heading).toHaveAttribute('tabindex', '-1');
    expect(screen.getAllByRole('heading', { level: 1 })).toEqual([heading]);

    heading.focus();
    expect(heading).toHaveFocus();
  });

  it('states the failure in an alert and offers the retry its caller supplied', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn(() => Promise.resolve());

    render(
      <Themed>
        <SharedUi.PageErrorState messageKey={MESSAGE} onRetry={onRetry} />
      </Themed>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent(MESSAGE);

    await user.click(screen.getByRole('button', { name: 'common.retry' }));

    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe.each(['en', 'ru'] as const)('PageErrorState in %s', (language) => {
  it('is translated, and says something other than its key', () => {
    render(
      <I18nextProvider i18n={SharedI18n.createI18n(language)}>
        <Themed>
          <SharedUi.PageErrorState messageKey={MESSAGE} />
        </Themed>
      </I18nextProvider>,
    );

    const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';

    expect(heading).not.toMatch(/^errors\./);
    expect(heading.length).toBeGreaterThan(3);
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s scheme', (scheme) => {
  it('has no violation', async () => {
    const { container } = render(
      <Themed scheme={scheme}>
        <SharedUi.PageErrorState messageKey={MESSAGE} onRetry={() => Promise.resolve()} />
      </Themed>,
    );

    expect(await axeViolationsIn(container, { control: 'empty-heading' })).toEqual([]);
  });
});

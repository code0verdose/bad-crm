import { MantineProvider } from '@mantine/core';
import { render, screen } from '@testing-library/react';
import { type ReactNode } from 'react';
import { I18nextProvider } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import { SharedI18n, SharedUi } from '@shared';

import { axeViolationsIn } from '../support/axe-scan.util.js';

/**
 * The screen a person meets when the product knows who they are, knows the section exists, and
 * still will not open it (`ux-architecture.md` → «403 vs 404»).
 *
 * What separates it from the not-found screen is the whole point of having two: this one **names
 * what is missing**. `/admin/**` is in the list of sections, its existence is not a secret inside
 * the organization, and «nothing here» in front of a section a colleague can open reads as a bug
 * rather than as a policy — the person retries, then writes to support. The permission key is the
 * one thing that turns the refusal into a sentence an administrator can act on.
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

describe('ForbiddenState', () => {
  it('names the permission that is missing, verbatim', () => {
    render(
      <Themed scheme="light">
        <SharedUi.ForbiddenState permission="role:read" />
      </Themed>,
    );

    // Verbatim, and outside the translated sentence: `role:read` is an identifier from the closed
    // catalogue — the string an administrator will search for and grant. Translating it, or
    // paraphrasing it into «roles», would leave the reader with nothing to quote.
    expect(screen.getByTestId('forbidden-state')).toHaveTextContent('role:read');
  });

  /**
   * The heading is the page's `h1`, and it carries the id the route announcer moves focus to
   * (`rules/a11y.mdc` §21). Nothing else on the screen is focusable when the caller offers no way
   * out, so without this a keyboard user arrives at a refusal with focus still on the navigation
   * link they left — and a screen reader says nothing at all.
   */
  it('is the page heading, and can take focus after the navigation', () => {
    render(
      <Themed scheme="light">
        <SharedUi.ForbiddenState permission="team:read" />
      </Themed>,
    );

    const heading = screen.getByRole('heading', { level: 1 });

    expect(heading).toHaveAttribute('id', SharedUi.PAGE_TITLE_ID);
    expect(heading).toHaveAttribute('tabindex', '-1');

    heading.focus();
    expect(heading).toHaveFocus();
  });

  it('renders the way out its caller supplied', () => {
    render(
      <Themed scheme="light">
        <SharedUi.ForbiddenState
          action={<button type="button">errors.forbidden.action</button>}
          permission="user:read"
        />
      </Themed>,
    );

    expect(screen.getByRole('button', { name: 'errors.forbidden.action' })).toBeInTheDocument();
  });

  /**
   * «Запросить доступ» is in the rule and deliberately **not** here: the product has no request
   * mechanism, and a button that opens nothing is worse than its absence — it promises a path that
   * does not exist and sends the person waiting for an answer nobody will send. The rule now says
   * so; this asserts the component keeps its word.
   */
  it('offers nothing of its own — no request-access button invented here', () => {
    render(
      <Themed scheme="light">
        <SharedUi.ForbiddenState permission="user:read" />
      </Themed>,
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

/**
 * Both languages, with the real catalogues rather than `cimode`.
 *
 * The rest of the suite renders keys on purpose, which means the rest of the suite cannot tell a
 * translated screen from an untranslated one: `errors.forbidden.title` is what a missing key
 * renders as too (`i18n.config.ts` → «A missing key renders as the key»). Here the sentences are
 * read as a user reads them, and asserted to be sentences.
 */
describe.each(['en', 'ru'] as const)('ForbiddenState in %s', (language) => {
  it('is translated, and says something other than its key', () => {
    const i18n = SharedI18n.createI18n(language);

    render(
      <I18nextProvider i18n={i18n}>
        <Themed scheme="light">
          <SharedUi.ForbiddenState permission="role:read" />
        </Themed>
      </I18nextProvider>,
    );

    const heading = screen.getByRole('heading', { level: 1 }).textContent ?? '';
    const body = screen.getByTestId('forbidden-state').textContent ?? '';

    expect(heading).not.toMatch(/^errors\./);
    expect(heading.length).toBeGreaterThan(3);
    expect(body).not.toMatch(/errors\.forbidden\./);
    // The identifier survives translation: it is data, not copy.
    expect(body).toContain('role:read');
  });
});

/**
 * The two catalogues are not each other's copy.
 *
 * Parity — `test/i18n/catalogue-parity.test.ts` — proves both files hold the key; it cannot prove
 * the Russian value is Russian. A key pasted across with the English text passes every gate in the
 * repository and is exactly the R-17 failure of `docs/product/prd.md`: «двуязычность деградирует
 * до английский + недоперевод».
 */
describe('ForbiddenState across the two languages', () => {
  it('says it differently in each', () => {
    const rendered = (tag: 'en' | 'ru'): string => {
      const { unmount } = render(
        <I18nextProvider i18n={SharedI18n.createI18n(tag)}>
          <Themed scheme="light">
            <SharedUi.ForbiddenState permission="role:read" />
          </Themed>
        </I18nextProvider>,
      );
      const text = screen.getByTestId('forbidden-state').textContent ?? '';

      unmount();

      return text;
    };

    expect(rendered('en')).not.toEqual(rendered('ru'));
  });
});

describe.each(['light', 'dark'] as const)('accessibility in the %s scheme', (scheme) => {
  it('has no violation', async () => {
    const { container } = render(
      <Themed scheme={scheme}>
        <SharedUi.ForbiddenState
          action={<button type="button">errors.forbidden.action</button>}
          permission="role:read"
        />
      </Themed>,
    );

    // The control rule is one this markup certainly exercises: a heading is present, so the
    // «headings have discernible text» rule has something to pass on.
    expect(await axeViolationsIn(container, { control: 'empty-heading' })).toEqual([]);
  });
});

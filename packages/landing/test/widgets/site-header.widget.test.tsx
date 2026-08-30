import { readFileSync } from 'node:fs';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { EN_COPY } from '@/app/i18n/dictionary-en.constant.js';
import { LocaleProvider } from '@/app/i18n/locale.provider.js';
import { SECTION_IDS } from '@/shared/lib/site-links.constant.js';
import { SiteHeader } from '@/widgets/site-header.widget.js';

/**
 * The header's navigation is the page's table of contents, and below 62em it used to be gone: one
 * `display: none` in the stylesheet, with nothing rendered in its place — no menu button, no
 * drawer, no second list. Four of the thirteen sections were then reachable only by scrolling
 * through the ones in front of them.
 *
 * **What this suite can prove:** that the four links exist in the markup unconditionally (no state,
 * no width test in JavaScript), that they carry the right addresses, and that the keyboard reaches
 * them in reading order.
 *
 * **What it cannot prove:** that they are *visible* on a phone. jsdom applies no stylesheet and
 * lays nothing out, so `display`, `overflow` and every media query are invisible to it. The one
 * approximation available is the last case here, which reads the stylesheet as text and asserts the
 * rule that removed the navigation is not back — it says nothing about whether the row that
 * replaced it is usable. That is a browser's judgement, and it stays a browser's judgement.
 */
const renderHeader = () =>
  render(
    <LocaleProvider>
      <SiteHeader />
    </LocaleProvider>,
  );

const navigation = (): HTMLElement => screen.getByRole('navigation', { name: 'Bad CRM' });

describe('the header navigation', () => {
  it('renders all four section links, unconditionally', () => {
    renderHeader();

    const links = within(navigation()).getAllByRole('link');

    expect(links.map((link) => link.textContent)).toEqual([
      EN_COPY.nav.workspace,
      EN_COPY.nav.domains,
      EN_COPY.nav.security,
      EN_COPY.nav.selfHost,
    ]);
  });

  it('addresses each section absolutely, so the link also works from a legal page', () => {
    renderHeader();

    const nav = within(navigation());

    expect(nav.getByRole('link', { name: EN_COPY.nav.workspace })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.workspace}`,
    );
    expect(nav.getByRole('link', { name: EN_COPY.nav.domains })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.domains}`,
    );
    expect(nav.getByRole('link', { name: EN_COPY.nav.security })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.security}`,
    );
    expect(nav.getByRole('link', { name: EN_COPY.nav.selfHost })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.selfHost}`,
    );
  });

  it('reaches every section link with the keyboard, in reading order', async () => {
    renderHeader();

    const links = within(navigation()).getAllByRole('link');

    const visited: Element[] = [];
    for (let step = 0; step < 12; step += 1) {
      await userEvent.tab();
      if (document.activeElement) visited.push(document.activeElement);
    }

    const positions = links.map((link) => visited.indexOf(link));

    expect(positions.filter((position) => position === -1)).toEqual([]);
    expect(positions).toEqual([...positions].sort((first, second) => first - second));
  });
});

/**
 * A source-text assertion, and it is worth being explicit about why: this suite runs in jsdom,
 * which never computes a style, so the only trace of the defect available to it is the declaration
 * itself. It catches the exact regression that happened — the navigation removed from the flow and
 * from the tab order at narrow widths — and nothing more.
 */
describe('the stylesheet of the header', () => {
  /* Read from the working directory, which Vitest sets to the package root: `import.meta.url` is
     not a file URL under the jsdom environment, and `?raw` on a `*.module.css` returns the class
     map rather than the source. */
  const css = readFileSync(`${process.cwd()}/src/widgets/site-header.module.css`, 'utf8');

  it('never hides the navigation, at any width', () => {
    const navRules = css.match(/\.nav\b[^{}]*\{[^}]*\}/g) ?? [];

    expect(navRules).not.toEqual([]);
    expect(navRules.filter((rule) => /display\s*:\s*none/.test(rule))).toEqual([]);
  });
});

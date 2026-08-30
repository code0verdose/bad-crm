import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { EN_COPY } from '@/app/i18n/dictionary-en.constant.js';
import { RU_COPY } from '@/app/i18n/dictionary-ru.constant.js';
import { LocaleProvider } from '@/app/i18n/locale.provider.js';
import { readConsent, writeConsent } from '@/shared/lib/consent.util.js';
import { FOOTER_COLUMN_TARGETS } from '@/shared/lib/footer-links.util.js';
import {
  CONTRIBUTING_URL,
  GITHUB_URL,
  LICENCE_URL,
  SECTION_IDS,
  SECURITY_POLICY_URL,
} from '@/shared/lib/site-links.constant.js';
import { ROUTES } from '@/shared/lib/use-route.hook.js';
import { SiteFooter } from '@/widgets/site-footer.widget.js';

/**
 * The footer is the site's second navigation, and the one a reader meets at the end of the page.
 * Every link in it has to go where its own words say it goes — which is what this suite is about,
 * and what the footer did not do: all eight links of both columns carried `GITHUB_URL`, so
 * `Workspace`, `Domains`, `Security` and `Self-host` — four sections of the page the reader was
 * standing on — announced themselves and then left the site.
 */
const renderFooter = () =>
  render(
    <LocaleProvider>
      <SiteFooter />
    </LocaleProvider>,
  );

const columnNamed = (title: string): HTMLElement => screen.getByRole('navigation', { name: title });

describe('the footer sends every link where its label says', () => {
  it('points the product column at the sections of this page, not at the repository', () => {
    renderFooter();

    const product = within(columnNamed(EN_COPY.footer.columns[0]!.title));
    const labels = EN_COPY.footer.columns[0]!.links;
    const [workspace, domains, security, selfHost] = [
      labels[0]!,
      labels[1]!,
      labels[2]!,
      labels[3]!,
    ];

    // Absolute, not a bare `#id`: the same link is rendered on `/terms`, where a fragment of the
    // current document points at nothing. `SectionLink` documents that reasoning.
    expect(product.getByRole('link', { name: workspace })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.workspace}`,
    );
    expect(product.getByRole('link', { name: domains })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.domains}`,
    );
    expect(product.getByRole('link', { name: security })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.security}`,
    );
    expect(product.getByRole('link', { name: selfHost })).toHaveAttribute(
      'href',
      `/#${SECTION_IDS.selfHost}`,
    );
  });

  it('points the project column at the four documents it names', () => {
    renderFooter();

    const project = within(columnNamed(EN_COPY.footer.columns[1]!.title));
    const labels = EN_COPY.footer.columns[1]!.links;
    const [github, licence, securityPolicy, contributing] = [
      labels[0]!,
      labels[1]!,
      labels[2]!,
      labels[3]!,
    ];

    expect(project.getByRole('link', { name: github })).toHaveAttribute('href', GITHUB_URL);
    expect(project.getByRole('link', { name: licence })).toHaveAttribute('href', LICENCE_URL);
    expect(project.getByRole('link', { name: securityPolicy })).toHaveAttribute(
      'href',
      SECURITY_POLICY_URL,
    );
    expect(project.getByRole('link', { name: contributing })).toHaveAttribute(
      'href',
      CONTRIBUTING_URL,
    );
  });

  it('leaves exactly one link in the whole footer pointing at the repository root', () => {
    const { container } = renderFooter();

    const toGitHubRoot = [...container.querySelectorAll('a')].filter(
      (link) => link.getAttribute('href') === GITHUB_URL,
    );

    // The defect this suite was written for was eight of these.
    expect(toGitHubRoot).toHaveLength(1);
  });

  it('reaches every product link with the keyboard alone, in the order they are read', async () => {
    renderFooter();

    const product = within(columnNamed(EN_COPY.footer.columns[0]!.title));
    const links = EN_COPY.footer.columns[0]!.links.map((label) =>
      product.getByRole('link', { name: label }),
    );

    // Walk the whole footer rather than counting the elements in front of the column: what is
    // asserted is that the four are reachable and keep their reading order, not where they sit in
    // the tab sequence of a footer that will grow more links.
    const visited: Element[] = [];
    for (let step = 0; step < 16; step += 1) {
      await userEvent.tab();
      if (document.activeElement) visited.push(document.activeElement);
    }

    const positions = links.map((link) => visited.indexOf(link));

    expect(positions.filter((position) => position === -1)).toEqual([]);
    expect(positions).toEqual([...positions].sort((first, second) => first - second));
  });
});

/**
 * Labels live in the two dictionaries, targets live in `footer-links.util.ts`, and they are paired
 * by position — the one thing here that can drift without an error anywhere. A link added to the
 * English column and not to the table would otherwise simply stop being a link.
 */
describe('the labels and the targets stay in step', () => {
  it.each([
    ['en', EN_COPY],
    ['ru', RU_COPY],
  ])('has one target per label in every column of %s', (_locale, copy) => {
    expect(copy.footer.columns.map((column) => column.links.length)).toEqual(
      FOOTER_COLUMN_TARGETS.map((targets) => targets.length),
    );
  });
});

/**
 * The two handlers of the legal column, which nothing had ever run.
 *
 * Both are the same shape as the back link of a legal page: a real element, and an `onClick` that
 * does the work. The consent one is the reason this matters beyond coverage — withdrawing consent
 * has to be as easy as giving it, and the only thing standing between a reader and the banner
 * coming back is these two lines.
 */
describe('the legal column does what its two buttons say', () => {
  it('navigates in place rather than reloading the site', async () => {
    const user = userEvent.setup();

    globalThis.history.replaceState(null, '', ROUTES.home);
    renderFooter();

    await user.click(screen.getByRole('link', { name: EN_COPY.footer.legalLinks.privacy }));

    expect(globalThis.location.pathname).toBe(ROUTES.privacy);

    globalThis.history.replaceState(null, '', ROUTES.home);
  });

  it('clears the stored consent and reloads, so the banner comes back', async () => {
    const user = userEvent.setup();
    const reload = vi.fn();

    // `location.reload` is not implemented in jsdom, and the assertion is that it is called at all:
    // clearing the answer without a reload leaves the reader on a page that still behaves as if
    // they had answered.
    vi.spyOn(globalThis, 'location', 'get').mockReturnValue({
      ...globalThis.location,
      reload,
    } as unknown as Location);

    writeConsent('all');
    renderFooter();

    await user.click(screen.getByRole('button', { name: EN_COPY.footer.legalLinks.manageCookies }));

    expect(readConsent()).toBeNull();
    expect(reload).toHaveBeenCalledOnce();

    vi.restoreAllMocks();
  });
});

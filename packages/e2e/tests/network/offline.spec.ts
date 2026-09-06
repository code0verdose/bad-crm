import { expect, test } from '../../fixtures/session.fixture.js';
import { type Page } from '@playwright/test';

/**
 * The installation asks the outside world for nothing (NFR-9).
 *
 * This is a promise about the product, not hygiene in the pipeline. Bad CRM is delivered as
 * `docker compose up` inside somebody else's perimeter, and a screen that quietly pulls a web font,
 * an icon sprite or a telemetry beacon is green on every machine that has internet and broken on
 * the one that does not. Nobody finds out from a test: the page renders, the fallback font is close
 * enough, the beacon fails silently — and the first report comes from a customer whose network
 * refuses the request.
 *
 * So the run is sandboxed twice, at two different depths, and only the pair is worth having:
 *
 * 1. **Every scenario of the suite** runs behind a proxy that does not exist, with the
 *    installation's own addresses bypassed (`playwright.config.ts` → `sandbox`). That is the
 *    perimeter: anything reaching past the installation fails, wherever in the suite it happens.
 * 2. **This file** watches what is asked for at all, and fails naming the URL. The perimeter alone
 *    would let a request that fails harmlessly — a font with a fallback — pass unnoticed, which is
 *    exactly the defect the customer would notice and we would not.
 *
 * The scenario that matters most is the last one. A check that «saw no external requests» looks
 * identical whether it is working or broken, and a broken one is the more likely of the two: a
 * predicate with an inverted condition, a route handler that never got installed, a page that never
 * loaded. So the control drives a request outward on purpose and requires the watcher to catch it
 * and the sandbox to refuse it.
 */

/** The installation: where the browser is served from, and where its API lives. */
const installation = (): string[] => [
  new URL(process.env['E2E_BASE_URL'] ?? 'http://localhost:5173').origin,
  new URL(process.env['E2E_API_URL'] ?? 'http://localhost:3000').origin,
];

/**
 * Starts watching, and returns the list of URLs that left the installation.
 *
 * Requests to anywhere but the installation are **aborted** rather than let through: a failure
 * should read as «the product asked for x», not as a thirty-second wait for a proxy that answers
 * nothing. Non-network schemes (`data:`, `blob:`) never leave the browser and are not asked about.
 */
const watchForOutboundRequests = async (page: Page): Promise<string[]> => {
  const outbound: string[] = [];
  const allowed = installation();

  await page.route('**/*', async (route) => {
    const url = route.request().url();
    const external =
      /^https?:/.test(url) && !allowed.some((origin) => url.startsWith(`${origin}/`));

    if (!external) {
      await route.continue();

      return;
    }

    outbound.push(url);
    await route.abort('blockedbyclient');
  });

  return outbound;
};

const nothingLeft = (outbound: readonly string[], screen: string): void => {
  expect(
    outbound,
    [
      `${screen} reached outside the installation.`,
      'A self-hosted installation runs with no way out (NFR-9), so whatever this is has to be',
      'vendored into the bundle or dropped. See docs/runbooks/e2e.md → «Сетевая песочница».',
    ].join(' '),
  ).toEqual([]);
};

test.describe('the installation runs with no way out', () => {
  test('the sign-in screen asks for nothing beyond the installation', async ({ page }) => {
    const outbound = await watchForOutboundRequests(page);

    await page.goto('/login');
    await expect(page.getByRole('main')).toBeVisible();

    nothingLeft(outbound, 'The sign-in screen');
  });

  test('the shell of a signed-in owner asks for nothing beyond it either', async ({
    ownerPage,
  }) => {
    const outbound = await watchForOutboundRequests(ownerPage);

    await ownerPage.goto('/dashboard');
    await expect(ownerPage.getByRole('main')).toBeVisible();

    nothingLeft(outbound, 'The shell');
  });

  /**
   * CONTROL of the watcher, and the only reason the two cases above mean anything.
   *
   * Both of them are satisfied by a watcher that watches nothing — an inverted predicate, a route
   * handler that never got installed, a page that never loaded. Here the page is asked to fetch a
   * host that is not the installation, and the watcher has to have noticed.
   */
  test('CONTROL: a request aimed outside the installation is seen', async ({ page }) => {
    const probe = 'https://cdn.bad-crm-sandbox-control.example/probe.css';
    const outbound = await watchForOutboundRequests(page);

    await page.goto('/login');
    await expect(page.getByRole('main')).toBeVisible();

    await page.evaluate(async (url) => {
      await fetch(url, { mode: 'no-cors' }).catch(() => undefined);
    }, probe);

    expect(outbound).toContain(probe);
  });

  /**
   * CONTROL of the perimeter, and deliberately without the watcher above.
   *
   * The watcher aborts what it sees, so with it installed this case would be proving its own route
   * handler. Here nothing intercepts: the browser is sent to a host outside the installation and
   * the navigation has to fail **because of the sandbox** — Chromium says so by name, `ERR_PROXY_*`.
   *
   * Asserting merely that the host was unreachable would be worthless, and that is measured rather
   * than assumed: on the machine this was written on the browser has no outbound route of its own,
   * so an external navigation fails with `ERR_SOCKET_NOT_CONNECTED` whether the sandbox is
   * configured or not. A control that passes with the mechanism deleted is not a control. Naming
   * the proxy in the expected error is what separates «the sandbox refused this» from «this machine
   * happens to be offline today» — delete `proxy` from `playwright.config.ts` and this goes red.
   */
  test('CONTROL: it is the sandbox that refuses the outside, not luck', async ({ page }) => {
    const refusal = await page
      .goto('https://example.com/')
      .then(() => 'the navigation succeeded')
      .catch((error: Error) => error.message);

    expect(refusal).toContain('ERR_PROXY');
  });
});

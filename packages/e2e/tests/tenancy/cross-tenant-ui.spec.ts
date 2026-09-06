import { expect, test } from '../../fixtures/session.fixture.js';
import { SEED_ORGANIZATION_A, SEED_ORGANIZATION_B } from '../../fixtures/seed-data.js';
import { ownerApiSession, type ApiSession } from '../../fixtures/test-account.js';
import { audit } from '../support/audit.util.js';

/**
 * The other half of the isolation promise: what a person actually sees on the screen.
 *
 * `cross-tenant-api.spec.ts` proves the API refuses, and the integration suite proves the policies
 * underneath it (`packages/server/test/integration/db/rls-isolation.test.ts`). Neither can prove
 * what this file asks: that the *interface* built on top of them never renders a stranger. A screen
 * can leak what an endpoint refuses — a list that filters after fetching, a cached row that
 * survives a switch, a detail page that draws a header from a URL parameter before its query comes
 * back — and every one of those failures is invisible to a test that only speaks HTTP.
 *
 * It could not be written until EPIC-012: there was no tenant-scoped screen to point it at. There
 * are four now, and the directory is the one that lists people by address, which makes «somebody
 * else's tenant» a thing an assertion can name.
 *
 * **Two properties, and the second decides whether the first means anything.** That a foreign
 * address is absent from a screen is satisfied by an empty screen, a screen that failed to load,
 * and a screen that never rendered at all — so every case here carries the positive control beside
 * it, on the same screen, in the same run.
 */

const foreignId = async (owner: ApiSession, email: string): Promise<string> => {
  const query = new URLSearchParams({ q: email, perPage: '10' });
  const response = await owner.context.get(`/api/v1/employees?${query.toString()}`, {
    headers: owner.headers,
  });

  expect(response.ok(), await response.text()).toBe(true);

  const { items } = (await response.json()) as {
    items: readonly { userId: string; email: string }[];
  };
  const row = items.find((item) => item.email === email);

  if (row === undefined) {
    throw new Error(`${email} is not in the directory — run \`pnpm db:seed\` against this stack`);
  }

  return row.userId;
};

/**
 * The two identifiers this file needs, read once per worker rather than per scenario.
 *
 * A signed-in owner is the only way to learn another owner's `userId` — the identifier is not
 * public, which is the point — so each lookup costs an API sign-in. `auth_attempt` is reset by a
 * successful sign-in (`LoginUseCase`), so these are free of the budget the failing-password
 * scenarios spend; what they are not free of is time, and a lookup per scenario would repeat it.
 */
const ownerIds = async (): Promise<{ mine: string; theirs: string }> => {
  const [a, b] = await Promise.all([
    ownerApiSession(SEED_ORGANIZATION_A),
    ownerApiSession(SEED_ORGANIZATION_B),
  ]);

  try {
    const [mine, theirs] = await Promise.all([
      foreignId(a, SEED_ORGANIZATION_A.owner.email),
      foreignId(b, SEED_ORGANIZATION_B.owner.email),
    ]);

    return { mine, theirs };
  } finally {
    await Promise.all([a.context.dispose(), b.context.dispose()]);
  }
};

test.describe('the interface of one organization never shows another', () => {
  test('the directory lists this organization and not the other, however it is searched', async ({
    ownerPage,
  }) => {
    await ownerPage.goto('/admin/members');

    const rows = ownerPage.getByRole('table');
    const search = ownerPage.getByRole('searchbox', { name: 'Search' });

    await expect(rows).toBeVisible();
    await expect(ownerPage.getByRole('main')).not.toContainText(SEED_ORGANIZATION_B.owner.email);

    await audit(ownerPage);

    /*
      Then the same question asked the way somebody looking for a person asks it, and this is the
      case worth having rather than a repetition of the line above: `q` is the only field of this
      screen that reaches the database as a search rather than as an equality, so a query assembled
      without the tenant predicate would answer here and nowhere else.

      The search is also the only way to state the property at all on a shared installation. The
      unfiltered first page is whatever sorts first, and on a stack that has been run against for a
      while that is a screenful of colleagues earlier runs invented — measured here on 2026-09-06,
      where `owner@org-a.local` was not on page one of the directory of `seed-org-a`. An assertion
      built on «the owner is on the first screen» would therefore pass on a fresh installation and
      fail on a used one, for a reason that has nothing to do with tenancy.
    */

    // CONTROL first, and deliberately so: what follows is an assertion of absence, and absence is
    // also what a broken search, an empty directory and a screen that never loaded all show.
    await search.fill(SEED_ORGANIZATION_A.owner.email);
    await expect(rows).toContainText(SEED_ORGANIZATION_A.owner.email);

    // The same field, the same debounce, the address of somebody who exists — in the other tenant.
    await search.fill(SEED_ORGANIZATION_B.owner.email);
    await expect(rows).toHaveCount(0);
    await expect(ownerPage.getByRole('main')).not.toContainText(SEED_ORGANIZATION_B.owner.email);

    // Audited again, because «nobody matches» is a different render rather than the same screen
    // with fewer rows: the table is gone and an empty state stands in its place, and it is reached
    // from here more often than from anywhere else — a search for somebody who is not a colleague
    // is the ordinary way to arrive at it.
    await audit(ownerPage);
  });

  test('a link straight to a person of the other organization opens no record', async ({
    ownerPage,
  }) => {
    const { mine, theirs } = await ownerIds();

    await ownerPage.goto(`/admin/members/${theirs}`);

    /*
      What the screen owes here is «there is nothing at this address», and what it must not do is
      draw the record. Both halves are asserted: the failure state is on the screen, and the form
      that would hold the person's details is not — a card rendered from the URL parameter while the
      query is still out would satisfy the first half on its own.

      The state is `DataState`'s error rather than a dedicated not-found screen. The API answers
      404 and the client renders one failure state for every way a query can fail; that is the
      product's decision (`shared/ui/data-state`), and asserting the alert asserts what the screen
      does rather than what a different design would have done.

      **The address is not asserted here, and that is a fact about the screen rather than a
      weakening of the test.** The personnel record renders names, job title, department and hours —
      never the e-mail (measured 2026-09-06: the whole text of `main` on one's own record contains
      no address at all). So «the foreign address is absent» would be trivially true of every record
      including one's own, and the honest form of the property is «no record was drawn».
    */
    const saveButton = ownerPage.getByRole('button', { name: 'Save' });

    await expect(ownerPage.getByRole('alert')).toBeVisible();
    await expect(saveButton).toBeHidden();

    /*
      Audited, and this line was switched off between 2026-09-06 and the palette repair of the same
      week. It is the audit that found the defect: `color-contrast`, 4.02:1 where AA asks 4.5, on
      `#c84242` over `#ffe3e3` — the «Try again» button of this alert, at 12px. That is
      `danger-outline` on `danger-light`, and `-outline` resolved to the primary shade, which is
      chosen to carry white on a filled button rather than to be read on a tint. `-outline` and
      `-text` are now remapped for every scale in `app/theme/app-theme.config.ts` and measured for
      every scale in `packages/client/test/theme/tokens.test.ts`, so the pair is held at 6.26:1 by a
      unit test — and this line is what proves the unit test is talking about the rendered screen.
    */
    await audit(ownerPage);

    // CONTROL: the identical navigation, one's own organization, and the record opens. Without it
    // this passes against a route that is simply broken for everybody.
    await ownerPage.goto(`/admin/members/${mine}`);

    await expect(saveButton).toBeVisible();
    await expect(ownerPage.getByRole('alert')).toHaveCount(0);
  });
});

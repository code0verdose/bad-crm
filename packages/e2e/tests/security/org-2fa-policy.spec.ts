import { expect, type Page } from '@playwright/test';

import { withOwnerSession } from '../../fixtures/fresh-session.util.js';
import { roleAccountEmail } from '../../fixtures/role-account.js';
import { SEED_ORGANIZATION_A } from '../../fixtures/seed-data.js';
import { type ApiSession } from '../../fixtures/test-account.js';
import { test } from '../../fixtures/session.fixture.js';
import { audit } from '../support/audit.util.js';

/**
 * The organization's second-factor policy, end to end — STORY-013-05, acceptances 2, 4, 8 and 9.
 *
 * What only a running stack can answer, and the reason this file exists beside
 * `packages/client/test/widgets/security-policy.test.tsx`, which already puts every control through
 * its states against a stubbed server:
 *
 *   * **the confirmation and the door agree.** The component test proves the screen *asks* the draft
 *     endpoint; it cannot prove the answer is the one the enforcement will give, because the answer
 *     is a fixture. Here the numbers come from the real `evaluateMfaRequirement` over the real rows,
 *     and the same run reads the standing report back and finds the same people in it;
 *   * **the countdown reaches the next page load.** `mfaGraceEndsAt` is minted where the session is
 *     issued, so a banner after a fresh sign-in is the whole chain — policy, role grant, token claim,
 *     screen — rather than a field a fixture put on a response;
 *   * **the filter is the address**, met the way a colleague meets it: as a link, before the page has
 *     settled into anything.
 *
 * **Acceptance 7 is not exercised here, and the reason is a fact about the installation rather than
 * about the screen.** The self-lockout refusal fires when the caller holds a role the draft names,
 * and the seeded owner holds **no role at all** — ownership lives in `organizations.owner_id`, not in
 * a `UserRole` row, so `GET /organization/mfa-coverage?role=owner` answers `covered: 0` against a
 * real installation. The 428 and its repeat are covered by
 * `packages/server/test/integration/http/security-policy.test.ts` and by the component suite; what
 * the observation is worth is recorded in the story, because it also means a policy naming `owner`
 * protects nobody.
 *
 * **This file writes to the organization every other scenario signs into, so four things guard it.**
 *
 * It runs **serially** — `fullyParallel` is on in `playwright.config.ts`, and without this the two
 * describes below would race each other over one policy: one's `beforeEach` switching it off while
 * the other asserts a banner that needs it on. That failure would be a false red on unrelated work,
 * which is how a suite stops being believed.
 *
 * It **restores what it found**, not what it assumes: the policy is read once in `beforeAll` and
 * written back in `afterAll`. Imposing «off» would silently disable somebody's mandatory 2FA on a
 * shared stack — the harness is a guest in that installation, not its owner.
 *
 * And the grace period it sets is **days rather than zero**: a covered account with no second factor
 * and no grace is scoped to enrolment on its next sign-in, and the accounts covered here are the ones
 * other scenarios run as.
 *
 * The fourth is `withOwnerSession` (`fresh-session.util.ts`) rather than a raw owner login: measured
 * 2026-09-27, running this file alongside `tests/projects/**` — which creates and changes several
 * projects as the same seeded owner — regularly answered this file's own first owner call
 * `401 unauthenticated`, the owner's session having gone stale between login and use by a sibling
 * file's concurrent project write. `withOwnerSession`'s retry is exactly the fix `tests/projects/**`
 * already applies to itself for the identical race.
 */

// One worker for this file: two describes sharing one organization's policy cannot run side by side.
test.describe.configure({ mode: 'serial' });

interface StoredPolicy {
  readonly mfaRequiredForRoles: readonly string[];
  readonly mfaGracePeriodDays: number;
}

/** The disabled policy, exactly as a fresh installation has it (acceptance 10). */
const DISABLED: StoredPolicy = { mfaRequiredForRoles: [], mfaGracePeriodDays: 0 };

/** What the installation had before this file touched it — read once, written back at the end. */
let found: StoredPolicy = DISABLED;

const writePolicy = async (session: ApiSession, policy: StoredPolicy): Promise<void> => {
  const response = await session.context.patch('/api/v1/organization/security-policy', {
    headers: { ...session.headers, 'Idempotency-Key': crypto.randomUUID() },
    data: policy,
  });

  expect(response.ok(), await response.text()).toBe(true);
};

/**
 * A fresh owner session per call, retried across the cross-worker race the file doc explains —
 * `withOwnerSession` (`fresh-session.util.ts`), named `asOwner` here for how every call site below
 * already reads.
 */
const asOwner = (body: (session: ApiSession) => Promise<void>): Promise<void> =>
  withOwnerSession(SEED_ORGANIZATION_A, body);

/** Between cases: the known state each of them starts from. */
const disablePolicy = async (): Promise<void> => {
  await asOwner(async (session) => {
    await writePolicy(session, DISABLED);
  });
};

test.beforeAll(async () => {
  await asOwner(async (session) => {
    const response = await session.context.get('/api/v1/organization/security-policy', {
      headers: session.headers,
    });

    expect(response.ok(), await response.text()).toBe(true);

    const policy = (await response.json()) as StoredPolicy;

    found = {
      mfaRequiredForRoles: policy.mfaRequiredForRoles,
      mfaGracePeriodDays: policy.mfaGracePeriodDays,
    };
  });
});

test.afterAll(async () => {
  await asOwner(async (session) => {
    await writePolicy(session, found);
  });
});

/** Opens the tab and waits for the report, which is the last thing on the screen to arrive. */
const openSecurityTab = async (page: Page): Promise<void> => {
  await page.goto('/admin/organization?tab=security');
  await expect(page.getByRole('heading', { name: 'Two-factor policy' })).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
};

test.describe('the organization second-factor policy', () => {
  test.beforeEach(disablePolicy);
  test.afterEach(disablePolicy);

  /**
   * One pass through the whole thing, as one scenario rather than three.
   *
   * The steps depend on each other — the preview is about the draft, and the table afterwards is
   * about the policy that draft became — and splitting them would mean each case re-establishing the
   * state of the one before it, against a shared organization.
   */
  test('previews the unsaved draft by name, then applies it', async ({ ownerPage }) => {
    const covered = roleAccountEmail(SEED_ORGANIZATION_A, 'admin');

    await openSecurityTab(ownerPage);

    // Nobody is covered while the policy is off, which is what makes the preview below an answer
    // about the draft rather than about what was already on screen. Located by its words rather than
    // by `role="status"`: the shell announces route changes through a live region too.
    await expect(ownerPage.getByText(/0 of 0 covered people/)).toBeVisible();

    // 1. The draft: administrators, with days to arrange an authenticator.
    await ownerPage.getByRole('checkbox', { name: 'Administrator' }).check();
    await ownerPage.getByRole('textbox', { name: 'Grace period, days' }).fill('3');
    await ownerPage.getByRole('button', { name: 'Review who this affects' }).click();

    const dialog = ownerPage.getByRole('dialog');

    // 2. The preview, computed by the server against the unsaved draft (acceptance 2) — a count and
    //    the addresses of the people who will be asked, which is what «поимённый список» means.
    await expect(dialog.getByText(/people hold a role this policy names/)).toBeVisible();
    await expect(dialog.getByText(covered)).toBeVisible();

    // 3. Applying is a separate, deliberate act — the draft alone changed nothing.
    await dialog.getByRole('button', { name: 'Apply the policy' }).click();
    await expect(dialog).toBeHidden();

    // 4. The standing report now gives that person a verdict, from the same function the sign-in
    //    gate uses: they are inside their grace period rather than merely «not covered».
    await expect(ownerPage.getByRole('row', { name: covered })).toContainText('Setting up');
    await expect(ownerPage.getByText(/of 3 covered people/)).toBeVisible();
  });

  /**
   * The URL is the filter (acceptance 9), asserted the way a colleague would meet it: as a link.
   *
   * A filter kept in component state would open this address showing everybody — the failure
   * `rules/lists-and-filters.mdc` §1 exists to prevent, and one a component test cannot tell apart
   * from a filter applied after the page settled.
   */
  test('opens the coverage report already narrowed by the address', async ({ ownerPage }) => {
    await ownerPage.goto(
      `/admin/organization?tab=security&gate=${encodeURIComponent('["grace"]')}`,
    );

    // The policy is off, so nobody is in a grace period — and «nothing matches» is a different
    // sentence from «nobody is here», which is the whole point of saying it.
    await expect(ownerPage.getByText('Nobody matches these filters.')).toBeVisible();
    await expect(ownerPage.getByRole('table')).toBeHidden();

    // CONTROL: the same screen without the filter is full, so the emptiness above is the filter's
    // doing rather than an organization with no accounts or a report that failed to load.
    await openSecurityTab(ownerPage);
    await expect(
      ownerPage.getByRole('row', { name: SEED_ORGANIZATION_A.owner.email }),
    ).toBeVisible();
  });

  test('has no accessibility violations on the tab or in the confirmation', async ({
    ownerPage,
  }) => {
    await openSecurityTab(ownerPage);
    await audit(ownerPage);

    await ownerPage.getByRole('button', { name: 'Review who this affects' }).click();
    await expect(ownerPage.getByRole('dialog')).toBeVisible();

    // Scanned open as well: the confirmation is a different page — a dialog over an inert shell —
    // and the state nobody looks at is the state a violation ships in.
    await audit(ownerPage);
  });
});

/**
 * The banner, for somebody the policy actually covers (acceptance 4).
 *
 * The policy is written over the API rather than through the screen, and that is deliberate: this
 * scenario is about what a **covered** person's next page load looks like, and going through the
 * editor first would make it depend on the editor working — which the scenario above already proves.
 */
test.describe('the grace period of somebody the policy covers', () => {
  test.use({ role: 'admin' });

  test.beforeEach(async () => {
    await asOwner(async (session) => {
      await writePolicy(session, { mfaRequiredForRoles: ['admin'], mfaGracePeriodDays: 3 });
    });
  });

  test.afterEach(disablePolicy);

  test('is counted down on every screen, with the way out beside it', async ({ rolePage }) => {
    await rolePage.goto('/dashboard');

    await expect(
      rolePage.getByText('Two-factor authentication is required for your role'),
    ).toBeVisible();
    await expect(rolePage.getByRole('link', { name: 'Set it up now' })).toHaveAttribute(
      'href',
      '/settings/security',
    );

    // A phrase for a reader and the exact instant for everything else — the pairing that makes a
    // relative deadline safe to show at all.
    const deadline = rolePage.locator('time').first();

    await expect(deadline).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}T/);
    await expect(deadline).toContainText(/day/);

    // It follows the person rather than the screen: the same banner is on the tab they were sent to.
    await rolePage.getByRole('link', { name: 'Set it up now' }).click();
    await expect(rolePage).toHaveURL(/\/settings\/security/);
    await expect(
      rolePage.getByText('Two-factor authentication is required for your role'),
    ).toBeVisible();
  });
});

/**
 * The tab is not reachable by somebody who may not manage the policy (acceptance 8).
 *
 * Its own `describe` because `test.use` is a declaration rather than a statement: written inside a
 * test body it configures nothing and the case runs as the owner — green, and about nothing.
 */
test.describe('the security tab for somebody without the capability', () => {
  test.use({ role: 'developer' });

  test('is refused, by the name of the missing key', async ({ rolePage }) => {
    await rolePage.goto('/admin/organization?tab=security');

    await expect(rolePage.getByText('organization:manage_security_policy')).toBeVisible();
    await expect(rolePage.getByRole('heading', { name: 'Two-factor policy' })).toBeHidden();
  });
});

import { describe, expect, it } from 'vitest';

import { SEED_ORGANIZATIONS } from '../../../scripts/seed-data.constant.js';
import { seedRefusalReason } from '../../../scripts/seed.util.js';

/**
 * The guard on a command that writes accounts with a published password.
 *
 * Seed data is not «demo content»: it is two organizations whose owners sign in with a password
 * written down in this repository. On a developer machine that is the point; on an installation
 * serving a real team it is an unauthenticated back door that looks like a normal account.
 *
 * The rule is therefore inverted against the obvious one — refuse everywhere except where the
 * environment says, in as many words, that it is a developer machine or a test run. `NODE_ENV`
 * unset is refused too: it is the value of a production container started without one, and
 * «probably local» is not an argument for creating an account.
 */
describe('the seed refuses to run where it does not belong', () => {
  it.each(['development', 'test'])('runs in %s without a flag', (nodeEnv) => {
    expect(seedRefusalReason({ nodeEnv, allowProduction: false })).toBeNull();
  });

  it.each(['production', 'staging', 'preview', undefined])(
    'refuses in %s, naming the environment',
    (nodeEnv) => {
      const reason = seedRefusalReason({ nodeEnv, allowProduction: false });

      expect(reason).not.toBeNull();
      expect(reason).toContain(String(nodeEnv));
    },
  );

  /**
   * The escape hatch exists because restoring a demo installation is a real task; it is deliberately
   * an explicit environment variable rather than an interactive prompt, so that a script that runs
   * it in CI says so in its own source.
   */
  it('runs in production only when told so explicitly', () => {
    expect(seedRefusalReason({ nodeEnv: 'production', allowProduction: true })).toBeNull();
  });
});

describe('the seeded organizations are two, and disjoint', () => {
  /**
   * The whole value of the fixture for [STORY-010-05](../../../../../epics/epic-010-e2e-harness/stories/story-010-05-tenant-isolation-e2e.md):
   * an isolation scenario proves nothing if the two tenants share the value it compares.
   */
  it('shares no slug, no owner address and no name', () => {
    const slugs = SEED_ORGANIZATIONS.map((organization) => organization.slug);
    const emails = SEED_ORGANIZATIONS.map((organization) => organization.owner.email);
    const names = SEED_ORGANIZATIONS.map((organization) => organization.name);

    expect(SEED_ORGANIZATIONS).toHaveLength(2);
    expect(new Set(slugs).size).toBe(2);
    expect(new Set(emails).size).toBe(2);
    expect(new Set(names).size).toBe(2);
  });

  /**
   * `.local` is reserved for local networks (RFC 6762) and resolves nowhere. A seed address in a
   * domain somebody owns is a mail server receiving password resets for accounts it never asked
   * for — the reason `example.com` fixtures are a nuisance and `@gmail.com` fixtures are an
   * incident.
   */
  it('addresses owners in a domain that cannot receive mail', () => {
    for (const { owner } of SEED_ORGANIZATIONS) {
      expect(owner.email).toMatch(/@[a-z0-9-]+\.local$/);
    }
  });

  /** Two languages and two currencies, so a formatting defect is visible in the fixture itself. */
  it('differs in locale and currency between the two', () => {
    const [first, second] = SEED_ORGANIZATIONS;

    expect(first?.defaultCurrency).not.toBe(second?.defaultCurrency);
    expect(first?.owner.locale).not.toBe(second?.owner.locale);
  });
});

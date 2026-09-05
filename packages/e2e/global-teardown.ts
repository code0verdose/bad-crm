import { SEED_ORGANIZATIONS } from './fixtures/seed-data.js';
import {
  ownerApiSession,
  sweepTestAccounts,
  TEST_ACCOUNT_MARKER,
} from './fixtures/test-account.js';

/**
 * Takes the colleagues this run invented back out of the directory.
 *
 * Here rather than in an `afterAll` per spec, for one reason that decides it: a scenario that dies
 * partway through is exactly the scenario that has already created an account, and per-spec cleanup
 * is at its least reliable at the moment it matters most. A teardown runs after a red run as well
 * as a green one, and because it matches a marker rather than this run's identity it also collects
 * whatever earlier runs left behind — including the ones that were killed with Ctrl-C.
 *
 * Why offboarding rather than deletion, and why the seeded owners are safe from it:
 * `fixtures/test-account.ts`.
 *
 * **Never throws.** A teardown is the one place where a failure says nothing about the product, and
 * a run that passed twenty scenarios and then went red on the way out teaches the reader to ignore
 * the colour. What goes wrong is printed and the exit code stays whatever the scenarios earned.
 */
const globalTeardown = async (): Promise<void> => {
  for (const organization of SEED_ORGANIZATIONS) {
    try {
      const owner = await ownerApiSession(organization);

      try {
        const { swept, refused } = await sweepTestAccounts(owner);

        if (swept > 0 || refused > 0) {
          process.stdout.write(
            `swept ${String(swept)} ${TEST_ACCOUNT_MARKER} account(s) out of ${organization.slug}` +
              `${refused > 0 ? `, ${String(refused)} refused` : ''}\n`,
          );
        }
      } finally {
        await owner.context.dispose();
      }
    } catch (error) {
      process.stdout.write(
        `could not sweep ${organization.slug}: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
};

export default globalTeardown;

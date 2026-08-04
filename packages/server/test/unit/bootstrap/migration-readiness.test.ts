import { describe, expect, it } from 'vitest';

import { migrationReadinessProbe } from '../../../src/infrastructure/persistence/prisma/migration-readiness.adapter.js';

/**
 * A deploy where the schema did not move is the failure this probe exists for, and it is quiet: the
 * process starts, the pool answers, `/ready` says 200, and every request touching a new column
 * fails one by one. «The database is reachable» and «the database has the shape this build expects»
 * are different questions, so they get different probes and different answers.
 *
 * The expected set is passed in rather than read here: it is fixed for a build — the migration
 * folders shipped in the image — and reading a directory on every poll would put filesystem I/O on
 * the path of a health check.
 */
const clientReturning = (rows: { migration_name: string; finished_at: Date | null }[]) =>
  ({ $queryRaw: () => Promise.resolve(rows) }) as unknown as Parameters<
    typeof migrationReadinessProbe
  >[0];

const applied = (name: string) => ({ migration_name: name, finished_at: new Date() });

describe('the migration readiness probe', () => {
  it('is up when every shipped migration has been applied', async () => {
    const probe = migrationReadinessProbe(
      clientReturning([applied('001_init'), applied('002_rls')]),
      ['001_init', '002_rls'],
    );

    await expect(probe.check()).resolves.toEqual({ status: 'up' });
  });

  it('is down, and says so, when a shipped migration has not run', async () => {
    const probe = migrationReadinessProbe(clientReturning([applied('001_init')]), [
      '001_init',
      '002_rls',
    ]);

    await expect(probe.check()).resolves.toEqual({ status: 'down', detail: 'pending' });
  });

  /**
   * A row exists but `finished_at` is null: the migration started and did not complete. Prisma
   * leaves it that way after a failure, and counting it as applied would report a half-migrated
   * database as ready — the worst of the three states, because the shape is neither old nor new.
   */
  it('treats an unfinished migration as pending rather than applied', async () => {
    const probe = migrationReadinessProbe(
      clientReturning([applied('001_init'), { migration_name: '002_rls', finished_at: null }]),
      ['001_init', '002_rls'],
    );

    await expect(probe.check()).resolves.toEqual({ status: 'down', detail: 'pending' });
  });

  /**
   * The database carries a migration this build has never heard of — someone deployed a newer
   * version and rolled back. Not this probe's verdict to give: the shape is *ahead*, every
   * migration this build expects is present, and refusing traffic would turn a rollback into an
   * outage. It is worth a line in the log, which the use-case writes.
   */
  it('stays up when the database is ahead of this build', async () => {
    const probe = migrationReadinessProbe(
      clientReturning([applied('001_init'), applied('002_rls'), applied('003_from_the_future')]),
      ['001_init', '002_rls'],
    );

    await expect(probe.check()).resolves.toEqual({ status: 'up' });
  });

  it('answers under the name the body reports it by', () => {
    expect(migrationReadinessProbe(clientReturning([]), []).dependency).toBe('migrations');
  });
});

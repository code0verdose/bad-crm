import {
  type DependencyReport,
  type ReadinessProbePort,
} from '@/application/platform/ports/readiness-probe.port.js';
import { type DbRoleProbeClient } from '@/infrastructure/persistence/prisma/assert-db-role.util.js';

/** The name this dependency appears under in the `/ready` body. */
export const MIGRATIONS_DEPENDENCY = 'migrations';

interface MigrationRow {
  readonly migration_name: string;
  readonly finished_at: Date | null;
}

/**
 * Does the database have the shape this build expects?
 *
 * A deploy where the schema did not move is a quiet failure: the process starts, the pool answers,
 * `/ready` says 200, and every request touching a new column fails one at a time. «Reachable» and
 * «migrated» are different questions, which is why this is a second probe rather than a stricter
 * query inside the first one.
 *
 * **`expected` is passed in, not read here.** It is the set of migration folders shipped in the
 * image — fixed for a build — and reading a directory on every poll would put filesystem I/O on the
 * path of a health check that an orchestrator calls every couple of seconds.
 *
 * **Ahead is not behind.** A database carrying a migration this build has never heard of is a
 * rollback, not a broken deploy: every migration this build expects is present, the shape is newer,
 * and refusing traffic would turn a rollback into an outage.
 *
 * An unfinished row — `finished_at` null, which is how Prisma leaves a migration that failed — is
 * counted as pending. A half-migrated database is the worst of the three states, because the shape
 * is neither the old one nor the new one.
 */
export const migrationReadinessProbe = (
  client: DbRoleProbeClient,
  expected: readonly string[],
): ReadinessProbePort => ({
  dependency: MIGRATIONS_DEPENDENCY,
  check: async (): Promise<DependencyReport> => {
    // `$queryRaw` on the probe client is typed loosely enough that an assertion here changes
    // nothing — the shape is asserted by the tests instead, against rows in the form Prisma writes.
    const rows: readonly MigrationRow[] = await client.$queryRaw`
      SELECT migration_name, finished_at FROM _prisma_migrations
    `;

    const finished = new Set(
      rows.filter((row) => row.finished_at !== null).map((row) => row.migration_name),
    );
    const pending = expected.filter((name) => !finished.has(name));

    return pending.length === 0 ? { status: 'up' } : { status: 'down', detail: 'pending' };
  },
});

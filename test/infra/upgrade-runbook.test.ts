import { describe, expect, it } from 'vitest';

import { listRepoFiles, readRepoFile } from '../repo/repo-fixture.util.js';
import { readBootstrapSql } from './compose-fixture.util.js';
import { rolesRequiredBy } from './migration-roles.util.js';

/**
 * The upgrade procedure, held against the artefacts it drives.
 *
 * A migration may name a database role, and roles are not created by migrations — they are created
 * by `00-bootstrap-roles.sql`, which only runs through `initdb` on an empty volume. On an existing
 * installation nothing runs it unless the runbook says so, and `prisma migrate deploy` then fails
 * with `P3018 … role "app_auth_definer" does not exist`. That failure is not a retryable one:
 * Prisma marks the migration **failed** in `_prisma_migrations`, and every later `deploy` answers
 * `P3009` and applies nothing until an operator runs `migrate resolve --rolled-back` by hand.
 * Reproduced on PostgreSQL 16 (pgvector/pgvector:0.8.5-pg16) with Prisma 6.19.3; the live half of
 * this guard is `packages/server/test/integration/db/upgrade-path.test.ts`.
 *
 * The first assertion is the one that generalises: the *next* role a migration names is caught on
 * the day the migration is written, not on the day an operator upgrades.
 *
 * How wide «names a role» is, is not decided here. The extraction lives in
 * `migration-roles.util.ts` and is asserted shape by shape in `migration-roles.test.ts` — because a
 * generalisation is only as true as the reader behind it, and the reader this file used to carry
 * was anchored on `;`, which meant it saw no `CREATE POLICY … TO app_user USING (…)` at all: the
 * canonical tenant policy, present in every migration that adds a tenant table.
 */

const UPGRADE_RUNBOOK_PATH = 'docs/runbooks/upgrade.md';
const MIGRATIONS_DIR = 'packages/server/prisma/migrations';

/** Role names the bootstrap creates — the left-hand side of every `CREATE ROLE` in that file. */
const rolesCreatedByBootstrap = (sql: string): Set<string> =>
  new Set([...sql.matchAll(/\bCREATE\s+ROLE\s+(\w+)/gi)].map((match) => match[1] ?? ''));

/** `## 3.` … up to the next `## ` heading. */
const sectionOf = (markdown: string, heading: string): string => {
  const start = markdown.indexOf(heading);

  expect(start, `the runbook has no section ${heading}`).toBeGreaterThan(-1);

  const rest = markdown.slice(start + heading.length);
  const end = rest.indexOf('\n## ');

  return end === -1 ? rest : rest.slice(0, end);
};

describe('the upgrade procedure and the roles migrations depend on', () => {
  const bootstrap = readBootstrapSql();
  const runbook = readRepoFile(UPGRADE_RUNBOOK_PATH);

  /**
   * The generic half. A migration naming a role the bootstrap does not create cannot be applied to
   * any existing installation, and the symptom appears at the operator rather than here.
   */
  it('creates every role the committed migrations name', () => {
    const created = rolesCreatedByBootstrap(bootstrap);
    const files = listRepoFiles(MIGRATIONS_DIR).filter((path) => path.endsWith('migration.sql'));

    expect(files.length, 'no migration was found to check').toBeGreaterThan(0);

    for (const file of files) {
      for (const role of rolesRequiredBy(readRepoFile(file))) {
        expect(
          [...created],
          `${file} names the role ${role}, which 00-bootstrap-roles.sql does not create — ` +
            'prisma migrate deploy then fails with P3018 on every existing installation',
        ).toContain(role);
      }
    }
  });

  /**
   * And the half that makes the first one true in practice. The bootstrap is idempotent and safe to
   * re-run, so the only reason an upgrade fails on a newly added role is that nobody ran it.
   */
  it('runs the role bootstrap before the migrations, in §3', () => {
    const procedure = sectionOf(runbook, '## 3.');

    const bootstrapAt = procedure.search(/00-bootstrap-roles|db:bootstrap/);
    const migrateAt = procedure.search(/migrate deploy|compose run --rm migrate/);

    expect(bootstrapAt, '§3 never mentions the role bootstrap').toBeGreaterThan(-1);
    expect(migrateAt, '§3 never mentions the migration step').toBeGreaterThan(-1);
    expect(
      bootstrapAt,
      'the role bootstrap has to run BEFORE the migrations: a migration naming a role the ' +
        'installation does not have fails with P3018, is then marked failed, and every later ' +
        'deploy answers P3009 until an operator resolves it by hand',
    ).toBeLessThan(migrateAt);
  });

  it('carries the bootstrap step into the checklist of §8', () => {
    expect(sectionOf(runbook, '## 8.')).toMatch(/db:bootstrap|00-bootstrap-roles/);
  });

  /**
   * The recovery, because the failure mode is not "run it again". `applied_steps_count = 0` means
   * the database is untouched, and the honest path out is `resolve --rolled-back` rather than the
   * restore §6 prescribes for a migration that applied something.
   */
  it('tells the operator how to leave the failed-migration state', () => {
    const failure = sectionOf(runbook, '## 6.');

    expect(failure).toContain('P3009');
    expect(failure).toMatch(/migrate resolve --rolled-back/);
  });

  /**
   * The one failure a retry hides instead of fixing.
   *
   * A concurrent index build that is cancelled — deadlock, `lock_timeout`, a server restart — leaves
   * the index `INVALID`. The migration carries `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, because
   * two statements in one file make Prisma open a transaction and `CONCURRENTLY` cannot run in one;
   * so the retry prints `already exists, skipping` and the migration **succeeds** over an index the
   * planner will not use. Nothing else notices: the integration suite always starts a clean
   * container, and `pnpm check:rls` does not read `pg_index`.
   *
   * Asserted on the runbook rather than on behaviour because the remedy is a human step. The catalog
   * query is what makes it actionable, so the test demands the query and not merely the word.
   */
  it('tells the operator to look for an invalid index before retrying', () => {
    const failure = sectionOf(runbook, '## 6.');

    // `indisvalid` alone is not enough to assert on: §6 has mentioned it since before this trap was
    // known, in the paragraph about a partially applied migration. The new claim is narrower — that
    // a **retry** hides the problem — so the assertion names the sentence only that claim produces.
    expect(failure).toMatch(/already exists, skipping/);
    expect(failure).toMatch(/REINDEX INDEX CONCURRENTLY|DROP INDEX CONCURRENTLY/);
    expect(sectionOf(runbook, '## 8.')).toMatch(/indisvalid/);
  });
});

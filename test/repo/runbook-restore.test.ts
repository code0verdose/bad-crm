import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readJson, repoRoot } from './repo-fixture.util.js';

const read = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), 'utf8');

/**
 * The commands a fenced block actually runs, with `#`/`--` comment lines dropped.
 *
 * The distinction is load-bearing here: a runbook that says «`--no-comments` is not an option, it
 * would also destroy the table comments» must not be read as a runbook that uses `--no-comments`.
 * Asserting against raw markdown makes every explanation of a rejected alternative a false failure,
 * and the usual repair is to delete the explanation — which is exactly the knowledge worth keeping.
 */
const commandsIn = (markdown: string): string =>
  [...markdown.matchAll(/```(\w*)\n([\s\S]*?)```/g)]
    .flatMap((block) => {
      // Language-aware, because `--` opens a comment in SQL and a long option in shell: stripping
      // `--` lines from a bash block would silently delete `--exclude=…` — the very flag under test.
      const commentPrefix = block[1] === 'sql' ? '--' : '#';

      return (block[2] ?? '').split('\n').filter((line) => {
        const trimmed = line.trimStart();
        return trimmed !== '' && !trimmed.startsWith(commentPrefix);
      });
    })
    .join('\n');

/**
 * The restore procedure of `docs/runbooks/backup-restore.md` is executed exactly once per
 * installation — on the worst day that installation ever has — and every defect in it has so far
 * been found by running it rather than by reading it. These assertions pin the three failures that
 * made a restore end with an empty or unusable database:
 *
 *   * `pg_restore` aborting on `COMMENT ON EXTENSION` before a single table was created;
 *   * the grant-restoring step being `prisma migrate deploy`, which has nothing pending to apply;
 *   * `CREATE DATABASE … OWNER app_migrator` running before the role existed.
 */
describe('docs/runbooks/backup-restore.md — the restore procedure', () => {
  const runbook = read('docs/runbooks/backup-restore.md');
  /** Section 7.2 only: the surrounding prose legitimately mentions the commands it warns about. */
  const section = runbook.slice(
    runbook.indexOf('### 7.2'),
    runbook.indexOf('### 7.3') === -1 ? undefined : runbook.indexOf('### 7.3'),
  );
  const restore = commandsIn(section);

  it('creates roles before it creates the database', () => {
    // `CREATE DATABASE … OWNER app_migrator` on a host where the bootstrap has never run fails with
    // `role "app_migrator" does not exist`. The bootstrap creates the database itself, so it goes
    // first and the explicit CREATE DATABASE is not needed at all.
    const bootstrap = restore.indexOf('db:bootstrap');
    const createDatabase = restore.indexOf('CREATE DATABASE');

    expect(bootstrap, 'the restore procedure must run the role bootstrap').toBeGreaterThan(-1);
    expect(bootstrap, 'roles have to exist before anything is restored into them').toBeLessThan(
      restore.indexOf('pg_restore'),
    );
    // An absent CREATE DATABASE is the expected shape — the bootstrap creates it — so "not found"
    // must not read as "found at position -1, therefore first".
    expect(bootstrap, 'CREATE DATABASE needs app_migrator to exist already').toBeLessThan(
      createDatabase === -1 ? Number.POSITIVE_INFINITY : createDatabase,
    );
  });

  it('does not filter the extension comments out with --no-comments', () => {
    // `--no-comments` drops *every* comment in the dump, including table and column comments that
    // exist nowhere else. The five extension comments are already present in the target database,
    // recreated by CREATE EXTENSION, so removing only those TOC entries loses nothing.
    expect(restore).not.toMatch(/--no-comments/);
    expect(restore).toMatch(/pg_restore\s+-l/);
    expect(restore).toMatch(/COMMENT - EXTENSION/);
    expect(restore).toMatch(/pg_restore[\s\S]{0,200}\s-L\s/);
  });

  it('keeps --exit-on-error so a partial restore cannot report success', () => {
    expect(restore).toMatch(/--exit-on-error/);
  });

  it('re-applies grants with db:grants and not by running migrations', () => {
    // `prisma migrate deploy` applies *pending* migrations. After a restore `_prisma_migrations`
    // comes back from the dump with everything marked applied, so it exits 0 having done nothing —
    // and `pnpm db:migrate` in dev is `prisma migrate dev`, which offers to reset the database.
    expect(restore).toMatch(/db:grants/);
    expect(restore, 'db:migrate must not be the grant-restoring step').not.toMatch(/db:migrate/);
  });

  it('collects statistics before anything compares row counts', () => {
    // pg_restore leaves pg_statistic empty, and a partitioned parent is never analysed by
    // autovacuum at all — it stays without statistics until somebody says so. Either spelling
    // counts: `ANALYZE` as SQL, or vacuumdb, which can be limited to one schema and therefore does
    // not emit a `permission denied to analyze pg_authid` warning per shared catalog.
    expect(restore).toMatch(/\bANALYZE\b|--analyze-only/);
  });
});

describe('package.json — database maintenance commands', () => {
  const scripts = readJson<{ scripts: Record<string, string> }>('package.json').scripts;

  it('exposes db:grants', () => {
    expect(scripts['db:grants']).toBeDefined();
    expect(scripts['db:grants']).toMatch(/01-grants\.sql/);
  });

  it('runs the bootstrap in a fresh container so a rotated password actually reaches it', () => {
    // `docker compose exec` runs inside a container whose environment was fixed when it was
    // created: after rotating a password in .env it re-applies the *old* one and prints success.
    // `docker compose run` builds its environment from the current compose config.
    expect(scripts['db:bootstrap']).not.toMatch(/compose exec/);
    expect(scripts['db:bootstrap']).toMatch(/compose run/);
  });
});

describe('docs/security/rls-design.md — checks that must not be red by default', () => {
  const design = read('docs/security/rls-design.md');

  it('exempts backup_role from the "no grants on partitions" rule', () => {
    // A partition with no GRANT SELECT for backup_role fails the whole dump: pg_dump locks and
    // reads every leaf. audit_logs is precisely the table an incident needs from a backup.
    const sectionStart = design.indexOf('### Партиционированные таблицы');
    const partitions = design.slice(
      sectionStart,
      design.indexOf('\n### ', sectionStart + 1), // the section only, not the rest of the document
    );

    expect(partitions).toMatch(/GRANT SELECT[^\n]*backup_role/);
  });

  it('guards has_table_privilege against a missing role', () => {
    // `has_table_privilege('backup_role', …)` raises `role does not exist` and takes the whole
    // check down with it, reporting a syntax-level failure instead of the actual finding.
    const grantChecks = design.slice(design.indexOf('-- 4g.'), design.indexOf('**Запрос 5'));

    expect(grantChecks).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM pg_roles/);
  });

  it('checks partition leaves for the backup grant in their own branch', () => {
    const grantChecks = design.slice(design.indexOf('-- 4g.'), design.indexOf('**Запрос 5'));

    // A positive `AND c.relispartition`, not the `AND NOT c.relispartition` of the parent branch.
    expect(grantChecks).toMatch(/\n\s*AND\s+c\.relispartition\b/);
  });

  it('narrows the set_config CI exclusion to the one line it is meant to allow', () => {
    // `--exclude=00-bootstrap-roles.sql` disables the check for the whole file, so a future
    // `set_config('app.organization_id', …, false)` added there would pass unseen.
    const commands = commandsIn(design);

    expect(commands).not.toMatch(/--exclude=00-bootstrap-roles\.sql/);
    expect(commands).toMatch(/grep\s+-vF\s+"set_config\('log_statement'/);
  });
});

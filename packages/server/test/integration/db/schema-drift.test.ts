import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { describe, expect, it, inject } from 'vitest';

/**
 * `prisma/schema.prisma` against the schema the migrations actually build.
 *
 * The two are a pair that nothing else in this repository holds together. Migrations are hand-written
 * here — they carry policies, grants, partial indexes and `SECURITY DEFINER` functions Prisma cannot
 * express — so the datamodel is not generated from them and cannot be diffed against them by
 * construction. What keeps them in step is a person remembering, and a person did not: the migration
 * of EPIC-006 created `idx_password_reset_tokens_org_user` and the model declared no `@@index`, so
 *
 *   prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma --script
 *
 * answered `DROP INDEX "idx_password_reset_tokens_org_user"`. That is not a cosmetic disagreement:
 * `pnpm db:migrate` in development generates the next migration from exactly this diff, so the next
 * developer to add a field would have shipped a migration that **drops** the index serving the
 * composite foreign key of `password_reset_tokens` — and `ON DELETE CASCADE` from `users` would then
 * scan the table.
 *
 * The check is deliberately the same command, run against a database built by the migrations
 * themselves. Exit code 2 means "there is a diff"; the `--script` output is printed so the failure
 * names the statements rather than a number.
 *
 * What it does *not* see is worth knowing, and is why it complements rather than replaces the RLS
 * suites: the diff engine models tables, columns, constraints and indexes. Policies, `FORCE ROW
 * LEVEL SECURITY`, grants, functions and comments are invisible to it — measured on this schema,
 * where the only statement it produced was the one above, against three policies, five grants and
 * three `SECURITY DEFINER` functions it said nothing about.
 */

const execFileAsync = promisify(execFile);

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const PRISMA_BIN = fileURLToPath(new URL('../../../node_modules/.bin/prisma', import.meta.url));

interface DiffResult {
  readonly exitCode: number;
  readonly script: string;
}

const migrateDiff = async (fromUrl: string): Promise<DiffResult> => {
  try {
    const { stdout } = await execFileAsync(
      PRISMA_BIN,
      [
        'migrate',
        'diff',
        '--from-url',
        fromUrl,
        '--to-schema-datamodel',
        'prisma/schema.prisma',
        '--script',
        '--exit-code',
      ],
      { cwd: PACKAGE_ROOT, env: { ...process.env } },
    );

    return { exitCode: 0, script: stdout };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };

    return {
      exitCode: failure.code ?? 1,
      script: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
    };
  }
};

describe('prisma/schema.prisma and the committed migrations', () => {
  const urls = inject('databaseUrls');

  /**
   * The positive control. `--exit-code` answers 2 for a diff and 0 for none, and a helper that
   * silently returned 0 for a database it could not reach would make the assertion below vacuous.
   */
  it('CONTROL: reports a diff when the datamodel and the database disagree', async () => {
    const { exitCode, script } = await migrateDiff(urls.superuser.replace(/\/[^/]+$/, '/postgres'));

    expect(exitCode, `an empty database must differ from the datamodel:\n${script}`).toBe(2);
    expect(script).toMatch(/CREATE TABLE/i);
  });

  it('describes the same schema, so a generated migration would drop nothing', async () => {
    const { exitCode, script } = await migrateDiff(urls.migrator);

    expect(
      exitCode,
      'the datamodel disagrees with the migrations. `pnpm db:migrate` in development generates the ' +
        'next migration from exactly this diff, so these statements are what it would ship:\n' +
        script,
    ).toBe(0);
  });
});

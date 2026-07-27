import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The migration linter of `rules/db-migrations.mdc`.
 *
 * It lives in the test suite rather than in a `scripts/` file because that is where it has teeth:
 * `pnpm test` runs on every change and in CI, needs no database, and fails under the name of the
 * rule that was broken. A separate binary is a second thing to remember to run.
 *
 * Every rule here answers a failure that is invisible at review time and expensive in production:
 * a destructive statement shipped in the same release as the code that stopped using the column
 * (the previous version can no longer be rolled back to), a `SET NOT NULL` that takes ACCESS
 * EXCLUSIVE and scans the table, an index built without `CONCURRENTLY` that blocks writes for the
 * duration of the build.
 */

const MIGRATIONS_ROOT = fileURLToPath(new URL('../../prisma/migrations', import.meta.url));

/** Exempts the first migration from the `CONCURRENTLY` rule — an empty schema blocks nobody. */
const INITIAL_MARKER = '-- bad-crm:initial-migration';

export interface MigrationFinding {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly message: string;
}

export interface CommittedMigration {
  readonly file: string;
  readonly sql: string;
}

/**
 * Blanks out `--` comments and single-quoted literals while keeping every character position, so
 * a finding still points at the right line and a rule name inside a comment is not a violation.
 */
const stripNoise = (line: string): string => {
  const withoutStrings = line.replace(/'[^']*'/g, (match) => ' '.repeat(match.length));
  const commentAt = withoutStrings.indexOf('--');

  return commentAt === -1 ? withoutStrings : withoutStrings.slice(0, commentAt);
};

const PATTERNS: readonly {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly message: string;
}[] = [
  {
    rule: 'destructive',
    pattern: /\bdrop\s+(table|column)\b/i,
    message:
      'destructive DDL needs a two-release expand → migrate → contract plan: the previous version of the application must still be able to run against this schema (rules/db-migrations.mdc, 2 and 3)',
  },
  {
    rule: 'rename',
    pattern: /\brename\s+(column|constraint|to)\b/i,
    message:
      'a rename is not a single operation here: add, dual-write, backfill, switch reads, drop two releases later (rules/db-migrations.mdc, 5)',
  },
];

const SET_NOT_NULL = /\balter\s+column\s+"?\w+"?\s+set\s+not\s+null\b/i;
const CREATE_INDEX = /\bcreate\s+(unique\s+)?index\b/i;
const INDEX_STATEMENT = /^\s*(create\s+(unique\s+)?index|drop\s+index)\b/i;
const CONCURRENTLY = /\bconcurrently\b/i;

const statementsOf = (sql: string): string[] =>
  sql
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

export const lintMigrationSql = (file: string, sql: string): MigrationFinding[] => {
  const findings: MigrationFinding[] = [];
  const lines = sql.split('\n');
  const code = lines.map(stripNoise);
  const wholeFile = code.join('\n');

  const isInitial = sql.includes(INITIAL_MARKER);
  const isConcurrentIndexFile = CONCURRENTLY.test(wholeFile);

  // A `CHECK (... IS NOT NULL) NOT VALID` validated in the same file is the sanctioned path to
  // `SET NOT NULL`: the scan happens under a lock nobody waits on.
  const hasValidatedCheck =
    /\bnot\s+valid\b/i.test(wholeFile) && /\bvalidate\s+constraint\b/i.test(wholeFile);

  lines.forEach((_original, index) => {
    const line = code[index] ?? '';
    const at = index + 1;

    for (const { rule, pattern, message } of PATTERNS) {
      if (pattern.test(line)) findings.push({ file, line: at, rule, message });
    }

    if (SET_NOT_NULL.test(line) && !hasValidatedCheck) {
      findings.push({
        file,
        line: at,
        rule: 'set-not-null',
        message:
          'SET NOT NULL rewrites the table under ACCESS EXCLUSIVE: add CHECK (... IS NOT NULL) NOT VALID, VALIDATE CONSTRAINT, then SET NOT NULL (rules/db-migrations.mdc, 4)',
      });
    }

    if (CREATE_INDEX.test(line) && !CONCURRENTLY.test(line) && !isInitial) {
      findings.push({
        file,
        line: at,
        rule: 'blocking-index',
        message:
          'CREATE INDEX without CONCURRENTLY blocks writes for the whole build; put the concurrent form in a migration of its own (rules/db-migrations.mdc, 6)',
      });
    }
  });

  if (isConcurrentIndexFile) {
    const foreign = statementsOf(wholeFile).filter((statement) => !INDEX_STATEMENT.test(statement));

    if (foreign.length > 0) {
      findings.push({
        file,
        line: 1,
        rule: 'concurrently-not-alone',
        message:
          'CONCURRENTLY cannot run inside a transaction, and Prisma wraps a migration file in one: the file may contain nothing but the index statements (rules/db-migrations.mdc, 6)',
      });
    }
  } else if (
    !/\bset\s+lock_timeout\b/i.test(wholeFile) ||
    !/\bset\s+statement_timeout\b/i.test(wholeFile)
  ) {
    findings.push({
      file,
      line: 1,
      rule: 'missing-timeouts',
      message:
        "every migration opens with SET lock_timeout = '3s'; SET statement_timeout = '5min'; — an ALTER waiting for a lock queues every query behind it (rules/db-migrations.mdc, 7)",
    });
  }

  return findings.sort((left, right) => left.line - right.line);
};

/** Every `migration.sql` committed under `prisma/migrations`, in application order. */
export const committedMigrations = (): CommittedMigration[] =>
  readdirSync(MIGRATIONS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .map((directory) => ({
      file: `${directory}/migration.sql`,
      sql: readFileSync(join(MIGRATIONS_ROOT, directory, 'migration.sql'), 'utf8'),
    }));

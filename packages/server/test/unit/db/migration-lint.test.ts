import { describe, expect, it } from 'vitest';

import {
  committedMigrations,
  lintMigrationSql,
  type MigrationFinding,
} from '../../support/migration-lint.util.js';

const rulesOf = (findings: MigrationFinding[]): string[] => findings.map((finding) => finding.rule);

const INITIAL_HEADER = '-- bad-crm:initial-migration\n';
const TIMEOUTS = "SET lock_timeout = '3s';\nSET statement_timeout = '5min';\n";

const clean = `${TIMEOUTS}ALTER TABLE teams ADD COLUMN archived_at timestamptz;\n`;

describe('the migration linter', () => {
  it('passes a plain expand migration', () => {
    expect(lintMigrationSql('20260801_expand/migration.sql', clean)).toEqual([]);
  });

  /**
   * Positive control for every rule at once. `expect(findings).toEqual([])` is the shape of every
   * assertion below, and it is also what a linter that stopped matching anything returns.
   */
  it.each([
    ['destructive', `${TIMEOUTS}ALTER TABLE teams DROP COLUMN description;\n`],
    ['destructive', `${TIMEOUTS}DROP TABLE teams;\n`],
    ['rename', `${TIMEOUTS}ALTER TABLE teams RENAME COLUMN name TO title;\n`],
    ['set-not-null', `${TIMEOUTS}ALTER TABLE teams ALTER COLUMN description SET NOT NULL;\n`],
    ['blocking-index', `${TIMEOUTS}CREATE INDEX idx_teams_org_name ON teams (name);\n`],
    ['missing-timeouts', 'ALTER TABLE teams ADD COLUMN archived_at timestamptz;\n'],
  ])('flags %s', (rule, sql) => {
    expect(rulesOf(lintMigrationSql('20260801_change/migration.sql', sql))).toContain(rule);
  });

  it('reports the line a finding sits on', () => {
    const [finding] = lintMigrationSql(
      '20260801_change/migration.sql',
      `${TIMEOUTS}ALTER TABLE teams DROP COLUMN description;\n`,
    );

    expect(finding?.line).toBe(3);
    expect(finding?.file).toBe('20260801_change/migration.sql');
  });

  /**
   * `rules/db-migrations.mdc`, «Исключения»: the first migration runs against an empty schema,
   * so there is nothing to block and `CONCURRENTLY` is not required. The exemption is a marker in
   * the file rather than "the alphabetically first directory" — the second developer to add an
   * index must not be able to inherit it by accident.
   */
  it('exempts the marked initial migration from the CONCURRENTLY requirement', () => {
    const sql = `${INITIAL_HEADER}${TIMEOUTS}CREATE INDEX idx_teams_org_name ON teams (organization_id, name);\n`;

    expect(lintMigrationSql('20260727_init/migration.sql', sql)).toEqual([]);
  });

  it('still refuses a destructive statement in the initial migration', () => {
    const sql = `${INITIAL_HEADER}${TIMEOUTS}DROP TABLE teams;\n`;

    expect(rulesOf(lintMigrationSql('20260727_init/migration.sql', sql))).toContain('destructive');
  });

  it('accepts SET NOT NULL that follows a validated CHECK', () => {
    const sql = [
      TIMEOUTS,
      'ALTER TABLE teams ADD CONSTRAINT ck_teams_description_not_null',
      '  CHECK (description IS NOT NULL) NOT VALID;',
      'ALTER TABLE teams VALIDATE CONSTRAINT ck_teams_description_not_null;',
      'ALTER TABLE teams ALTER COLUMN description SET NOT NULL;',
      '',
    ].join('\n');

    expect(lintMigrationSql('20260901_contract/migration.sql', sql)).toEqual([]);
  });

  it('requires a CONCURRENTLY index to be alone in its file', () => {
    const sql = [
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_teams_org_name ON teams (organization_id, name);',
      'ALTER TABLE teams ADD COLUMN archived_at timestamptz;',
      '',
    ].join('\n');

    expect(rulesOf(lintMigrationSql('20260801_index/migration.sql', sql))).toContain(
      'concurrently-not-alone',
    );
  });

  it('accepts a file that contains only the concurrent index', () => {
    const sql = [
      'DROP INDEX CONCURRENTLY IF EXISTS idx_teams_org_name;',
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_teams_org_name ON teams (organization_id, name);',
      '',
    ].join('\n');

    expect(lintMigrationSql('20260801_index/migration.sql', sql)).toEqual([]);
  });

  it('ignores forbidden words inside comments and string literals', () => {
    const sql = `${TIMEOUTS}-- DROP TABLE teams; would need a contract release\nALTER TABLE teams ADD COLUMN archived_at timestamptz;\n`;

    expect(lintMigrationSql('20260801_expand/migration.sql', sql)).toEqual([]);
  });
});

describe('the committed migrations', () => {
  it('exist, so the assertion below is not vacuous', () => {
    expect(committedMigrations().length).toBeGreaterThan(0);
  });

  it('pass the linter', () => {
    const findings = committedMigrations().flatMap((migration) =>
      lintMigrationSql(migration.file, migration.sql),
    );

    expect(findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`)).toEqual(
      [],
    );
  });
});

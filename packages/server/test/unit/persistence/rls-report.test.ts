import { describe, expect, it } from 'vitest';

import { type RlsFinding } from '@/infrastructure/persistence/prisma/rls-catalog.util.js';
import {
  describeConnection,
  renderRlsReport,
} from '@/infrastructure/persistence/prisma/rls-report.util.js';

/**
 * The report is the whole user interface of `pnpm check:rls`, and it is read once — on a staging
 * host, by someone who has just restored a production backup and wants to know whether the restore
 * kept tenant isolation. It has to say what was checked, what is wrong and what to do about it; a
 * stack trace answers none of the three.
 */

const SCOPE = {
  target: 'bad_crm on db.staging:5432',
  role: 'app_migrator',
  tables: 2,
  policies: 4,
};

const FINDING: RlsFinding = {
  check: 'policy',
  subject: 'teams.tenant_isolation',
  problem: 'the policy covers ALL and has no WITH CHECK clause',
  remedy: 'add WITH CHECK with the same predicate as USING',
};

describe('a clean database', () => {
  const report = (): string => renderRlsReport([], SCOPE);

  it('says so in the first place anybody looks', () => {
    expect(report()).toMatch(/\bOK\b/);
  });

  /**
   * "OK" alone is what a check that never ran also prints. The list of checks is what tells the
   * reader whether the answer covers the thing they came to ask about.
   */
  it('names what was compared, so the pass can be read', () => {
    expect(report()).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(report()).toMatch(/WITH CHECK/);
    expect(report()).toMatch(/PUBLIC/);
    expect(report()).toContain('2');
    expect(report()).toContain('4');
  });

  it('names the database it looked at, so a report cannot be about the wrong host', () => {
    expect(report()).toContain('bad_crm on db.staging:5432');
    expect(report()).toContain('app_migrator');
  });
});

describe('a database with findings', () => {
  const report = (): string => renderRlsReport([FINDING], SCOPE);

  it('prints the subject, the problem and the remedy of every finding', () => {
    expect(report()).toContain('teams.tenant_isolation');
    expect(report()).toContain(FINDING.problem);
    expect(report()).toContain(FINDING.remedy);
  });

  it('counts them, and does not say OK', () => {
    expect(report()).toMatch(/1 violation\b/);
    expect(renderRlsReport([FINDING, FINDING], SCOPE)).toMatch(/2 violations\b/);
    expect(report()).not.toMatch(/\bOK\b/);
  });

  it('points at the document that defines the canonical policy', () => {
    expect(report()).toContain('docs/security/rls-design.md');
  });

  it('groups the findings by check, so one missing migration reads as one problem', () => {
    const rendered = renderRlsReport(
      [FINDING, { ...FINDING, check: 'row-security', subject: 'teams' }],
      SCOPE,
    );

    expect(rendered).toContain('row-security');
    expect(rendered).toContain('policy');
  });
});

/**
 * The connection string carries the password of a database role. It arrives on a command line or
 * in an environment variable and must not come back out in a terminal that is being screen-shared,
 * pasted into an incident channel or captured by CI.
 */
describe('describing the target', () => {
  it('names the database and the host', () => {
    expect(describeConnection('postgresql://app_migrator:s3cret@db.staging:5432/bad_crm')).toBe(
      'bad_crm on db.staging:5432',
    );
  });

  it('never repeats the password', () => {
    expect(
      describeConnection('postgresql://app_migrator:s3cret@db.staging:5432/bad_crm'),
    ).not.toContain('s3cret');
  });

  it('falls back to something printable when the string is not a URL', () => {
    expect(describeConnection('not a url')).toBe('the configured database');
  });

  it('survives a connection string with no port and no database', () => {
    expect(describeConnection('postgresql://localhost')).toBe(
      'the configured database on localhost',
    );
  });
});

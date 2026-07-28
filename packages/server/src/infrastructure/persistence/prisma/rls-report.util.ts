import { type RlsCheck, type RlsFinding } from './rls-catalog.util.js';

/**
 * How the catalog check reports itself to an operator.
 *
 * Kept beside the audit rather than inside `scripts/check-rls.ts` so that the wording is under
 * test: the report is read on the day a production backup has been restored into staging, by
 * someone deciding whether that restore kept tenant isolation. A stack trace, or an "OK" with
 * nothing behind it, answers that question badly enough to be worth a suite.
 */

/** What the run was about, in terms that can be printed. Never a connection string. */
export interface RlsReportScope {
  /** Human description of the database, from `describeConnection`. */
  readonly target: string;
  /** The role the check connected as — it decides what the catalog answers. */
  readonly role: string;
  /** Tenant tables compared. */
  readonly tables: number;
  /** Policies read out of `public`. */
  readonly policies: number;
}

const CHECK_LIST = [
  'ENABLE and FORCE ROW LEVEL SECURITY on every tenant table',
  'a policy addressed to app_user, with both USING and WITH CHECK, on every tenant table',
  'no policy addressed to PUBLIC, and no PERMISSIVE policy on a tenant table that widens any role',
  'the catalog, the Prisma schema and the tenant registry list the same tables',
];

const CHECK_ORDER: readonly RlsCheck[] = ['row-security', 'policy', 'registry'];

/**
 * The database and host of a connection string, without the credentials.
 *
 * The string arrives from a command line or from `DATABASE_URL`; printing it back would put a
 * password of a database role into a terminal, a CI log or an incident channel.
 */
export const describeConnection = (connectionString: string): string => {
  let url: URL;

  try {
    url = new URL(connectionString);
  } catch {
    return 'the configured database';
  }

  const database = url.pathname.replace(/^\//, '');
  const host = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;

  return `${database === '' ? 'the configured database' : database} on ${host}`;
};

const header = (scope: RlsReportScope): string[] => [
  'RLS catalog check',
  `  target : ${scope.target}`,
  `  role   : ${scope.role}`,
  `  scope  : ${scope.tables} tenant tables, ${scope.policies} policies in schema "public"`,
  '',
  'Compared against docs/security/rls-design.md:',
  ...CHECK_LIST.map((line) => `  - ${line}`),
  '',
];

/**
 * The report, as one block of text.
 *
 * Findings are grouped by check because that is how they are repaired: a migration that forgot its
 * policy produces one finding per table, and reading them as one group is the difference between
 * "one migration is wrong" and "six unrelated things are wrong".
 */
export const renderRlsReport = (findings: readonly RlsFinding[], scope: RlsReportScope): string => {
  const lines = header(scope);

  if (findings.length === 0) {
    lines.push('OK — the catalog matches the specification.');

    return lines.join('\n');
  }

  lines.push(`${findings.length} violation${findings.length === 1 ? '' : 's'}:`, '');

  for (const check of CHECK_ORDER) {
    const group = findings.filter((finding) => finding.check === check);
    if (group.length === 0) continue;

    lines.push(`[${check}]`);
    for (const finding of group) {
      lines.push(
        `  ${finding.subject}`,
        `      problem: ${finding.problem}`,
        `      remedy : ${finding.remedy}`,
      );
    }
    lines.push('');
  }

  lines.push(
    'Nothing was changed: this check only reads the catalog.',
    'The canonical policy and the «new table» checklist are in docs/security/rls-design.md.',
  );

  return lines.join('\n');
};

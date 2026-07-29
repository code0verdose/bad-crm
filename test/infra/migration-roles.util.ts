/**
 * Which database roles a migration file requires to already exist.
 *
 * Roles are not created by migrations — they come from `prisma/sql/00-bootstrap-roles.sql`, which
 * only runs through `initdb` on an empty volume. A migration naming a role an installation does not
 * have fails with `P3018 … role "x" does not exist`, is then marked **failed** in
 * `_prisma_migrations`, and every later `migrate deploy` answers `P3009` until an operator runs
 * `migrate resolve --rolled-back` by hand. `test/infra/upgrade-runbook.test.ts` holds every
 * committed migration against the bootstrap using this function, so its width *is* the width of
 * that guard: a shape not seen here is a role nobody checks.
 *
 * WHAT COUNTS AS A ROLE REFERENCE
 *
 * Every statement below is one PostgreSQL resolves through `get_role_oid`, i.e. one that answers
 * `42704` when the role is missing:
 *
 *   * `GRANT <privileges> ON <objects> TO <roles> [WITH GRANT OPTION]`
 *   * `GRANT <roles> TO <roles> [WITH ADMIN OPTION]` — role membership, where the *granted* side is
 *     a role as well and is the half a grantee-only reading loses;
 *   * `REVOKE … FROM <roles> [CASCADE|RESTRICT]`
 *   * `ALTER <object> OWNER TO <role>`
 *   * `SET [LOCAL|SESSION] ROLE <role>`
 *   * `CREATE POLICY … TO <roles> USING …` / `ALTER POLICY … TO <roles>` — the canonical tenant
 *     policy of this project, and the one shape that is *not* terminated by a semicolon;
 *   * `ALTER DEFAULT PRIVILEGES FOR ROLE <role> … GRANT … TO <roles>`.
 *
 * Deliberately out of scope: `REASSIGN OWNED BY` / `DROP OWNED BY`, which are cluster maintenance
 * run by an operator, not statements a migration of this repository may contain, and dynamic SQL
 * built inside a `DO` block, which no static reader can resolve. Both are named here so the
 * boundary is a decision rather than an oversight.
 *
 * Pseudo-roles (`PUBLIC`, `CURRENT_USER`, `CURRENT_ROLE`, `SESSION_USER`, `NONE`) always resolve
 * and are excluded.
 */

/** A quoted or unquoted SQL identifier. */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_-￿][\w$-￿]*)`;

const PSEUDO_ROLES = new Set(['PUBLIC', 'CURRENT_USER', 'CURRENT_ROLE', 'SESSION_USER', 'NONE']);

const OWNER_TO = new RegExp(String.raw`\bOWNER\s+TO\s+(${IDENTIFIER})`, 'gi');
const SET_ROLE = new RegExp(
  String.raw`\bSET\s+(?:LOCAL\s+|SESSION\s+)?ROLE\s+(${IDENTIFIER})`,
  'gi',
);

const IS_GRANT_LIKE = /^(?:GRANT|REVOKE|ALTER\s+DEFAULT\s+PRIVILEGES)\b/i;
const IS_POLICY = /^(?:CREATE|ALTER)\s+POLICY\b/i;

const GRANT_TO =
  /\bGRANT\s+(.+?)\s+TO\s+(.+?)(?:\s+WITH\s+(?:GRANT|ADMIN)\s+OPTION)?(?:\s+GRANTED\s+BY\s+.+)?$/is;
const REVOKE_FROM =
  /\bREVOKE\s+(.+?)\s+FROM\s+(.+?)(?:\s+(?:CASCADE|RESTRICT))?(?:\s+GRANTED\s+BY\s+.+)?$/is;
const POLICY_TO = /\bTO\s+(.+?)(?:\s+USING\b|\s+WITH\s+CHECK\b|$)/is;
const DEFAULT_PRIVILEGES_FOR =
  /\bFOR\s+(?:ROLE|USER)\s+(.+?)\s+(?:IN\s+SCHEMA\b|GRANT\b|REVOKE\b)/is;

/** `GRANT OPTION FOR` / `ADMIN OPTION FOR`, which precede the role list of a membership REVOKE. */
const OPTION_FOR = /^(?:GRANT|ADMIN)\s+OPTION\s+FOR\s+/i;

const unquote = (name: string): string =>
  name.startsWith('"') && name.endsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"')
    : name.trim();

/**
 * Splits a file into statements, tracking the three things a `;` can be inside of: a line comment,
 * a single-quoted literal and a dollar-quoted body. The body is the one that matters — it is the
 * only one that routinely contains semicolons, and splitting through it produces fragments that
 * match a shape by halves.
 *
 * Comment and literal contents are dropped rather than kept: a role name inside either is data, and
 * a guard that demanded the bootstrap create it would fail on a migration that did nothing wrong.
 */
export const sqlStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const rest = sql.slice(index);

    const lineComment = /^--[^\n]*/.exec(rest);

    if (lineComment) {
      index += lineComment[0].length;
      current += ' ';
      continue;
    }

    const blockComment = /^\/\*[\s\S]*?\*\//.exec(rest);

    if (blockComment) {
      index += blockComment[0].length;
      current += ' ';
      continue;
    }

    const literal = /^'(?:[^']|'')*'/.exec(rest);

    if (literal) {
      index += literal[0].length;
      current += ' ';
      continue;
    }

    const dollarOpen = /^\$[\w]*\$/.exec(rest);

    if (dollarOpen) {
      const tag = dollarOpen[0];
      const close = sql.indexOf(tag, index + tag.length);

      index = close === -1 ? sql.length : close + tag.length;
      current += ' ';
      continue;
    }

    if (sql[index] === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += sql[index];
    index += 1;
  }

  statements.push(current);

  return statements.map((statement) => statement.replace(/\s+/g, ' ').trim()).filter(Boolean);
};

/** A comma-separated role list → the role names in it, pseudo-roles dropped. */
const roleList = (text: string): string[] =>
  text
    .split(',')
    .map((entry) => entry.trim())
    .map((entry) => new RegExp(String.raw`^${IDENTIFIER}$`).exec(entry)?.[0])
    .filter((entry): entry is string => entry !== undefined)
    .map(unquote)
    .filter((name) => !PSEUDO_ROLES.has(name.toUpperCase()));

/**
 * The left-hand side of a `GRANT`/`REVOKE`: a role list when the statement grants membership, a
 * privilege list otherwise. `ON` is what separates the two — `GRANT SELECT ON TABLE …` against
 * `GRANT app_auth_definer TO …`.
 */
const grantedRoles = (left: string): string[] =>
  /\bON\b/i.test(left) ? [] : roleList(left.replace(OPTION_FOR, ''));

export const rolesRequiredBy = (sql: string): Set<string> => {
  const found = new Set<string>();
  const add = (names: string[]): void => {
    for (const name of names) found.add(name);
  };

  for (const statement of sqlStatements(sql)) {
    for (const [, role] of statement.matchAll(OWNER_TO)) add(roleList(role ?? ''));
    for (const [, role] of statement.matchAll(SET_ROLE)) add(roleList(role ?? ''));

    if (IS_POLICY.test(statement)) {
      add(roleList(POLICY_TO.exec(statement)?.[1] ?? ''));
      continue;
    }

    if (!IS_GRANT_LIKE.test(statement)) continue;

    add(roleList(DEFAULT_PRIVILEGES_FOR.exec(statement)?.[1] ?? ''));

    const granted = GRANT_TO.exec(statement);

    if (granted) {
      add(grantedRoles(granted[1] ?? ''));
      add(roleList(granted[2] ?? ''));
    }

    const revoked = REVOKE_FROM.exec(statement);

    if (revoked) {
      add(grantedRoles(revoked[1] ?? ''));
      add(roleList(revoked[2] ?? ''));
    }
  }

  return found;
};

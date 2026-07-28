import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * One definition of the canonical policy, and a mechanical proof that it is one.
 *
 * The check has two consumers that cannot be merged: the integration suite, which starts its own
 * container and can only judge the migration in this checkout, and `pnpm check:rls`, which points
 * at a database that already exists — a staging host restored from a production backup. Two
 * consumers are fine. Two *templates* are the defect: a predicate, a `FORCE` flag or a `WITH CHECK`
 * rule written out twice diverges the first time one of them changes, and the copy that is wrong is
 * the one nobody ran.
 *
 * So the property is asserted rather than agreed: the catalog identifiers below may appear in
 * `rls-catalog.constant.ts` and nowhere else under `src/`, `test/` or `scripts/`. A copied query is
 * a failing test, not a review comment.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** The single file allowed to name the catalog. */
const DEFINITION = 'src/infrastructure/persistence/prisma/rls-catalog.constant.ts';

/**
 * This spec itself, which necessarily contains the needles it searches for. Excluded by path and
 * not by cleverness — the alternative is assembling the strings at runtime, which hides from a
 * reader exactly what is being looked for.
 */
const SELF = 'test/unit/persistence/rls-catalog-sources.test.ts';

/**
 * What a second copy of the template would have to mention.
 *
 * `polwithcheck` and `relforcerowsecurity` are the two catalog columns whose absence is invisible
 * from the outside; `pg_policy` is the table any hand-written policy check has to read; the last is
 * the escaped form of the tenant predicate, which only ever occurs inside a regular expression.
 */
const CATALOG_IDENTIFIERS = [
  'polwithcheck',
  'relforcerowsecurity',
  'pg_policy',
  "current_setting\\('app\\.organization_id'",
  // The maintenance switch joined the list when the audit started judging every permissive policy
  // on a tenant table rather than only those addressed to `app_user`: it is now the second
  // predicate the check accepts, so it is the second template that must exist exactly once. It was
  // written out in `migrations.test.ts` before that.
  "current_setting\\('app\\.maintenance'",
];

const sourcesUnder = (directory: string): string[] =>
  readdirSync(`${PACKAGE_ROOT}${directory}`, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourcesUnder(path);

    return entry.name.endsWith('.ts') ? [path.replace(/^\//, '')] : [];
  });

const SOURCES = ['/src', '/test', '/scripts'].flatMap((directory) => sourcesUnder(directory));

const read = (path: string): string => readFileSync(`${PACKAGE_ROOT}${path}`, 'utf8');

describe('the canonical policy template', () => {
  it('is defined in a file that exists', () => {
    expect(SOURCES).toContain(DEFINITION);
  });

  it.each(CATALOG_IDENTIFIERS)('mentions %s in exactly one place', (identifier) => {
    const mentions = SOURCES.filter(
      (path) => path !== SELF && read(path).includes(identifier),
    ).sort();

    expect(mentions).toEqual([DEFINITION]);
  });
});

/**
 * The other half: a consumer that stopped importing the module would pass the assertions above by
 * having no catalog knowledge at all — because it had quietly stopped checking anything.
 */
describe('both consumers read that definition', () => {
  it.each([
    ['test/integration/db/migrations.test.ts', 'rls-catalog.constant.js'],
    ['test/integration/db/migrations.test.ts', 'rls-catalog.util.js'],
    ['test/integration/db/rls-catalog-check.test.ts', 'rls-catalog.util.js'],
    ['scripts/check-rls.ts', 'rls-catalog.util.js'],
    ['scripts/check-rls.ts', 'rls-report.util.js'],
  ])('%s imports %s', (consumer, module) => {
    expect(read(consumer)).toMatch(new RegExp(`from '[^']*${module.replace('.', '\\.')}'`));
  });
});

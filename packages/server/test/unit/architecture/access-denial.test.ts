import { describe, expect, it } from 'vitest';

import { readSource, sourceFiles } from './source-tree.util.js';

/**
 * Invariant 2 of CLAUDE.md ends with a choice that cannot be made twice: a denial that crosses an
 * organization boundary answers **404**, not 403, because a 403 turns the API into an oracle for the
 * existence of other tenants' resources.
 *
 * `domain/shared/errors/access-denial.util.ts` makes that choice once. The hole its own unit test
 * names — "the only way to get it wrong is to bypass the helper and build the error by hand" — is
 * what this file closes: constructing `ForbiddenError` or `NotFoundError` directly is how the wrong
 * status reaches a client, and it reads as perfectly ordinary code in review.
 *
 * The test exists **now**, while the count of domain call sites is zero. Written ten epics later it
 * would be a refactor of a hundred places instead of a rule nobody has to remember.
 */

/**
 * Files allowed to construct these errors directly, each for a reason that is not about tenancy —
 * and each with the shape that reason predicts, so the allow-list cannot outlive it.
 *
 * `kind` is the point. An entry earns its exemption by doing one specific thing: two of these
 * construct an error directly, one only declares the classes. Asserting merely that the *file*
 * still exists lets an entry survive the disappearance of the code it excuses — a dead exemption
 * that silently widens the next time somebody adds a `new NotFoundError` to that path.
 */
const ALLOWED: readonly { readonly file: string; readonly kind: 'constructs' | 'declares' }[] = [
  // The one place that decides between the two, from a resource scope and an actor.
  { file: 'domain/shared/errors/access-denial.util.ts', kind: 'constructs' },
  // Their own declarations — this file never constructs one, it defines the classes.
  { file: 'domain/shared/errors/app.errors.ts', kind: 'declares' },
  // A request that matched no route at all: there is no resource and no tenant to leak.
  { file: 'presentation/http/middleware/not-found.middleware.ts', kind: 'constructs' },
];

const ALLOWED_FILES = ALLOWED.map((entry) => entry.file);

const DIRECT_CONSTRUCTION = /new\s+(ForbiddenError|NotFoundError)\s*\(/;
const DECLARATION = /\bclass\s+(ForbiddenError|NotFoundError)\s+extends\b/;

const offenders = (): string[] =>
  sourceFiles().filter(
    (file) => !ALLOWED_FILES.includes(file) && DIRECT_CONSTRUCTION.test(readSource(file)),
  );

describe('the 404-not-403 choice is made in one place', () => {
  it('constructs ForbiddenError and NotFoundError nowhere else', () => {
    expect(offenders()).toEqual([]);
  });

  /**
   * Positive control. Without it this file passes when the pattern stops matching — after a rename,
   * after a switch to a factory function — and the guard would be gone with the suite still green.
   * `layers.test.ts` lacks exactly this, and that is why the same shape is asserted here.
   */
  it('detects a direct construction when there is one', () => {
    const sample = `
      import { ForbiddenError } from '@/domain/shared/errors/app.errors.js';
      export const reject = (): never => {
        throw new ForbiddenError('task_forbidden');
      };
    `;

    expect(DIRECT_CONSTRUCTION.test(sample)).toBe(true);
  });

  it('does not flag a call through the helper', () => {
    const sample = `
      import { denyAccess } from '@/domain/shared/errors/access-denial.util.ts';
      export const reject = (): never => denyAccess('task', { organizationId: 'other' });
    `;

    expect(DIRECT_CONSTRUCTION.test(sample)).toBe(false);
  });

  /**
   * The allow-list is a set of exemptions from the rule above, and an exemption whose reason has
   * gone is a hole waiting for the next edit to that path. Checking only that the file still exists
   * cannot see that: delete the `new NotFoundError` out of `not-found.middleware.ts` and the entry
   * stays on the list as a dead exception, still green.
   */
  it('keeps the allow-list honest: every entry still exists and still does what it is excused for', () => {
    const tree = sourceFiles();

    for (const { file, kind } of ALLOWED) {
      expect(tree, `${file} is on the allow-list but not in the tree`).toContain(file);

      const source = readSource(file);
      const pattern = kind === 'constructs' ? DIRECT_CONSTRUCTION : DECLARATION;

      expect(
        pattern.test(source),
        `${file} is on the allow-list as '${kind}', but no longer ${
          kind === 'constructs' ? 'constructs' : 'declares'
        } ForbiddenError or NotFoundError — the exemption is dead and must be removed`,
      ).toBe(true);
    }
  });
});

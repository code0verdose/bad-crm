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

/** Files allowed to construct these errors directly, each for a reason that is not about tenancy. */
const ALLOWED = [
  // The one place that decides between the two, from a resource scope and an actor.
  'domain/shared/errors/access-denial.util.ts',
  // Their own declarations.
  'domain/shared/errors/app.errors.ts',
  // A request that matched no route at all: there is no resource and no tenant to leak.
  'presentation/http/middleware/not-found.middleware.ts',
];

const DIRECT_CONSTRUCTION = /new\s+(ForbiddenError|NotFoundError)\s*\(/;

const offenders = (): string[] =>
  sourceFiles().filter(
    (file) => !ALLOWED.includes(file) && DIRECT_CONSTRUCTION.test(readSource(file)),
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

  it('keeps the allow-list honest: every entry still exists and still constructs one', () => {
    for (const file of ALLOWED) {
      expect(sourceFiles(), `${file} is on the allow-list but not in the tree`).toContain(file);
    }
  });
});

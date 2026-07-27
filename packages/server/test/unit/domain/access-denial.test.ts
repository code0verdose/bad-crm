import { describe, expect, it } from 'vitest';

import { denyAccess } from '../../../src/domain/shared/errors/access-denial.util.js';
import { ForbiddenError, NotFoundError } from '../../../src/domain/shared/errors/app.errors.js';

/**
 * Invariant 2 of CLAUDE.md, expressed as the only door: nothing outside this helper decides
 * between 403 and 404.
 *
 * The rule — "no access to another organization is answered 404, never 403" — is not enforceable by
 * review, because the violating code looks correct in isolation (`throw new ForbiddenError(...)` in
 * a policy that happens to be about a foreign tenant). Here compliance is the shorter path: a
 * caller states *why* access was denied and gets the right error, and the only way to get it wrong
 * is to bypass the helper and hand-build the error instead.
 */
describe('denyAccess maps the reason for a denial, not the caller preference', () => {
  it('answers a cross-organization denial with 404, so the API is not an existence oracle', () => {
    const error = denyAccess('task', 'other_organization');

    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBe('task_not_found');
    expect(error.status).toBe(404);
  });

  it('answers a denial inside the caller organization with 403', () => {
    const error = denyAccess('task', 'own_organization');

    expect(error).toBeInstanceOf(ForbiddenError);
    expect(error.code).toBe('task_forbidden');
    expect(error.status).toBe(403);
  });

  it.each(['vault_item', 'doc', 'time_entry', 'channel'] as const)(
    'never leaks the existence of a foreign %s',
    (resource) => {
      expect(denyAccess(resource, 'other_organization').status).toBe(404);
    },
  );

  it('never produces a 403 for a resource the caller cannot see at all', () => {
    // The positive control of the pair above: if the two branches were swapped, the assertions on
    // `own_organization` alone would still pass.
    expect(denyAccess('project', 'other_organization')).not.toBeInstanceOf(ForbiddenError);
  });
});

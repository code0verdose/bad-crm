import { describe, expect, it } from 'vitest';

import * as SharedPermissions from '../../packages/shared/src/permissions/index.js';

import { readRepoFile, recordRead } from '../repo/repo-fixture.util.js';

/**
 * Every key in the catalogue is used by something.
 *
 * A permission nobody grants, no route checks and no policy names is one of two things, and both are
 * defects: unfinished work that reads as a shipped capability, or a key that outlived the feature it
 * belonged to and should have been marked deprecated. Neither is visible from a passing test suite —
 * an unused key breaks nothing, which is exactly why it accumulates.
 *
 * «Used» is deliberately broad: named by a system role, checked by a route declaration, or mentioned
 * anywhere in the server's source. The narrow version — «checked by a route» — would fail for the
 * three hundred keys whose domains arrive in M3–M9, and a gate that is red for a year is a gate
 * somebody deletes.
 */

recordRead('packages/shared/src/permissions/permissions.catalog.ts');

const SOURCES = [
  'packages/server/src/presentation/http/route-registry.factory.ts',
  'packages/server/src/domain/iam/access/role-assignment.policy.ts',
  'packages/server/src/domain/iam/access/permission-override.policy.ts',
];

const mentionedInSource = (): Set<string> => {
  const mentioned = new Set<string>();

  for (const path of SOURCES) {
    for (const [, key] of readRepoFile(path).matchAll(/'([a-z0-9_]+:[a-z0-9_]+)'/g)) {
      if (key !== undefined) mentioned.add(key);
    }
  }

  return mentioned;
};

const grantedByAnyRole = (): Set<string> => {
  const granted = new Set<string>();

  for (const role of SharedPermissions.SYSTEM_ROLE_KEYS) {
    for (const key of SharedPermissions.SYSTEM_ROLE_PERMISSIONS[role]) granted.add(key);
  }

  return granted;
};

describe('the permission catalogue and the code that uses it', () => {
  it('CONTROL: the sources it reads really mention permissions', () => {
    // Against a renamed file or a changed quoting style every key would look «unused via source»,
    // and the assertion below would pass on the role matrix alone.
    expect(mentionedInSource().size).toBeGreaterThan(0);
  });

  it('leaves no key that nothing grants, checks or names', () => {
    const granted = grantedByAnyRole();
    const mentioned = mentionedInSource();

    const orphans = [...SharedPermissions.PERMISSIONS].filter(
      (key) => !granted.has(key) && !mentioned.has(key),
    );

    expect(
      orphans,
      'право, которое никто не выдаёт и нигде не проверяется: удалить или пометить deprecated',
    ).toEqual([]);
  });

  /**
   * The other direction, and the one that catches a typo: a key written in the source that the
   * catalogue does not contain would be checked against nothing — `can()` fails closed on it, so the
   * route silently refuses everybody instead of failing loudly at review.
   */
  it('names no key the catalogue does not contain', () => {
    const invented = [...mentionedInSource()].filter(
      (key) => !SharedPermissions.isPermissionKey(key),
    );

    expect(invented).toEqual([]);
  });
});

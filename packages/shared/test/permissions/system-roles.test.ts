import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SYSTEM_ROLE,
  IMPLICIT_LEVEL_NONE_ROLES,
  PERMISSIONS,
  SYSTEM_ROLE_KEYS,
  SYSTEM_ROLE_PERMISSIONS,
  isPermissionKey,
  permissionsGrantedByNoRole,
} from '../../src/permissions/index.js';

/**
 * The seven roles every organization starts with, and the two properties that are decisions rather
 * than data. The matrix itself is compared with `permission-model.md` §4 by the repository suite —
 * this file asserts what the matrix has to *mean*.
 */

describe('system roles', () => {
  it('are the seven the model names, and nothing else', () => {
    expect([...SYSTEM_ROLE_KEYS]).toEqual([
      'owner',
      'admin',
      'manager',
      'lead',
      'developer',
      'viewer',
      'guest',
    ]);
    expect(Object.keys(SYSTEM_ROLE_PERMISSIONS).sort()).toEqual([...SYSTEM_ROLE_KEYS].sort());
  });

  /**
   * Ownership is not a large role — it is the absence of a ceiling. Saying so here means no call
   * site needs a special case for it, and the day a permission is added it belongs to the owner
   * without anybody remembering.
   */
  it('give the owner every key in the catalogue', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.owner).toHaveLength(PERMISSIONS.length);
    expect([...SYSTEM_ROLE_PERMISSIONS.owner].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('grant nothing that is not in the catalogue', () => {
    const stray = SYSTEM_ROLE_KEYS.flatMap((role) =>
      SYSTEM_ROLE_PERMISSIONS[role].filter((key) => !isPermissionKey(key)),
    );

    expect(stray).toEqual([]);
  });

  it('list each key once per role', () => {
    const duplicated = SYSTEM_ROLE_KEYS.filter(
      (role) => new Set(SYSTEM_ROLE_PERMISSIONS[role]).size !== SYSTEM_ROLE_PERMISSIONS[role].length,
    );

    expect(duplicated).toEqual([]);
  });

  it('name developer as the role a new member gets, and guest as the one with no implicit access', () => {
    expect(DEFAULT_SYSTEM_ROLE).toBe('developer');
    expect(IMPLICIT_LEVEL_NONE_ROLES).toEqual(['guest']);
  });
});

/**
 * Separation of duties, asserted key by key.
 *
 * The person who hands out access does not see money; the person who runs delivery does not
 * administer the installation. Collapsing the two is how a small team ends up with one omnipotent
 * account — and it happens by accident, one «he needs it just this once» at a time.
 */
describe('the administrator does not see money', () => {
  it.each([
    'employee:view_cost_rate',
    'time:view_cost',
    'project:view_financials',
    'timesheet:approve',
  ])('admin does not hold %s', (key) => {
    expect(SYSTEM_ROLE_PERMISSIONS.admin).not.toContain(key);
  });

  it('admin holds no invoice permission at all', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.admin.filter((key) => key.startsWith('invoice:'))).toEqual([]);
  });

  /** CONTROL: the manager does hold them, so the assertions above are about the split. */
  it.each([
    'employee:view_cost_rate',
    'time:view_cost',
    'project:view_financials',
    'timesheet:approve',
  ])('CONTROL: manager holds %s', (key) => {
    expect(SYSTEM_ROLE_PERMISSIONS.manager).toContain(key);
  });
});

describe('the delivery manager does not administer the installation', () => {
  it.each(['role:create', 'user:suspend', 'integration:connect'])(
    'manager does not hold %s',
    (key) => {
      expect(SYSTEM_ROLE_PERMISSIONS.manager).not.toContain(key);
    },
  );

  it('manager holds no installation setting at all', () => {
    expect(SYSTEM_ROLE_PERMISSIONS.manager.filter((key) => key.startsWith('settings:'))).toEqual([]);
  });

  /** CONTROL: the administrator does, which is what makes the split a split. */
  it.each(['role:create', 'user:suspend', 'integration:connect'])(
    'CONTROL: admin holds %s',
    (key) => {
      expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain(key);
    },
  );
});

describe('the ladder of roles', () => {
  /**
   * Each role from admin down holds fewer keys than the one above it. Not a law of the model — a
   * property of this particular matrix, and a cheap way to notice a row that was ticked in the wrong
   * column: a `viewer` with more keys than a `lead` is a typo nobody would see by reading.
   */
  it('narrows from owner to guest', () => {
    const sizes = SYSTEM_ROLE_KEYS.map((role) => SYSTEM_ROLE_PERMISSIONS[role].length);

    expect(sizes).toEqual([...sizes].sort((left, right) => right - left));
  });

  it('leaves no permission granted by no role', () => {
    expect(permissionsGrantedByNoRole()).toEqual([]);
  });
});

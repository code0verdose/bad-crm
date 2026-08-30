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
      (role) =>
        new Set(SYSTEM_ROLE_PERMISSIONS[role]).size !== SYSTEM_ROLE_PERMISSIONS[role].length,
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
    expect(SYSTEM_ROLE_PERMISSIONS.manager.filter((key) => key.startsWith('settings:'))).toEqual(
      [],
    );
  });

  /** CONTROL: the administrator does, which is what makes the split a split. */
  it.each(['role:create', 'user:suspend', 'integration:connect'])(
    'CONTROL: admin holds %s',
    (key) => {
      expect(SYSTEM_ROLE_PERMISSIONS.admin).toContain(key);
    },
  );
});

interface Rung {
  readonly role: string;
  readonly size: number;
}

/** Every step of the ladder that fails to be *smaller* than the one above it, described. */
const rungsThatDoNotNarrow = (ladder: readonly Rung[]): string[] =>
  ladder.flatMap((rung, index) => {
    const above = ladder[index - 1];

    return above === undefined || rung.size < above.size
      ? []
      : [`${rung.role} holds ${rung.size}, ${above.role} above it holds ${above.size}`];
  });

describe('the ladder of roles', () => {
  /**
   * Each role from admin down holds *strictly* fewer keys than the one above it. Not a law of the
   * model — a property of this particular matrix, and a cheap way to notice a row that was ticked in
   * the wrong column: a `viewer` the size of a `lead` is a typo nobody would see by reading.
   *
   * Measured on 2026-08-30: owner 331, admin 258, manager 241, lead 183, developer 119, viewer 68,
   * guest 20 — seven distinct sizes, every step a drop. So strict narrowing is the property that
   * actually holds, and it is the one asserted. A sorted-order comparison is not: it accepts two
   * roles of equal size, which is precisely what a mis-ticked row looks like.
   */
  it('narrows strictly from owner to guest', () => {
    const ladder = SYSTEM_ROLE_KEYS.map((role) => ({
      role,
      size: SYSTEM_ROLE_PERMISSIONS[role].length,
    }));

    expect(rungsThatDoNotNarrow(ladder)).toEqual([]);
  });

  /** CONTROL: the check rejects the equality a sorted-order comparison used to let through. */
  it('CONTROL: two roles of the same size are a violation', () => {
    expect(
      rungsThatDoNotNarrow([
        { role: 'lead', size: 183 },
        { role: 'developer', size: 183 },
      ]),
    ).toEqual(['developer holds 183, lead above it holds 183']);
  });

  /** CONTROL: and accepts a ladder that does narrow, so it is not simply failing everything. */
  it('CONTROL: a strictly narrowing ladder is clean', () => {
    expect(
      rungsThatDoNotNarrow([
        { role: 'lead', size: 183 },
        { role: 'developer', size: 119 },
      ]),
    ).toEqual([]);
  });

  it('leaves no permission granted by no role', () => {
    expect(permissionsGrantedByNoRole()).toEqual([]);
  });
});

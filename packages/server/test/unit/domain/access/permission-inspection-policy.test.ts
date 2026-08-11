import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import { canInspectPermissions } from '@/domain/iam/access/permission-inspection.policy.js';

/**
 * Who may read **somebody else's** rights, permission by permission, with the origin of each.
 *
 * The key is `permission:override_read` and not `permission:read`, and the distinction is the whole
 * of this file. `permission:read` is the catalogue — the list of things the product has permissions
 * about, identical for every organization and secret from nobody; `manager` holds it so the roles
 * matrix renders. What this screen answers is «what may Ivan do, and who arranged it», which is a
 * statement about a person: their exceptions, the reasons an administrator wrote next to them, and
 * the shape of the organization's administration. `owner` and `admin` hold that one.
 *
 * `permission:explain` is a third question again — «why does Ivan reach *this object*» — and it
 * needs the ACL layer that does not exist yet (STORY-011-06, blocked on EPIC-014).
 */

const SELF = 'admin';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: SELF,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const holding = (...keys: SharedPermissions.PermissionKey[]): Actor =>
  actorWith({ permissions: new Set(keys) });

const CASES = [
  {
    name: 'the capability is enough',
    actor: holding('permission:override_read'),
    expected: { allowed: true, reason: null },
  },
  {
    name: 'the owner reads anybody, on an empty permission set',
    actor: actorWith({ isOwner: true }),
    expected: { allowed: true, reason: null },
  },
  {
    name: 'without the capability, nobody',
    actor: actorWith(),
    expected: { allowed: false, reason: 'permission_not_granted' },
  },
  {
    /**
     * The catalogue is not a person. Somebody who may see which permissions exist has learnt
     * nothing about who holds them — and `manager` holds exactly that key.
     */
    name: 'reading the catalogue is a different question from reading a person',
    actor: holding('permission:read'),
    expected: { allowed: false, reason: 'permission_not_granted' },
  },
  {
    /**
     * Writing and reading are separate keys in the catalogue (§3.3) and both go to `owner` and
     * `admin`. Conflating them here would be this file deciding the catalogue's business.
     */
    name: 'writing exceptions does not imply reading the whole picture',
    actor: holding('permission:override'),
    expected: { allowed: false, reason: 'permission_not_granted' },
  },
  {
    name: 'a DENY exception on the key itself refuses, and says which layer refused',
    actor: actorWith({
      permissions: new Set<SharedPermissions.PermissionKey>(['permission:override_read']),
      denied: new Set<SharedPermissions.PermissionKey>(['permission:override_read']),
    }),
    expected: { allowed: false, reason: 'denied_by_override' },
  },
  {
    /**
     * There is no self-service branch, unlike `canReadProfile`. `GET /me/permissions` is how a
     * person reads their own rights, and it deliberately carries no reasons: the text an
     * administrator wrote next to an exception is a note about somebody, addressed to the people
     * who administer them. Asserted through the caller being the subject — the policy takes no
     * subject at all, which is the strongest form of «self is not special here».
     */
    name: 'one’s own record is not an exemption — /me/permissions is that door',
    actor: actorWith({ userId: SELF }),
    expected: { allowed: false, reason: 'permission_not_granted' },
  },
] as const;

describe('canInspectPermissions()', () => {
  it.each(CASES)('$name', ({ actor, expected }) => {
    expect(canInspectPermissions(actor)).toEqual(expected);
  });

  it('refuses an anonymous caller as unauthenticated rather than unauthorised', () => {
    expect(canInspectPermissions(null)).toEqual({
      allowed: false,
      reason: 'not_authenticated',
    });
  });
});

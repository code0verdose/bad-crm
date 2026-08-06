import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  canAssignRole,
  canRevokeRole,
  type AssignmentSubject,
  type RoleUnderAssignment,
} from '@/domain/iam/access/role-assignment.policy.js';

/**
 * The rules that stop one administrator from becoming all of them.
 *
 * `T-IAM-09` is the threat and it has a shape worth stating: `role:assign` is the widest permission
 * in the catalogue *unless* something bounds what may be assigned, because a role is a bag of every
 * other permission. The bound is the subset rule, and the two lockout rules are what keep the
 * organization recoverable when the bound is respected.
 */

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'assigner',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['role:assign', 'role:revoke']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const role = (overrides: Partial<RoleUnderAssignment> = {}): RoleUnderAssignment => ({
  roleId: 'role-1',
  key: 'manager',
  permissions: ['task:read'],
  ...overrides,
});

const subject = (overrides: Partial<AssignmentSubject> = {}): AssignmentSubject => ({
  userId: 'ivan',
  rolesAfter: ['role-1'],
  ...overrides,
});

describe('handing a role to somebody', () => {
  /**
   * The subset rule is about what the assigner **effectively** holds, and this is the case that
   * makes the difference load-bearing: `actor.permissions` is roles plus ALLOW exceptions and does
   * not subtract the DENY ones. Reading it raw would let a right the organization took away from
   * this person travel to a second account inside a role — after which that account lifts the DENY,
   * because refusing to remove one only applies to one's own.
   */
  it('refuses a role carrying a permission the assigner holds only on paper', () => {
    const restrained = actorWith({
      permissions: new Set(['role:assign', 'task:read']),
      denied: new Set<SharedPermissions.PermissionKey>(['task:read']),
    });

    expect(canAssignRole(restrained, role({ permissions: ['task:read'] }), subject())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('refuses without the capability, before anything else is considered', () => {
    const noRight = actorWith({ permissions: new Set(['role:revoke']) });

    expect(canAssignRole(noRight, role(), subject())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows a role whose permissions the assigner already holds', () => {
    const assigner = actorWith({ permissions: new Set(['role:assign', 'task:read']) });

    expect(canAssignRole(assigner, role({ permissions: ['task:read'] }), subject())).toEqual({
      allowed: true,
      reason: null,
    });
  });

  /**
   * The rule the threat model names. Without it `role:assign` is the only permission anybody needs:
   * find a role that grants what you want and hand it to an account you control.
   */
  it('refuses to hand out a permission the assigner does not have', () => {
    const assigner = actorWith({ permissions: new Set(['role:assign', 'task:read']) });
    const rich = role({ permissions: ['task:read', 'invoice:issue'] });

    expect(canAssignRole(assigner, rich, subject())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('does not apply the subset rule to the owner, who holds everything by definition', () => {
    // An owner's actor carries an *empty* permission set — ownership short-circuits the capability
    // layers rather than enumerating 331 keys — so a naive subset check would refuse the one account
    // that can do everything.
    const owner = actorWith({ isOwner: true, permissions: new Set() });
    const rich = role({ permissions: ['invoice:issue', 'user:impersonate'] });

    expect(canAssignRole(owner, rich, subject())).toEqual({ allowed: true, reason: null });
  });

  it('refuses to grant a role to oneself, subset rule or not', () => {
    const assigner = actorWith({ permissions: new Set(['role:assign', 'task:read']) });

    expect(canAssignRole(assigner, role(), subject({ userId: 'assigner' }))).toEqual({
      allowed: false,
      reason: 'self_assignment_forbidden',
    });
  });

  it('refuses self-assignment for the owner too', () => {
    // The one rule ownership does not lift: it is not about capability but about a second pair of
    // eyes, and the trail showing one person approving their own access reads the same whoever they
    // are.
    const owner = actorWith({ isOwner: true, permissions: new Set() });

    expect(canAssignRole(owner, role(), subject({ userId: 'assigner' }))).toEqual({
      allowed: false,
      reason: 'self_assignment_forbidden',
    });
  });
});

describe('taking a role away', () => {
  it('refuses without the capability', () => {
    const noRight = actorWith({ permissions: new Set(['role:assign']) });

    expect(canRevokeRole(noRight, role(), subject(), 2)).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows an ordinary revocation', () => {
    expect(canRevokeRole(actorWith(), role(), subject(), 2)).toEqual({
      allowed: true,
      reason: null,
    });
  });

  /**
   * The count is of owners **after** the operation, and the use-case takes it inside the same
   * transaction. Counted before, two concurrent revocations both see two owners and the organization
   * ends with none.
   */
  it('refuses to remove the last owner', () => {
    expect(canRevokeRole(actorWith(), role({ key: 'owner' }), subject(), 0)).toEqual({
      allowed: false,
      reason: 'last_owner_required',
    });

    expect(canRevokeRole(actorWith(), role({ key: 'owner' }), subject(), 1)).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('refuses to take away the actor’s own last role', () => {
    const self = subject({ userId: 'assigner', rolesAfter: [] });

    expect(canRevokeRole(actorWith(), role(), self, 2)).toEqual({
      allowed: false,
      reason: 'self_lockout',
    });
  });

  it('allows the actor to drop one of their own roles while another remains', () => {
    const self = subject({ userId: 'assigner', rolesAfter: ['role-2'] });

    expect(canRevokeRole(actorWith(), role(), self, 2)).toEqual({ allowed: true, reason: null });
  });
});

import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  canCreateRole,
  canDeleteRole,
  canUpdateRole,
  dangerousAmong,
  type ActorAfterChange,
  type RoleComposition,
} from '@/domain/iam/access/role-composition.policy.js';

/**
 * Composing a role out of the catalogue — the operation that decides what a bag of permissions may
 * contain before anybody is handed it.
 *
 * The threat is the same as for assignment (`T-IAM-09`) one step earlier: a role nobody holds yet is
 * still a stored capability, and «create a role with `user:impersonate`» followed by any weakness in
 * the assignment rules is a complete escalation. So the subset rule applies at composition time too.
 */

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'role:create',
    'role:update',
    'role:delete',
    'task:read',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const role = (overrides: Partial<RoleComposition> = {}): RoleComposition => ({
  key: 'tech_writer',
  isSystem: false,
  permissions: ['task:read'],
  ...overrides,
});

const after = (overrides: Partial<ActorAfterChange> = {}): ActorAfterChange => ({
  holdsRole: false,
  keptElsewhere: new Set<SharedPermissions.PermissionKey>(),
  ...overrides,
});

describe('creating a role', () => {
  it('refuses without the capability', () => {
    const noRight = actorWith({ permissions: new Set(['role:update']) });

    expect(canCreateRole(noRight, role())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows a role made of what the author already holds', () => {
    expect(canCreateRole(actorWith(), role())).toEqual({ allowed: true, reason: null });
  });

  it('refuses a role containing a permission the author lacks', () => {
    // The escalation this rule exists for: a role nobody holds is still a stored capability.
    expect(canCreateRole(actorWith(), role({ permissions: ['user:impersonate'] }))).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('does not apply the subset rule to the owner', () => {
    const owner = actorWith({ isOwner: true, permissions: new Set() });

    expect(canCreateRole(owner, role({ permissions: ['user:impersonate'] }))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('changing a role', () => {
  it('refuses to touch a system role', () => {
    // Their composition is `SYSTEM_ROLE_PERMISSIONS` and is re-applied on upgrade: an edit here would
    // disappear on the next release, which is worse than a refusal because it looks like it worked.
    expect(canUpdateRole(actorWith(), role({ isSystem: true }), after())).toEqual({
      allowed: false,
      reason: 'system_role_immutable',
    });
  });

  it('allows an ordinary change', () => {
    expect(canUpdateRole(actorWith(), role(), after())).toEqual({ allowed: true, reason: null });
  });

  /**
   * The edit nobody can undo from inside: the actor holds this role, it was their only source of
   * `role:update`, and the change removes it.
   */
  it('refuses to remove the actor’s own last way to edit roles', () => {
    const stripped = role({ permissions: ['task:read'] });

    expect(canUpdateRole(actorWith(), stripped, after({ holdsRole: true }))).toEqual({
      allowed: false,
      reason: 'self_lockout',
    });
  });

  it.each([
    ['role:update', ['role:delete', 'task:read']],
    ['role:delete', ['role:update', 'task:read']],
  ])('refuses when the change removes %s alone', (removed, kept) => {
    // Each key of `GOVERNS_RIGHTS` on its own: every other case in this file strips both at once,
    // and a rule that had lost one of them would still pass all of those.
    const stripped = role({ permissions: kept as SharedPermissions.PermissionKey[] });

    expect(canUpdateRole(actorWith(), stripped, after({ holdsRole: true }))).toEqual({
      allowed: false,
      reason: 'self_lockout',
    });
    expect(removed).toBeTruthy();
  });

  it('allows it when another role still grants the right', () => {
    const stripped = role({ permissions: ['task:read'] });
    const elsewhere = after({
      holdsRole: true,
      keptElsewhere: new Set<SharedPermissions.PermissionKey>(['role:update', 'role:delete']),
    });

    expect(canUpdateRole(actorWith(), stripped, elsewhere)).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('allows deliberate self-restraint on a right that does not govern rights', () => {
    // Narrowing one's own role while somebody else covers the rest is a thing administrators do.
    const stripped = role({ permissions: ['role:update', 'role:delete'] });

    expect(canUpdateRole(actorWith(), stripped, after({ holdsRole: true }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('never locks out the owner, who cannot lose anything', () => {
    const owner = actorWith({ isOwner: true, permissions: new Set() });

    expect(canUpdateRole(owner, role({ permissions: [] }), after({ holdsRole: true }))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('deleting a role', () => {
  it('refuses a system role', () => {
    expect(canDeleteRole(actorWith(), role({ isSystem: true }), after())).toEqual({
      allowed: false,
      reason: 'system_role_immutable',
    });
  });

  it('refuses when it would take the actor’s own last way back', () => {
    expect(canDeleteRole(actorWith(), role(), after({ holdsRole: true }))).toEqual({
      allowed: false,
      reason: 'self_lockout',
    });
  });

  it('allows deleting a role the actor does not hold', () => {
    expect(canDeleteRole(actorWith(), role(), after())).toEqual({ allowed: true, reason: null });
  });
});

describe('a right the organization took away', () => {
  /**
   * The escalation this closes, in full: an administrator under a DENY override composes a role
   * containing the denied key, hands it to a second account they created, and has that account lift
   * the override — refusing to remove a DENY only applies to one's *own*. Every step but the first
   * is allowed by design, so the first one has to refuse.
   */
  const denied = (key: SharedPermissions.PermissionKey): Actor =>
    actorWith({ denied: new Set<SharedPermissions.PermissionKey>([key]) });

  it('cannot be put into a new role by the person it was taken from', () => {
    expect(canCreateRole(denied('task:read'), role({ permissions: ['task:read'] }))).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('cannot be added to an existing one either', () => {
    expect(
      canUpdateRole(denied('task:read'), role({ permissions: ['task:read'] }), after()),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  it('refuses the operation itself when the key it needs is the denied one', () => {
    expect(canUpdateRole(denied('role:update'), role(), after())).toEqual({
      allowed: false,
      reason: 'denied_by_override',
    });
  });

  it('is not a right the lockout rule protects', () => {
    // `role:delete` is denied to this actor, so a change removing it from their own role takes away
    // nothing they could still use — refusing would be refusing on the strength of a right the
    // organization already withdrew. `role:update` stays, so the rule has nothing else to object to.
    const stripped = role({ permissions: ['role:update'] });

    expect(canUpdateRole(denied('role:delete'), stripped, after({ holdsRole: true }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('does not apply to the owner, whose DENY row should not exist at all', () => {
    const owner = actorWith({
      isOwner: true,
      permissions: new Set(),
      denied: new Set<SharedPermissions.PermissionKey>(['task:read']),
    });

    expect(canCreateRole(owner, role({ permissions: ['task:read'] }))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('each operation asks for its own capability', () => {
  it('refuses an edit to somebody who may only create', () => {
    const creator = actorWith({ permissions: new Set(['role:create']) });

    expect(canUpdateRole(creator, role(), after())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('refuses a deletion to somebody who may only edit', () => {
    // Deleting is not «editing hard»: it takes the role away from everybody who held it at once, so
    // it is a separate key and the difference has to be visible here.
    const editor = actorWith({ permissions: new Set(['role:update']) });

    expect(canDeleteRole(editor, role(), after())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('applies the subset rule to an edit, not only to creation', () => {
    // Otherwise the escalation is one step longer and just as complete: create a harmless role, then
    // add `user:impersonate` to it.
    expect(
      canUpdateRole(actorWith(), role({ permissions: ['user:impersonate'] }), after()),
    ).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });
});

describe('the lockout rule in its quieter cases', () => {
  it('does not fire for a right the actor never held', () => {
    // `role:delete` is being removed from the role, and the actor does not hold it anyway: nothing
    // they could do stops being possible, so there is nothing to refuse.
    const narrow = actorWith({ permissions: new Set(['role:update']) });
    const stripped = role({ permissions: ['role:update'] });

    expect(canUpdateRole(narrow, stripped, after({ holdsRole: true }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('never fires for the owner deleting a role they hold', () => {
    const owner = actorWith({ isOwner: true, permissions: new Set() });

    expect(canDeleteRole(owner, role(), after({ holdsRole: true }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('lets an empty composition through the subset rule', () => {
    // The degenerate case the rule has to allow: a role that grants nothing is a role anybody with
    // the capability may create, and `every` over an empty list is vacuously true by design.
    expect(canCreateRole(actorWith(), role({ permissions: [] }))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('which keys need a confirmation', () => {
  it('names the dangerous ones and nothing else', () => {
    expect(dangerousAmong(['task:read', 'user:impersonate', 'role:delete'])).toEqual([
      'user:impersonate',
      'role:delete',
    ]);
  });

  it('CONTROL: the catalogue really marks some keys dangerous', () => {
    // Against a catalogue that marked nothing, the confirmation step would be dead code and the
    // assertion above would pass on an empty intersection.
    expect(dangerousAmong([...SharedPermissions.PERMISSIONS]).length).toBeGreaterThan(10);
  });
});

import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  canRemoveOverride,
  canWriteOverride,
  type OverrideDraft,
  type OverrideSubject,
} from '@/domain/iam/access/permission-override.policy.js';

/**
 * The rules around the one layer that can take a right away.
 *
 * Layer 3 exists so that «custom per user» does not mean forty roles — and it is the layer with the
 * sharpest edges, because a DENY beats everything below it. Three of the four rules here exist to
 * keep an organization administrable by somebody: the owner cannot be denied, the granter cannot
 * hand out what they do not hold, and nobody can deny themselves the right to undo it.
 */

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'permission:override',
    'invoice:issue',
    'role:update',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const draft = (overrides: Partial<OverrideDraft> = {}): OverrideDraft => ({
  permissionKey: 'invoice:issue',
  effect: 'ALLOW',
  ...overrides,
});

const subject = (overrides: Partial<OverrideSubject> = {}): OverrideSubject => ({
  userId: 'ivan',
  isOwner: false,
  ...overrides,
});

describe('writing an exception', () => {
  it('refuses without the capability', () => {
    const noRight = actorWith({ permissions: new Set(['invoice:issue']) });

    expect(canWriteOverride(noRight, draft(), subject())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows an ALLOW for a permission the granter holds', () => {
    expect(canWriteOverride(actorWith(), draft(), subject())).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('refuses to hand out a permission the granter does not hold', () => {
    // Without this rule `permission:override` is the only right anybody needs.
    const limited = actorWith({ permissions: new Set(['permission:override']) });

    expect(canWriteOverride(limited, draft(), subject())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('does not apply the subset rule to the owner, whose actor carries no permissions', () => {
    const owner = actorWith({ isOwner: true, permissions: new Set() });

    expect(canWriteOverride(owner, draft({ permissionKey: 'vault_item:export' }), subject())).toEqual(
      { allowed: true, reason: null },
    );
  });

  it('does not bound a DENY by the subset rule — taking away is not a way to gain', () => {
    const limited = actorWith({ permissions: new Set(['permission:override']) });

    expect(canWriteOverride(limited, draft({ effect: 'DENY' }), subject())).toEqual({
      allowed: true,
      reason: null,
    });
  });

  /**
   * The rule the database repeats with a trigger. One such row makes «the owner cannot be locked
   * out» false, and an organization nobody can administer is not a state any interface can fix.
   */
  it('refuses a DENY aimed at the owner', () => {
    expect(canWriteOverride(actorWith(), draft({ effect: 'DENY' }), subject({ isOwner: true }))).toEqual(
      { allowed: false, reason: 'owner_immutable' },
    );
  });

  it('allows an ALLOW aimed at the owner, which changes nothing but is not dangerous', () => {
    expect(canWriteOverride(actorWith(), draft(), subject({ isOwner: true }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it.each(['permission:override', 'role:update'] as const)(
    'refuses to deny oneself %s',
    (permissionKey) => {
      const self = subject({ userId: 'admin' });

      expect(canWriteOverride(actorWith(), draft({ permissionKey, effect: 'DENY' }), self)).toEqual({
        allowed: false,
        reason: 'self_lockout',
      });
    },
  );

  it('allows deliberate self-restraint on a right that does not govern rights', () => {
    // Denying oneself `invoice:issue` while somebody else covers billing is what this layer is for;
    // a rule that refused every self-DENY would forbid the legitimate case to prevent one bad one.
    const self = subject({ userId: 'admin' });

    expect(canWriteOverride(actorWith(), draft({ effect: 'DENY' }), self)).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('removing an exception', () => {
  it('refuses without the capability', () => {
    const noRight = actorWith({ permissions: new Set([]) });

    expect(canRemoveOverride(noRight, draft(), subject())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows removing somebody else’s exception', () => {
    expect(canRemoveOverride(actorWith(), draft({ effect: 'DENY' }), subject())).toEqual({
      allowed: true,
      reason: null,
    });
  });

  /**
   * The asymmetry worth stating: deleting a DENY on yourself *is* the escalation the DENY was
   * written to prevent, so it is refused as a self-grant rather than as a lockout — different
   * sentence, different remedy («somebody else has to do this»).
   */
  it('refuses to lift a DENY from oneself', () => {
    const self = subject({ userId: 'admin' });

    expect(canRemoveOverride(actorWith(), draft({ effect: 'DENY' }), self)).toEqual({
      allowed: false,
      reason: 'self_assignment_forbidden',
    });
  });

  it('allows removing an ALLOW from oneself, which only narrows access', () => {
    const self = subject({ userId: 'admin' });

    expect(canRemoveOverride(actorWith(), draft(), self)).toEqual({ allowed: true, reason: null });
  });
});

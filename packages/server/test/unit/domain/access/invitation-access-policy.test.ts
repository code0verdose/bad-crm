import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  canInvite,
  canResendInvitation,
  canRevokeInvitation,
  type InvitationDraft,
  type PendingInvitation,
} from '@/domain/iam/access/invitation-access.policy.js';

/**
 * Who may invite somebody, and with what.
 *
 * An invitation is a role assignment written in advance, so it inherits the rule that bounds every
 * other way of handing out rights (`T-IAM-09`): the role in it may only contain what the inviter
 * effectively holds. Without that, «invite» is the widest permission in the product — a way to
 * create an account that can do more than the person who created it, and then sign in as nobody in
 * particular.
 *
 * The three operations are separate keys because they are separate risks: creating one hands out
 * rights, resending one re-opens a door that was closing, revoking one closes it early.
 */

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'invitation:create',
    'invitation:resend',
    'invitation:revoke',
    'user:invite',
    'task:read',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const draft = (overrides: Partial<InvitationDraft> = {}): InvitationDraft => ({
  email: 'ivan@example.test',
  rolePermissions: ['task:read'],
  ...overrides,
});

const pending = (overrides: Partial<PendingInvitation> = {}): PendingInvitation => ({
  acceptedAt: null,
  ...overrides,
});

describe('inviting somebody', () => {
  it('refuses without the capability', () => {
    const noRight = actorWith({ permissions: new Set(['user:invite']) });

    expect(canInvite(noRight, draft())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('allows a role made of what the inviter holds', () => {
    expect(canInvite(actorWith(), draft())).toEqual({ allowed: true, reason: null });
  });

  /**
   * The escalation this exists for: an invitation is an assignment written in advance, and the
   * account it creates would hold rights its author never had.
   */
  it('refuses a role carrying a permission the inviter lacks', () => {
    expect(canInvite(actorWith(), draft({ rolePermissions: ['invoice:issue'] }))).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('counts a right taken away by a personal DENY as not held', () => {
    // The same folding the other three subset rules use: a right the organization withdrew from this
    // person is not theirs to hand to a new account.
    const restrained = actorWith({
      denied: new Set<SharedPermissions.PermissionKey>(['task:read']),
    });

    expect(canInvite(restrained, draft())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('does not apply the subset rule to the owner', () => {
    const owner = actorWith({ isOwner: true, permissions: new Set() });

    expect(canInvite(owner, draft({ rolePermissions: ['user:impersonate'] }))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('allows an invitation with no role at all', () => {
    // «Somebody who can sign in and nothing else» is a legitimate invitation, and the empty subset
    // is vacuously within anybody's rights.
    expect(canInvite(actorWith(), draft({ rolePermissions: [] }))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('reopening and closing an invitation', () => {
  it('needs its own capability to resend', () => {
    const cannot = actorWith({ permissions: new Set(['invitation:create']) });

    expect(canResendInvitation(cannot, pending())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('needs its own capability to revoke', () => {
    const cannot = actorWith({ permissions: new Set(['invitation:create']) });

    expect(canRevokeInvitation(cannot, pending())).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('refuses to touch an invitation that has been accepted', () => {
    // It is not an invitation any more, it is a person. Resending would mint a token to an account
    // that already exists, and revoking would suggest the access can be taken back this way — it
    // cannot; that is deactivation, and a different operation entirely.
    const accepted = pending({ acceptedAt: new Date('2026-08-01T00:00:00Z') });

    expect(canResendInvitation(actorWith(), accepted)).toEqual({
      allowed: false,
      reason: 'invitation_already_accepted',
    });
    expect(canRevokeInvitation(actorWith(), accepted)).toEqual({
      allowed: false,
      reason: 'invitation_already_accepted',
    });
  });

  it('allows both on one that is still open', () => {
    expect(canResendInvitation(actorWith(), pending())).toEqual({ allowed: true, reason: null });
    expect(canRevokeInvitation(actorWith(), pending())).toEqual({ allowed: true, reason: null });
  });
});

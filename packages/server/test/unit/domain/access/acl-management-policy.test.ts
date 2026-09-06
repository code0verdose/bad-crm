import { describe, expect, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';

import { type AclGrantDraft } from '@/domain/access/acl-chain.types.js';
import { canGrantAcl, canReadAcl, canRevokeAcl } from '@/domain/access/acl-management.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';

/**
 * Who may hand out, take away and look at grants on one object — STORY-011-06, acceptance 1, 11
 * and the two refusals that follow from them.
 *
 * All three decisions are the ordinary conjunction: the capability (`acl:*`) **and** the level held
 * on the object the grant is about (`MANAGER` for grant and revoke, `VIEWER` for read — the
 * catalogue's `requiredLevel`). What this file adds on top of `authorize` is the one rule that is
 * specific to *granting*: no locking oneself out. «No wider than one's own level» (acceptance 11)
 * is not a branch of its own — `acl:grant` requires `MANAGER`, the top of the scale, so the
 * conjunction already refuses everyone who could grant wider than they hold; the pin on
 * `requiredLevel` below is what keeps that true if the catalogue is edited.
 */

const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PETR = '018f4a3b-0000-7000-8000-0000000000c2';
const ORG = '018f4a3b-0000-7000-8000-0000000000a1';

const actorWith = (granted: readonly SharedPermissions.PermissionKey[] = []): Actor => ({
  userId: IVAN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

const owner = (): Actor => ({ ...actorWith(), isOwner: true });

const resolved = (level: SharedPermissions.AccessLevel, organizationId = ORG): AclScope => ({
  status: 'resolved',
  organizationId,
  level,
  family: 'standard',
});

const draft = (
  level: SharedPermissions.AccessLevel,
  subject: AclGrantDraft['subject'] = { type: 'USER', id: PETR },
): AclGrantDraft => ({ subject, level });

describe('canGrantAcl — the conjunction', () => {
  it('allows a MANAGER on the object who holds acl:grant', () => {
    expect(canGrantAcl(actorWith(['acl:grant']), resolved('MANAGER'), draft('EDITOR'))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('refuses without the capability, before looking at the object', () => {
    expect(canGrantAcl(actorWith(), resolved('MANAGER'), draft('EDITOR'))).toMatchObject({
      allowed: false,
      reason: 'permission_not_granted',
      permissionKey: 'acl:grant',
    });
  });

  it('refuses an EDITOR on the object: acl:grant requires MANAGER (acceptance 11)', () => {
    expect(
      canGrantAcl(actorWith(['acl:grant']), resolved('EDITOR'), draft('VIEWER')),
    ).toMatchObject({
      allowed: false,
      reason: 'insufficient_acl_level',
    });
  });

  it('answers a missing object with resource_not_found — a 404, never a 403', () => {
    expect(
      canGrantAcl(actorWith(['acl:grant']), { status: 'missing' }, draft('VIEWER')),
    ).toMatchObject({
      allowed: false,
      reason: 'resource_not_found',
    });
  });

  it('answers a reader that failed with acl_resolution_failed — fail-closed, a 503', () => {
    expect(
      canGrantAcl(actorWith(['acl:grant']), { status: 'unavailable' }, draft('VIEWER')),
    ).toMatchObject({ allowed: false, reason: 'acl_resolution_failed' });
  });

  it('answers an object of another organization as not found', () => {
    expect(
      canGrantAcl(actorWith(['acl:grant']), resolved('MANAGER', 'other-org'), draft('VIEWER')),
    ).toMatchObject({ allowed: false, reason: 'tenant_mismatch' });
  });

  it('refuses an explicit NONE on the object even to somebody holding the capability', () => {
    expect(canGrantAcl(actorWith(['acl:grant']), resolved('NONE'), draft('VIEWER'))).toMatchObject({
      allowed: false,
      reason: 'acl_explicit_none',
    });
  });
});

describe('canGrantAcl — no wider than one’s own level', () => {
  /**
   * The rule is carried by the catalogue, not by a branch: `acl:grant` requires `MANAGER`, the top
   * of the scale, so whoever passes the conjunction already holds the widest level and a comparison
   * in the policy would be dead code (the 100 % gate on `domain/access` refuses dead code on
   * purpose). This case is what turns the catalogue entry into a promise — lower `requiredLevel`
   * and it fails, which is the signal to write the comparison into `canGrantAcl`.
   */
  it('is guaranteed by the catalogue: acl:grant requires the top of the scale', () => {
    const { requiredLevel } = SharedPermissions.PERMISSION_META['acl:grant'];
    const top = SharedPermissions.ACCESS_LEVELS.at(-1);

    expect(requiredLevel).toBe(top);
  });

  it('holds for every level the granter could have', () => {
    const levels: SharedPermissions.AccessLevel[] = ['VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER'];

    for (const own of levels) {
      for (const wanted of levels) {
        const decision = canGrantAcl(actorWith(['acl:grant']), resolved(own), draft(wanted));

        expect(decision.allowed, `${own} grants ${wanted}`).toBe(own === 'MANAGER');
      }
    }
  });

  it('lets the owner grant any level, whatever the object says about them', () => {
    // Even an explicit NONE on the owner: the bypass is the model's, not this file's.
    expect(canGrantAcl(owner(), resolved('NONE'), draft('MANAGER'))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('canGrantAcl — no locking oneself out', () => {
  it('refuses a NONE on oneself', () => {
    expect(
      canGrantAcl(
        actorWith(['acl:grant']),
        resolved('MANAGER'),
        draft('NONE', { type: 'USER', id: IVAN }),
      ),
    ).toMatchObject({ allowed: false, reason: 'self_lockout' });
  });

  it('allows a NONE on somebody else', () => {
    expect(canGrantAcl(actorWith(['acl:grant']), resolved('MANAGER'), draft('NONE'))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('allows narrowing oneself to a level that is not NONE — self-restraint is not lockout', () => {
    expect(
      canGrantAcl(
        actorWith(['acl:grant']),
        resolved('MANAGER'),
        draft('VIEWER', { type: 'USER', id: IVAN }),
      ),
    ).toEqual({ allowed: true, reason: null });
  });

  /**
   * A NONE on a team the actor belongs to is *also* a way to lock oneself out, and it is not refused
   * here: the policy does not know the actor's teams, and reading them for this one rule would put a
   * membership query on the path of every grant. The owner is never locked out by construction;
   * everybody else keeps the recourse the model already gives — a closer node, or another manager.
   */
  it('lets the owner put NONE on themselves — nothing can lock the owner out', () => {
    expect(
      canGrantAcl(owner(), resolved('MANAGER'), draft('NONE', { type: 'USER', id: IVAN })),
    ).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('canRevokeAcl', () => {
  it('is the conjunction of acl:revoke and MANAGER on the object', () => {
    expect(canRevokeAcl(actorWith(['acl:revoke']), resolved('MANAGER'))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(canRevokeAcl(actorWith(['acl:revoke']), resolved('EDITOR'))).toMatchObject({
      allowed: false,
      reason: 'insufficient_acl_level',
    });
    expect(canRevokeAcl(actorWith(), resolved('MANAGER'))).toMatchObject({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('answers a missing object with resource_not_found', () => {
    expect(canRevokeAcl(actorWith(['acl:revoke']), { status: 'missing' })).toMatchObject({
      allowed: false,
      reason: 'resource_not_found',
    });
  });
});

describe('canReadAcl', () => {
  it('needs acl:read and VIEWER on the object', () => {
    expect(canReadAcl(actorWith(['acl:read']), resolved('VIEWER'))).toEqual({
      allowed: true,
      reason: null,
    });
    expect(canReadAcl(actorWith(['acl:read']), resolved('NONE'))).toMatchObject({
      allowed: false,
      reason: 'acl_explicit_none',
    });
    expect(canReadAcl(actorWith(), resolved('MANAGER'))).toMatchObject({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('refuses an anonymous caller as not_authenticated', () => {
    expect(canReadAcl(null, resolved('VIEWER'))).toMatchObject({
      allowed: false,
      reason: 'not_authenticated',
    });
  });
});

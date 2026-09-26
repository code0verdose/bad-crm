import { describe, expect, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';

import { type AclGrantDraft } from '@/domain/access/acl-chain.types.js';
import {
  canGrantAcl,
  canReadAcl,
  canRevokeAcl,
  canRevokeAclEntry,
} from '@/domain/access/acl-management.policy.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';

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

/** The grant decision with the membership fact answered up front — `false` unless a case says. */
const grantOf = (
  actor: Actor,
  scope: AclScope,
  grant: AclGrantDraft,
  reachesActor = false,
): Promise<Decision> => canGrantAcl(actor, scope, grant, () => Promise.resolve(reachesActor));

const draft = (
  level: SharedPermissions.AccessLevel,
  subject: AclGrantDraft['subject'] = { type: 'USER', id: PETR },
  expiresAt: Date | null = null,
): AclGrantDraft => ({ subject, level, expiresAt });

const SOON = new Date('2026-10-01T00:00:00.000Z');

describe('canGrantAcl — the conjunction', () => {
  it('allows a MANAGER on the object who holds acl:grant', async () => {
    expect(await grantOf(actorWith(['acl:grant']), resolved('MANAGER'), draft('EDITOR'))).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it('refuses without the capability, before looking at the object', async () => {
    expect(await grantOf(actorWith(), resolved('MANAGER'), draft('EDITOR'))).toMatchObject({
      allowed: false,
      reason: 'permission_not_granted',
      permissionKey: 'acl:grant',
    });
  });

  it('refuses an EDITOR on the object: acl:grant requires MANAGER (acceptance 11)', async () => {
    expect(
      await grantOf(actorWith(['acl:grant']), resolved('EDITOR'), draft('VIEWER')),
    ).toMatchObject({
      allowed: false,
      reason: 'insufficient_acl_level',
    });
  });

  it('answers a missing object with resource_not_found — a 404, never a 403', async () => {
    expect(
      await grantOf(actorWith(['acl:grant']), { status: 'missing' }, draft('VIEWER')),
    ).toMatchObject({
      allowed: false,
      reason: 'resource_not_found',
    });
  });

  it('answers a reader that failed with acl_resolution_failed — fail-closed, a 503', async () => {
    expect(
      await grantOf(actorWith(['acl:grant']), { status: 'unavailable' }, draft('VIEWER')),
    ).toMatchObject({ allowed: false, reason: 'acl_resolution_failed' });
  });

  it('answers an object of another organization as not found', async () => {
    expect(
      await grantOf(actorWith(['acl:grant']), resolved('MANAGER', 'other-org'), draft('VIEWER')),
    ).toMatchObject({ allowed: false, reason: 'tenant_mismatch' });
  });

  it('refuses an explicit NONE on the object even to somebody holding the capability', async () => {
    expect(
      await grantOf(actorWith(['acl:grant']), resolved('NONE'), draft('VIEWER')),
    ).toMatchObject({
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

  it('holds for every level the granter could have', async () => {
    const levels: SharedPermissions.AccessLevel[] = ['VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER'];

    for (const own of levels) {
      for (const wanted of levels) {
        const decision = await grantOf(actorWith(['acl:grant']), resolved(own), draft(wanted));

        expect(decision.allowed, `${own} grants ${wanted}`).toBe(own === 'MANAGER');
      }
    }
  });

  it('lets the owner grant any level, whatever the object says about them', async () => {
    // Even an explicit NONE on the owner: the bypass is the model's, not this file's.
    expect(await grantOf(owner(), resolved('NONE'), draft('MANAGER'))).toEqual({
      allowed: true,
      reason: null,
    });
  });
});

describe('canGrantAcl — no locking oneself out (permission-model.md, «Краевые случаи», 11)', () => {
  /**
   * Case 11 refuses an operation that takes from the actor the right by which rights are governed.
   * On an object that right is `MANAGER` — what `acl:grant` and `acl:revoke` require — and a grant
   * below it that reaches the actor becomes the closest explicit entry for them on this node
   * (resolution rule 1): they hold that level, not `MANAGER`, and can no longer undo it. `NONE` is
   * the extreme of the same thing (rule 2), not a different case.
   *
   * The policy cannot see what else on the node matches the actor, so the refusal is fail-closed:
   * a narrowing that another entry on the same node would have made harmless is refused too, and
   * another manager — or the owner, whom nothing locks out — makes it instead.
   */
  const below = ['NONE', 'VIEWER', 'COMMENTER', 'EDITOR'] as const;

  it.each(below)('refuses %s on the actor’s own USER entry', async (level) => {
    await expect(
      grantOf(
        actorWith(['acl:grant']),
        resolved('MANAGER'),
        draft(level, { type: 'USER', id: IVAN }),
      ),
    ).resolves.toMatchObject({ allowed: false, reason: 'self_lockout' });
  });

  it.each(['ROLE', 'TEAM'] as const)(
    'refuses every level below MANAGER on a %s the actor is part of',
    async (type) => {
      for (const level of below) {
        await expect(
          grantOf(
            actorWith(['acl:grant']),
            resolved('MANAGER'),
            draft(level, { type, id: PETR }),
            true,
          ),
          `${type} ${level}`,
        ).resolves.toMatchObject({ allowed: false, reason: 'self_lockout' });
      }
    },
  );

  it.each(['ROLE', 'TEAM'] as const)(
    'allows the same on a %s the actor is not part of',
    async (type) => {
      await expect(
        grantOf(actorWith(['acl:grant']), resolved('MANAGER'), draft('NONE', { type, id: PETR })),
      ).resolves.toEqual({ allowed: true, reason: null });
    },
  );

  it('allows MANAGER on anything that reaches the actor — the level they need is kept', async () => {
    for (const subject of [
      { type: 'USER', id: IVAN },
      { type: 'ROLE', id: PETR },
      { type: 'TEAM', id: PETR },
    ] as const) {
      await expect(
        grantOf(actorWith(['acl:grant']), resolved('MANAGER'), draft('MANAGER', subject), true),
      ).resolves.toEqual({ allowed: true, reason: null });
    }
  });

  /**
   * A `MANAGER` with a date holds the level only until that date — an expired entry is as if absent
   * (resolution rule 3) — and what the actor falls to then is whatever else matches, which the
   * policy cannot see. The plainest harm is the upsert: the actor's own permanent `MANAGER` row is
   * replaced by one that runs out. So the grant is refused as a level below `MANAGER` would be.
   */
  it.each([
    { name: 'own USER entry', subject: { type: 'USER', id: IVAN }, reaches: false },
    { name: 'a ROLE the actor holds', subject: { type: 'ROLE', id: PETR }, reaches: true },
    { name: 'a TEAM the actor is on', subject: { type: 'TEAM', id: PETR }, reaches: true },
  ] as const)('refuses MANAGER with an expiry on $name', async ({ subject, reaches }) => {
    await expect(
      grantOf(
        actorWith(['acl:grant']),
        resolved('MANAGER'),
        draft('MANAGER', subject, SOON),
        reaches,
      ),
    ).resolves.toMatchObject({ allowed: false, reason: 'self_lockout' });
  });

  it.each([
    { name: 'somebody else', subject: { type: 'USER', id: PETR } },
    { name: 'a TEAM the actor is not on', subject: { type: 'TEAM', id: PETR } },
  ] as const)('allows MANAGER with an expiry on $name', async ({ subject }) => {
    await expect(
      grantOf(actorWith(['acl:grant']), resolved('MANAGER'), draft('MANAGER', subject, SOON)),
    ).resolves.toEqual({ allowed: true, reason: null });
  });

  it('lets the owner give themselves MANAGER with an expiry', async () => {
    await expect(
      grantOf(owner(), resolved('MANAGER'), draft('MANAGER', { type: 'USER', id: IVAN }, SOON)),
    ).resolves.toEqual({ allowed: true, reason: null });
  });

  it('allows narrowing somebody else, NONE included', async () => {
    await expect(
      grantOf(actorWith(['acl:grant']), resolved('MANAGER'), draft('NONE')),
    ).resolves.toEqual({ allowed: true, reason: null });
  });

  it('asks whether a role or a team reaches the actor only when the answer decides something', async () => {
    const asked: string[] = [];
    const reaches = (): Promise<boolean> => {
      asked.push('reaches');

      return Promise.resolve(false);
    };
    const team = { type: 'TEAM', id: PETR } as const;

    // A person is compared by id; MANAGER keeps the level; a refused conjunction and the owner are
    // decided first — none of the four needs the membership read.
    await canGrantAcl(actorWith(['acl:grant']), resolved('MANAGER'), draft('NONE'), reaches);
    await canGrantAcl(
      actorWith(['acl:grant']),
      resolved('MANAGER'),
      draft('MANAGER', team),
      reaches,
    );
    await canGrantAcl(actorWith(), resolved('MANAGER'), draft('NONE', team), reaches);
    await canGrantAcl(owner(), resolved('MANAGER'), draft('NONE', team), reaches);
    expect(asked).toEqual([]);

    await canGrantAcl(
      actorWith(['acl:grant']),
      resolved('MANAGER'),
      draft('EDITOR', team),
      reaches,
    );
    expect(asked).toEqual(['reaches']);
  });

  it('lets the owner narrow themselves — nothing can lock the owner out', async () => {
    await expect(
      grantOf(owner(), resolved('MANAGER'), draft('NONE', { type: 'USER', id: IVAN }), true),
    ).resolves.toEqual({ allowed: true, reason: null });
  });
});

describe('canRevokeAclEntry — no locking oneself out by taking a grant away', () => {
  /**
   * The revocation half of case 11. Removing an entry that reaches the actor can lower their level
   * on the node only when it is a `MANAGER` entry — the node's level is the maximum of what matches
   * (rule 2), so an entry below `MANAGER` was never what held it there. With a `MANAGER` entry gone
   * the level falls to whatever else matches, to the ancestors, or to the implicit level; the policy
   * cannot see which, so it refuses (fail-closed), as for a grant.
   */
  const entry = (
    level: SharedPermissions.AccessLevel,
    subject: AclGrantDraft['subject'] = { type: 'USER', id: IVAN },
  ): AclGrantDraft => ({ subject, level, expiresAt: null });

  const revokeOf = (actor: Actor, grant: AclGrantDraft, reachesActor = false): Promise<Decision> =>
    canRevokeAclEntry(actor, grant, () => Promise.resolve(reachesActor));

  it('refuses taking away the actor’s own MANAGER entry', async () => {
    await expect(revokeOf(actorWith(['acl:revoke']), entry('MANAGER'))).resolves.toMatchObject({
      allowed: false,
      reason: 'self_lockout',
    });
  });

  it.each(['ROLE', 'TEAM'] as const)(
    'refuses taking away a MANAGER entry of a %s the actor is part of',
    async (type) => {
      await expect(
        revokeOf(actorWith(['acl:revoke']), entry('MANAGER', { type, id: PETR }), true),
      ).resolves.toMatchObject({ allowed: false, reason: 'self_lockout' });
    },
  );

  it('allows taking away an entry below MANAGER, even the actor’s own', async () => {
    for (const level of ['NONE', 'VIEWER', 'COMMENTER', 'EDITOR'] as const) {
      await expect(revokeOf(actorWith(['acl:revoke']), entry(level), true), level).resolves.toEqual(
        {
          allowed: true,
          reason: null,
        },
      );
    }
  });

  it('allows taking away somebody else’s MANAGER entry', async () => {
    await expect(
      revokeOf(actorWith(['acl:revoke']), entry('MANAGER', { type: 'USER', id: PETR })),
    ).resolves.toEqual({ allowed: true, reason: null });
    await expect(
      revokeOf(actorWith(['acl:revoke']), entry('MANAGER', { type: 'TEAM', id: PETR })),
    ).resolves.toEqual({ allowed: true, reason: null });
  });

  it('lets the owner take away their own MANAGER entry', async () => {
    await expect(revokeOf(owner(), entry('MANAGER'), true)).resolves.toEqual({
      allowed: true,
      reason: null,
    });
  });
});

/**
 * The two decisions addressed by something other than the object — a grant id, a query — take the
 * scope as a **thunk**, the shape `canReadProject` has: the capability is decided before the object
 * is read at all, so a caller without the key costs no statement and learns nothing from timing or
 * from which of «no such grant» and «not your project» comes back.
 */
const asking = (scope: AclScope) => {
  const asked: string[] = [];

  return {
    asked,
    resolve: (): Promise<AclScope> => {
      asked.push('scope');

      return Promise.resolve(scope);
    },
  };
};

describe('canRevokeAcl', () => {
  it('is the conjunction of acl:revoke and MANAGER on the object', async () => {
    await expect(
      canRevokeAcl(actorWith(['acl:revoke']), asking(resolved('MANAGER')).resolve),
    ).resolves.toEqual({ allowed: true, reason: null });
    await expect(
      canRevokeAcl(actorWith(['acl:revoke']), asking(resolved('EDITOR')).resolve),
    ).resolves.toMatchObject({ allowed: false, reason: 'insufficient_acl_level' });
  });

  it('refuses without acl:revoke and never asks for the object', async () => {
    const scope = asking(resolved('MANAGER'));

    await expect(canRevokeAcl(actorWith(), scope.resolve)).resolves.toMatchObject({
      allowed: false,
      reason: 'permission_not_granted',
    });
    expect(scope.asked).toEqual([]);
  });

  it('answers a missing object with resource_not_found', async () => {
    await expect(
      canRevokeAcl(actorWith(['acl:revoke']), asking({ status: 'missing' }).resolve),
    ).resolves.toMatchObject({ allowed: false, reason: 'resource_not_found' });
  });
});

describe('canReadAcl', () => {
  it('needs acl:read and VIEWER on the object', async () => {
    await expect(
      canReadAcl(actorWith(['acl:read']), asking(resolved('VIEWER')).resolve),
    ).resolves.toEqual({ allowed: true, reason: null });
    await expect(
      canReadAcl(actorWith(['acl:read']), asking(resolved('NONE')).resolve),
    ).resolves.toMatchObject({ allowed: false, reason: 'acl_explicit_none' });
  });

  it('refuses without acl:read and never asks for the object', async () => {
    const scope = asking(resolved('MANAGER'));

    await expect(canReadAcl(actorWith(), scope.resolve)).resolves.toMatchObject({
      allowed: false,
      reason: 'permission_not_granted',
    });
    expect(scope.asked).toEqual([]);
  });

  it('refuses an anonymous caller as not_authenticated', async () => {
    await expect(canReadAcl(null, asking(resolved('VIEWER')).resolve)).resolves.toMatchObject({
      allowed: false,
      reason: 'not_authenticated',
    });
  });
});

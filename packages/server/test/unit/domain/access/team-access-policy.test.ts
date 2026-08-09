import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  assertMemberJoinable,
  canCreateTeam,
  canDeleteTeam,
  canManageTeamMembers,
  canReadTeams,
  canUpdateTeam,
  teamAddressable,
  type TeamScope,
  type TeamSubject,
} from '@/domain/iam/access/team-access.policy.js';
import { ConflictError, NotFoundError } from '@/domain/shared/errors/app.errors.js';

/**
 * What a caller may do to a team — table-driven per `rules/testing.mdc`, 2 (100 % of a policy's
 * branches).
 *
 * Two properties are worth more attention than the capability table, because both are invariants
 * rather than conveniences.
 *
 * **A soft-deleted team is indistinguishable from one that never existed.** `teams.deleted_at` is
 * set rather than the row removed, so the repository can still see it; answering anything but
 * `resource_not_found` would make the API able to say «this id used to be a team here», which is a
 * fact about another organization's data as soon as ids are guessed rather than known.
 *
 * **A suspended account cannot be put on a team.** Offboarding deletes memberships precisely so that
 * a deactivated person is on no team (STORY-012-05); an add path that accepted them would undo that
 * one row at a time, and the refusal is a 409 rather than a 403 because the request is well formed
 * and the fix is to reactivate them first — the same decision `ownership-transfer.policy.ts` makes
 * about a recipient.
 */

const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const TEAM = '018f4a3b-0000-7000-8000-0000000000c2';

const actorWith = (granted: readonly SharedPermissions.PermissionKey[] = []): Actor => ({
  userId: IVAN,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(granted),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

const owner = (): Actor => ({ ...actorWith(), isOwner: true });

const team = (overrides: Partial<TeamScope> = {}): TeamScope => ({
  teamId: TEAM,
  isDeleted: false,
  ...overrides,
});

const subject = (overrides: Partial<TeamSubject> = {}): TeamSubject => ({
  userId: IVAN,
  status: 'ACTIVE',
  ...overrides,
});

const thrown = (fn: () => void): unknown => {
  try {
    fn();

    return undefined;
  } catch (error) {
    return error;
  }
};

describe.each([
  ['canReadTeams', canReadTeams, 'team:read'],
  ['canCreateTeam', canCreateTeam, 'team:create'],
  ['canUpdateTeam', canUpdateTeam, 'team:update'],
  ['canDeleteTeam', canDeleteTeam, 'team:delete'],
  ['canManageTeamMembers', canManageTeamMembers, 'team:manage_members'],
] as const)('%s', (_name, decide, key) => {
  it('CONTROL: allows the holder of the key', () => {
    expect(decide(actorWith([key]))).toEqual({ allowed: true, reason: null });
  });

  it('CONTROL: allows the owner, who holds nothing and may do everything', () => {
    expect(decide(owner())).toEqual({ allowed: true, reason: null });
  });

  it('refuses somebody who holds no key at all', () => {
    expect(decide(actorWith())).toEqual({ allowed: false, reason: 'permission_not_granted' });
  });

  /**
   * The keys are five, not one. A single `team:manage` would make «may rename a team» and «may
   * disband it, deleting every membership» the same grant, which is the point of the catalogue
   * carrying both.
   */
  it('refuses somebody holding a different team key', () => {
    const other = key === 'team:read' ? 'team:delete' : 'team:read';

    expect(decide(actorWith([other]))).toEqual({
      allowed: false,
      reason: 'permission_not_granted',
    });
  });

  it('refuses a DENY override even when a role grants the key', () => {
    const denied: Actor = {
      ...actorWith([key]),
      denied: new Set<SharedPermissions.PermissionKey>([key]),
    };

    expect(decide(denied)).toEqual({ allowed: false, reason: 'denied_by_override' });
  });

  it('refuses an anonymous caller', () => {
    expect(decide(null)).toEqual({ allowed: false, reason: 'not_authenticated' });
  });
});

describe('addressing one team', () => {
  it('CONTROL: a live team of this organization is addressable', () => {
    expect(teamAddressable(team())).toEqual({ allowed: true, reason: null });
  });

  it('answers not-found for a team the repository could not see', () => {
    expect(teamAddressable(null)).toEqual({ allowed: false, reason: 'resource_not_found' });
  });

  it('answers not-found — not a conflict — for a soft-deleted team', () => {
    expect(teamAddressable(team({ isDeleted: true }))).toEqual({
      allowed: false,
      reason: 'resource_not_found',
    });
  });
});

describe('putting somebody on a team', () => {
  it('CONTROL: an active account of this organization may join', () => {
    expect(() => {
      assertMemberJoinable(actorWith(['team:manage_members']), subject());
    }).not.toThrow();
  });

  /**
   * 404 rather than 403: the id names either somebody in another organization or nobody at all, and
   * those two must stay one answer (invariant 2 of CLAUDE.md).
   */
  it('answers 404 for an account the repository could not see', () => {
    const error = thrown(() => {
      assertMemberJoinable(actorWith(['team:manage_members']), null);
    });

    expect(error).toBeInstanceOf(NotFoundError);
    expect((error as NotFoundError).code).toBe('user_not_found');
  });

  it.each(['SUSPENDED', 'INVITED'] as const)(
    'refuses a %s account with a conflict, for a caller who may also read the directory',
    (status) => {
      const error = thrown(() => {
        assertMemberJoinable(actorWith(['team:manage_members', 'user:read']), subject({ status }));
      });

      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).code).toBe('member_not_active');
    },
  );

  /**
   * The gate's L-1. `team:manage_members` says nothing about being allowed to look somebody up in
   * the directory, and `member_not_active` names *which* inactive state the account is in — a fact
   * `user:read` gates everywhere else this application shows it. Without that key the caller gets the
   * same 404 a foreign account gets, for both inactive statuses, instead of the informative 409.
   */
  it.each(['SUSPENDED', 'INVITED'] as const)(
    'answers 404, not 409, for a %s account when the caller may not read the directory',
    (status) => {
      const error = thrown(() => {
        assertMemberJoinable(actorWith(['team:manage_members']), subject({ status }));
      });

      expect(error).toBeInstanceOf(NotFoundError);
      expect((error as NotFoundError).code).toBe('user_not_found');
    },
  );

  /** Ownership short-circuits `holdsEffectively` exactly as it does `authorizeCapability`. */
  it('lets the owner see the informative conflict without holding user:read explicitly', () => {
    const error = thrown(() => {
      assertMemberJoinable(owner(), subject({ status: 'SUSPENDED' }));
    });

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe('member_not_active');
  });
});

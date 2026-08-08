import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  canEditProfile,
  canReadProfile,
  profileAudience,
  seesEmploymentOfOthers,
  SELF_SERVICE_FIELDS,
} from '@/domain/iam/access/employee-access.policy.js';

/**
 * Who may edit which field of whose personnel record, and how much of one anybody sees.
 *
 * Two lines matter, and both are the sort that look like tidying until somebody crosses them:
 *
 *   * **«my own» is not «anybody's».** Fixing your own surname is not fixing a colleague's, and the
 *     second is how a directory gets quietly rewritten;
 *   * **the two audiences are independent in both directions.** Knowing a hiring date is not knowing
 *     a salary: an administrator holds `employee:view_personal_data` without
 *     `employee:view_cost_rate`, and the built-in `manager` holds the second without the first
 *     (`permission-model.md` §4.1, §7). Written as a ladder, the second of those became a caller who
 *     received everything — which is what these cases now pin down.
 */

const ME = 'me';
const COLLEAGUE = 'colleague';

const actorWith = (granted: readonly string[], overrides: Partial<Actor> = {}): Actor => ({
  userId: ME,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set(granted as SharedPermissions.PermissionKey[]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

describe('editing my own record', () => {
  it.each(SELF_SERVICE_FIELDS)('lets anybody change their own %s', (field) => {
    expect(canEditProfile(actorWith([]), ME, [field]).allowed).toBe(true);
  });

  it.each(['jobTitle', 'managerId', 'weeklyCapacityHours', 'employmentType', 'hiredAt'])(
    'refuses %s without employee:update, even on my own record',
    (field) => {
      // Not about trust: these are what planning, cost and the org chart are computed from. A person
      // who sets their own capacity changes what the dashboards say about their team.
      const decision = canEditProfile(actorWith([]), ME, [field]);

      expect(decision.allowed).toBe(false);
      expect(decision.allowed ? null : decision.reason).toBe('permission_not_granted');
    },
  );

  it('refuses the whole edit when one HR field rides along with allowed ones', () => {
    // A silently dropped field would let the form claim it saved something it did not.
    expect(canEditProfile(actorWith([]), ME, ['firstName', 'jobTitle']).allowed).toBe(false);
  });

  it('allows an HR field on my own record with employee:update', () => {
    expect(canEditProfile(actorWith(['employee:update']), ME, ['jobTitle']).allowed).toBe(true);
  });

  it('allows the owner to edit their own employment without holding the capability', () => {
    // Ownership short-circuits the capability layers, so the owner's permission set is empty rather
    // than complete — the branch that would otherwise refuse them their own hiring date.
    expect(
      canEditProfile(actorWith([], { isOwner: true }), ME, ['jobTitle', 'hiredAt']).allowed,
    ).toBe(true);
  });
});

describe('editing somebody else’s record', () => {
  it('needs employee:update even for a name', () => {
    expect(canEditProfile(actorWith([]), COLLEAGUE, ['firstName']).allowed).toBe(false);
  });

  it('is allowed with employee:update', () => {
    expect(canEditProfile(actorWith(['employee:update']), COLLEAGUE, ['jobTitle']).allowed).toBe(
      true,
    );
  });

  it('is allowed for the owner, whose permission set is empty by construction', () => {
    expect(canEditProfile(actorWith([], { isOwner: true }), COLLEAGUE, ['jobTitle']).allowed).toBe(
      true,
    );
  });
});

describe('reading a record', () => {
  it('is always allowed on my own', () => {
    expect(canReadProfile(actorWith([]), ME).allowed).toBe(true);
  });

  it('needs employee:read on somebody else’s', () => {
    expect(canReadProfile(actorWith([]), COLLEAGUE).allowed).toBe(false);
    expect(canReadProfile(actorWith(['employee:read']), COLLEAGUE).allowed).toBe(true);
  });
});

describe('which audiences a caller belongs to', () => {
  it('puts a colleague in neither', () => {
    expect(profileAudience(actorWith(['employee:read']), COLLEAGUE)).toEqual({
      personal: false,
      cost: false,
    });
  });

  it('always puts me in the personal audience for my own record', () => {
    // The dates and the contract type are on my own contract; hiding them from me would be theatre.
    expect(profileAudience(actorWith([]), ME).personal).toBe(true);
  });

  it('puts HR in the personal audience for anybody', () => {
    expect(profileAudience(actorWith(['employee:view_personal_data']), COLLEAGUE).personal).toBe(
      true,
    );
  });

  /**
   * The assertion this file exists for, and the one whose earlier version hid a privilege
   * escalation.
   *
   * It used to assert `profileVisibility(cost-only) === 'cost'` — true, and useless: the value was
   * right while every consumer asked «is it not public?», so the cost audience received the
   * employment half and the decrypted emergency contact. The built-in `manager` holds exactly this
   * capability and not `employee:view_personal_data` (`permission-model.md` §7), so the widest view
   * in the product was reachable by a role the matrix says must not have it.
   *
   * Stated as **two independent facts** now, because that is what they are.
   */
  it('does not let the cost audience buy the personal one', () => {
    expect(profileAudience(actorWith(['employee:view_cost_rate']), COLLEAGUE)).toEqual({
      personal: false,
      cost: true,
    });
  });

  it('does not let the personal audience buy the cost one either', () => {
    expect(
      profileAudience(
        actorWith(['employee:read', 'employee:update', 'employee:view_personal_data']),
        COLLEAGUE,
      ),
    ).toEqual({ personal: true, cost: false });
  });

  it('grants both to somebody holding both', () => {
    expect(
      profileAudience(
        actorWith(['employee:view_personal_data', 'employee:view_cost_rate']),
        COLLEAGUE,
      ),
    ).toEqual({ personal: true, cost: true });
  });
});

describe('what a page of the directory may be ordered by', () => {
  it('refuses an employment order to a colleague', () => {
    expect(seesEmploymentOfOthers(actorWith(['employee:read']))).toBe(false);
  });

  it('refuses it to the cost audience too', () => {
    // The side channel is about the column being *readable*, and a rate is not a hiring date: page
    // through a list ordered by `hiredAt` and you have learnt everybody's, one comparison at a time.
    expect(seesEmploymentOfOthers(actorWith(['employee:view_cost_rate']))).toBe(false);
  });

  it('allows it to HR', () => {
    expect(seesEmploymentOfOthers(actorWith(['employee:view_personal_data']))).toBe(true);
  });

  it('does not grant it merely because the caller has a record of their own', () => {
    // `seesEmploymentOfOthers` asks about *other* people; one's own row is decided per row.
    expect(seesEmploymentOfOthers(actorWith([]))).toBe(false);
  });
});

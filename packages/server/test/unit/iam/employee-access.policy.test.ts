import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import {
  canEditProfile,
  canReadProfile,
  profileAudience,
  seesAccountStatus,
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

/**
 * Who may see whether an account is switched off (STORY-012-09, D4-бис).
 *
 * The barrier is `employee:read` — the right to read somebody else's personnel record at all — or
 * the record being one's own. It was `user:read` until D4-бис, and the two surfaces that carry this
 * one fact then disagreed: the directory row hands `status` to every holder of `employee:read`
 * (STORY-012-04), while the card demanded `user:read`. A custom role or a DENY override holding one
 * and not the other saw the same fact in the list and not on the card, which makes the restriction a
 * nuisance rather than a rule.
 *
 * What the level is **not** is a widening of the personnel audience: `employee:view_personal_data`
 * buys the employment half and answers nothing about whether the person still has a way in. The two
 * still travel independently, and the cases below pin both directions down.
 */
describe('who sees the state of the account', () => {
  const cases = [
    {
      name: 'my own, holding nothing at all',
      actor: actorWith([]),
      subject: ME,
      expected: true,
    },
    {
      name: 'somebody else’s, with employee:read — the same barrier as reading the record',
      actor: actorWith(['employee:read']),
      subject: COLLEAGUE,
      expected: true,
    },
    {
      name: 'somebody else’s, with user:read alone and no employee:read',
      // Reading accounts is not reading personnel records: this caller cannot read the colleague's
      // record at all (`canReadProfile`), so there is no document for the field to travel on.
      actor: actorWith(['user:read']),
      subject: COLLEAGUE,
      expected: false,
    },
    {
      name: 'somebody else’s, holding nothing at all',
      actor: actorWith([]),
      subject: COLLEAGUE,
      expected: false,
    },
    {
      name: 'somebody else’s, with the personnel half and no employee:read',
      // `employee:view_personal_data` buys the employment — contract, dates, capacity — and says
      // nothing about whether the person still has a way in.
      actor: actorWith(['employee:view_personal_data']),
      subject: COLLEAGUE,
      expected: false,
    },
    {
      name: 'somebody else’s, for the owner, whose permission set is empty by construction',
      actor: actorWith([], { isOwner: true }),
      subject: COLLEAGUE,
      expected: true,
    },
    {
      name: 'somebody else’s, when employee:read is taken away by a DENY override',
      // The override is what an organization uses to take one right from one person; reading the
      // granted set directly would treat it as still held.
      actor: actorWith(['employee:read'], {
        denied: new Set<SharedPermissions.PermissionKey>(['employee:read']),
      }),
      subject: COLLEAGUE,
      expected: false,
    },
    {
      name: 'my own, even when employee:read is denied to me',
      actor: actorWith(['employee:read'], {
        denied: new Set<SharedPermissions.PermissionKey>(['employee:read']),
      }),
      subject: ME,
      expected: true,
    },
  ] as const;

  it.each(cases)('$name → $expected', ({ actor, subject, expected }) => {
    expect(seesAccountStatus(actor, subject)).toBe(expected);
  });

  it('is not the same question as the personal audience, in either direction', () => {
    // Written as one, `employee:view_personal_data` would have carried the state of the account and
    // the directory reader would have carried the employment half. Neither implies the other.
    const hr = actorWith(['employee:view_personal_data']);
    const directory = actorWith(['employee:read']);

    expect(profileAudience(hr, COLLEAGUE).personal).toBe(true);
    expect(seesAccountStatus(hr, COLLEAGUE)).toBe(false);
    expect(profileAudience(directory, COLLEAGUE).personal).toBe(false);
    expect(seesAccountStatus(directory, COLLEAGUE)).toBe(true);
  });

  it('travels with the record it describes: every reader of a colleague’s card sees it', () => {
    // The point of D4-бис. `canReadProfile` lets a colleague's record be read on `employee:read`,
    // and the directory row already hands `status` to that same holder — so anybody who can read
    // the document at all now sees the same fact on both surfaces.
    const directory = actorWith(['employee:read']);

    expect(canReadProfile(directory, COLLEAGUE).allowed).toBe(true);
    expect(seesAccountStatus(directory, COLLEAGUE)).toBe(true);
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

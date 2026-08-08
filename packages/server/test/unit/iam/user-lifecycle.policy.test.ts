import { type SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';
import {
  assertDeactivable,
  assertReactivable,
  type DeactivationSubject,
  type ReactivationSubject,
} from '@/domain/iam/access/user-lifecycle.policy.js';

/**
 * The three states an organization must not be able to reach through offboarding.
 *
 * Two of them are **conflicts**, not denials, and the distinction is the reason this is a policy and
 * not a permission check: the caller is allowed to deactivate people and the subject plainly exists.
 * The request is refused because the system is in a state where it cannot be satisfied, and in each
 * case there is a specific next step — transfer ownership, or ask a colleague.
 *
 * The third is a denial, and it is the rule every other way of touching somebody's rights already
 * carries (`T-IAM-09`): **nobody may switch off an account whose permissions they do not hold
 * themselves.** Without it `user:suspend` is the widest permission in the product — one holder can
 * walk the directory and end every other administrator's session, and only the owner can undo it.
 * `role-assignment`, `permission-override`, `role-composition` and `invitation-access` all bound
 * their operation this way; offboarding is the one that reaches further than any of them.
 *
 * None of the three can be a database constraint. «Not yourself» is about the actor, whom the row
 * knows nothing about; «the owner must be transferred first» spans two tables, and a soft delete
 * never fires the foreign key that would otherwise catch it; the subset rule is a question about two
 * folded permission sets, which is not a shape SQL holds.
 */

const ADMIN = '018f4a3b-0000-7000-8000-00000000001a';
const COLLEAGUE = '018f4a3b-0000-7000-8000-00000000002b';

const keys = (...values: SharedPermissions.PermissionKey[]): SharedPermissions.PermissionKey[] =>
  values;

const actorWith = (userId: string, overrides: Partial<Actor> = {}): Actor => ({
  userId,
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['user:suspend']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const subjectWith = (
  userId: string,
  overrides: Partial<DeactivationSubject> = {},
): DeactivationSubject => ({
  userId,
  organizationOwnerId: ADMIN,
  permissions: [],
  denied: [],
  ...overrides,
});

const reactivationSubjectWith = (
  userId: string,
  overrides: Partial<ReactivationSubject> = {},
): ReactivationSubject => ({
  userId,
  permissions: [],
  denied: [],
  ...overrides,
});

const refusalOf = (run: () => void): { code?: string; reason?: string } => {
  try {
    run();
  } catch (error) {
    if (error instanceof AccessRefusedError) return { code: error.code, reason: error.reason };
    if (error instanceof ConflictError) return { code: error.code };

    throw error;
  }

  return {};
};

describe('deactivating somebody else', () => {
  it('CONTROL: is allowed, so the refusals below are about their own reason', () => {
    expect(() =>
      assertDeactivable(actorWith(ADMIN), subjectWith(COLLEAGUE, { organizationOwnerId: ADMIN })),
    ).not.toThrow();
  });
});

describe('deactivating oneself', () => {
  it('is a conflict, whoever the owner is', () => {
    // Not about trust or about permission: an administrator who switches off their own account has
    // removed the person who could switch it back on. `409`, because there is a way forward — ask
    // somebody else — and the code names it.
    expect(() =>
      assertDeactivable(
        actorWith(ADMIN),
        subjectWith(ADMIN, { organizationOwnerId: COLLEAGUE, permissions: keys('user:suspend') }),
      ),
    ).toThrow(ConflictError);
  });

  it('names self_lockout rather than the owner rule, even when both would apply', () => {
    // The owner deactivating themselves trips both. The self rule answers first because it is the
    // one the caller can act on immediately, and «transfer ownership» would be misleading advice to
    // somebody who simply must not do this at all.
    const refusal = refusalOf(() =>
      assertDeactivable(
        actorWith(ADMIN, { isOwner: true }),
        subjectWith(ADMIN, { organizationOwnerId: ADMIN }),
      ),
    );

    expect(refusal.code).toBe('self_lockout');
  });
});

describe('deactivating the owner', () => {
  it('is refused until ownership has been transferred', () => {
    const refusal = refusalOf(() =>
      assertDeactivable(
        actorWith(ADMIN),
        subjectWith(COLLEAGUE, { organizationOwnerId: COLLEAGUE }),
      ),
    );

    // The guard was written in EPIC-006, before the operation existed, precisely so that offboarding
    // could not be implemented without it. This is the call site it was waiting for.
    expect(refusal.code).toBe('last_owner_required');
  });

  it('names the transfer rather than the subset rule, although the owner holds everything', () => {
    // The owner effectively holds every key, so the subset rule below would refuse this too — with
    // advice that leads nowhere. «Transfer ownership first» is the only sentence that describes a
    // way through, so the owner rule is asked first.
    const refusal = refusalOf(() =>
      assertDeactivable(
        actorWith(ADMIN),
        subjectWith(COLLEAGUE, {
          organizationOwnerId: COLLEAGUE,
          permissions: keys('role:update', 'permission:override'),
        }),
      ),
    );

    expect(refusal.code).toBe('last_owner_required');
  });
});

/**
 * The rule this policy was missing, stated as the table the other four state it as.
 *
 * `expected` is the refusal, `null` meaning «goes through». The subject's set is what their roles
 * and ALLOW exceptions grant; `subjectDenied` is their DENY exceptions, folded out exactly the way
 * `holdsEffectively` folds the actor's — a right the organization already took away from this person
 * is not one their offboarding needs to be bounded by.
 */
const subsetCases = [
  {
    name: 'CONTROL: a subject holding nothing at all is offboardable by any suspender',
    actor: keys('user:suspend'),
    actorDenied: [],
    subject: [],
    subjectDenied: [],
    expected: null,
  },
  {
    name: 'a subject whose every key the actor also holds goes through',
    actor: keys('user:suspend', 'role:update'),
    actorDenied: [],
    subject: keys('role:update'),
    subjectDenied: [],
    expected: null,
  },
  {
    name: 'a subject holding one key beyond the actor is refused',
    actor: keys('user:suspend'),
    actorDenied: [],
    subject: keys('role:update'),
    subjectDenied: [],
    expected: 'permission_not_granted',
  },
  {
    name: 'one key beyond the actor is enough, however many they share',
    actor: keys('user:suspend', 'role:update'),
    actorDenied: [],
    subject: keys('role:update', 'permission:override'),
    subjectDenied: [],
    expected: 'permission_not_granted',
  },
  {
    name: 'a key the subject holds only on paper, under their own DENY, does not bound anybody',
    actor: keys('user:suspend'),
    actorDenied: [],
    subject: keys('permission:override'),
    subjectDenied: keys('permission:override'),
    expected: null,
  },
  {
    name: 'a key the actor holds only on paper, under their own DENY, does not count as held',
    // Otherwise the exception the organization wrote about this administrator is a formality: the
    // key is still in `permissions`, and reading the raw set would let them reach past it.
    actor: keys('user:suspend', 'permission:override'),
    actorDenied: keys('permission:override'),
    subject: keys('permission:override'),
    subjectDenied: [],
    expected: 'permission_not_granted',
  },
] as const;

describe('deactivating somebody whose rights the caller does not hold', () => {
  it.each(subsetCases)('$name', ({ actor, actorDenied, subject, subjectDenied, expected }) => {
    const refusal = refusalOf(() =>
      assertDeactivable(
        actorWith(ADMIN, {
          permissions: new Set(actor),
          denied: new Set(actorDenied),
        }),
        subjectWith(COLLEAGUE, {
          organizationOwnerId: ADMIN,
          permissions: [...subject],
          denied: [...subjectDenied],
        }),
      ),
    );

    expect(refusal.reason ?? null).toBe(expected);
  });

  it('answers 403 with the reason the other subset rules answer, not a conflict', () => {
    // `user_forbidden` rather than a conflict code: the state is fine and there is nothing to
    // transfer — this caller simply may not reach this account. The reason travels into the body so
    // the screen can say which of the four refusals it was.
    const refusal = refusalOf(() =>
      assertDeactivable(
        actorWith(ADMIN),
        subjectWith(COLLEAGUE, { permissions: keys('user:impersonate') }),
      ),
    );

    expect(refusal).toEqual({ code: 'user_forbidden', reason: 'permission_not_granted' });
  });

  it('does not bound the owner, whose actor carries an empty set rather than a complete one', () => {
    // Ownership short-circuits the capability layers, so `permissions` on the owner's actor is
    // empty. A naive subset check would refuse the one account that holds everything.
    expect(() =>
      assertDeactivable(
        actorWith(ADMIN, { isOwner: true, permissions: new Set() }),
        subjectWith(COLLEAGUE, {
          permissions: keys('role:update', 'permission:override', 'user:impersonate'),
        }),
      ),
    ).not.toThrow();
  });
});

/**
 * The mirror hole this file was missing: `assertDeactivable` gained the subset rule above because
 * `user:suspend` alone was enough to walk the directory and switch off every other administrator —
 * but a holder of `user:reactivate` alone was still able to bring back **any** suspended account,
 * including one that outranks them and one that was suspended during an incident specifically
 * because it outranked whoever is trying to restore it now
 * (`packages/shared/src/audit/audit-severity.enums.ts`: «an account coming back is the step an
 * intruder needs after an offboarding»). `assertReactivable` closes it with the same rule
 * `assertDeactivable` uses, `T-IAM-09` applied on the way back in rather than only on the way out.
 *
 * No self check and no owner-transfer check here, and that is not an omission: a suspended account
 * cannot authenticate, so nobody can be the actor of their own return, and reactivating a former
 * owner does not touch who owns the organization now — `ReactivateUserUseCase`'s docstring explains
 * both. The subset rule is the one the two operations share, so this suite reuses `subsetCases`
 * rather than restating the table.
 */
describe('reactivating somebody else', () => {
  it('CONTROL: is allowed, so the refusals below are about their own reason', () => {
    expect(() =>
      assertReactivable(actorWith(ADMIN), reactivationSubjectWith(COLLEAGUE)),
    ).not.toThrow();
  });
});

describe('reactivating somebody whose rights the caller does not hold', () => {
  it.each(subsetCases)('$name', ({ actor, actorDenied, subject, subjectDenied, expected }) => {
    const refusal = refusalOf(() =>
      assertReactivable(
        actorWith(ADMIN, {
          permissions: new Set(actor),
          denied: new Set(actorDenied),
        }),
        reactivationSubjectWith(COLLEAGUE, {
          permissions: [...subject],
          denied: [...subjectDenied],
        }),
      ),
    );

    expect(refusal.reason ?? null).toBe(expected);
  });

  it('answers 403 with the same reason the deactivation subset rule answers, not a conflict', () => {
    const refusal = refusalOf(() =>
      assertReactivable(
        actorWith(ADMIN),
        reactivationSubjectWith(COLLEAGUE, { permissions: keys('user:impersonate') }),
      ),
    );

    expect(refusal).toEqual({ code: 'user_forbidden', reason: 'permission_not_granted' });
  });

  it('does not bound the owner, whose actor carries an empty set rather than a complete one', () => {
    expect(() =>
      assertReactivable(
        actorWith(ADMIN, { isOwner: true, permissions: new Set() }),
        reactivationSubjectWith(COLLEAGUE, {
          permissions: keys('role:update', 'permission:override', 'user:impersonate'),
        }),
      ),
    ).not.toThrow();
  });
});

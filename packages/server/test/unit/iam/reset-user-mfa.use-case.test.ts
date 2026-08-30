import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type CapabilityFacts } from '@/application/iam/ports/effective-permissions-reader.port.js';
import { ResetUserMfaUseCase } from '@/application/iam/use-cases/reset-user-mfa.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import {
  ConflictError,
  NotFoundError,
  RateLimitedError,
} from '@/domain/shared/errors/app.errors.js';

import {
  FakeAuditLogger,
  FakeClock,
  FakeMailDispatcher,
  FakeRateLimit,
  FakeSessions,
  FakeUnitOfWork,
  FakeUsers,
} from '../../support/identity-doubles.util.js';
import {
  FakeEffectivePermissionsReader,
  FakeUserRoleRepository,
} from '../../support/iam-doubles.util.js';
import { FakeRecoveryCodes, FakeTotpEnrollment } from '../../support/mfa-doubles.util.js';

const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ADMIN_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const SUBJECT_ID = 'a1e2c3d4-5e6a-4b7c-8d9e-0f1a2b3c4d5f';
const OWNER_ID = 'c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f';
const APP_URL = 'https://crm.example.com';

const NO_CAPABILITIES: CapabilityFacts = {
  isOwner: false,
  granted: [],
  denied: [],
  roleKeys: [],
  permissionsVersion: 1,
};

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: ADMIN_ID,
  organizationId: ORGANIZATION_ID,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['user:reset_mfa']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const buildHarness = (
  options: {
    readonly capabilitiesByUser?: Readonly<Record<string, CapabilityFacts | null>>;
    readonly rateLimitLimits?: Partial<Record<'mfa_admin_reset_attempt', number>>;
  } = {},
) => {
  const clock = new FakeClock();
  const users = new FakeUsers([
    {
      id: SUBJECT_ID,
      email: 'colleague@example.com',
      locale: 'en',
      timezone: 'UTC',
      status: 'ACTIVE',
      permissionsVersion: 1,
    },
    {
      id: OWNER_ID,
      email: 'owner@example.com',
      locale: 'en',
      timezone: 'UTC',
      status: 'ACTIVE',
      permissionsVersion: 1,
    },
  ]);
  const enrollment = new FakeTotpEnrollment();
  const recoveryCodeRows = new FakeRecoveryCodes();
  const sessions = new FakeSessions(clock);
  const userRoles = new FakeUserRoleRepository();
  const permissions = new FakeEffectivePermissionsReader(
    NO_CAPABILITIES,
    options.capabilitiesByUser,
  );
  const rateLimit = new FakeRateLimit(
    options.rateLimitLimits === undefined ? {} : { limits: options.rateLimitLimits },
  );
  const audit = new FakeAuditLogger();
  const dispatcher = new FakeMailDispatcher();
  const unitOfWork = new FakeUnitOfWork();

  const useCase = new ResetUserMfaUseCase(
    unitOfWork,
    users,
    enrollment,
    recoveryCodeRows,
    sessions,
    userRoles,
    permissions,
    rateLimit,
    audit,
    clock,
    dispatcher,
    APP_URL,
  );

  const enableTotp = async (userId: string = SUBJECT_ID): Promise<void> => {
    await enrollment.beginDraft(userId, 'enc:secret', new Date(clock.now().getTime() + 60_000));
    await enrollment.commitEnrollment(userId, 1, clock.now());
  };

  const openSession = (userId: string, familyId: string): void => {
    void sessions.create({
      userId,
      familyId,
      rotatedFromId: null,
      refreshTokenHash: new Uint8Array(),
      userAgent: 'test',
      ipHash: 'hash',
      ipMasked: '203.0.113.0/24',
      expiresAt: new Date(clock.now().getTime() + 3_600_000),
    });
  };

  return {
    useCase,
    users,
    enrollment,
    recoveryCodeRows,
    sessions,
    userRoles,
    permissions,
    rateLimit,
    audit,
    dispatcher,
    unitOfWork,
    enableTotp,
    openSession,
  };
};

describe('resetting a colleague’s 2FA — acceptance 5', () => {
  it('clears the enrolment, deletes recovery codes, revokes every session and bumps the permission version', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.recoveryCodeRows.rows.set('code-1', {
      id: 'code-1',
      userId: SUBJECT_ID,
      codeHash: 'hash',
      usedAt: null,
    });
    harness.openSession(SUBJECT_ID, 'family-1');
    harness.openSession(SUBJECT_ID, 'family-2');

    const result = await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(result).toEqual({
      userId: SUBJECT_ID,
      wasEnabled: true,
      recoveryCodesDeleted: 1,
      sessionsRevoked: 2,
    });

    const state = await harness.enrollment.find(SUBJECT_ID);

    expect(state).toBeNull();
    expect(harness.recoveryCodeRows.rows.size).toBe(0);
    expect(harness.userRoles.versionBumps).toEqual([SUBJECT_ID]);
  });

  it('records user.mfa_reset_by_admin with the counts the operation produced', async () => {
    const harness = buildHarness();

    await harness.enableTotp();
    harness.openSession(SUBJECT_ID, 'family-1');

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_reset_by_admin',
        target: { type: 'USER', id: SUBJECT_ID },
        actor: expect.objectContaining({ userId: ADMIN_ID, organizationId: ORGANIZATION_ID }),
        before: { totpEnabled: true },
        after: { totpEnabled: false, recoveryCodesDeleted: 0, sessionsRevoked: 1 },
      }),
    );
  });

  it('LOW-1: carries the caller’s address on the CRITICAL-severity entry', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: '203.0.113.7',
    });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_reset_by_admin',
        actor: expect.objectContaining({ ipAddress: '203.0.113.7' }),
      }),
    );
  });

  it('notifies the account owner by mail, after the transaction has committed', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    harness.unitOfWork.onScopeClosed = (): void => {
      expect(harness.dispatcher.dispatched).toEqual([]);
    };

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(harness.dispatcher.dispatched).toHaveLength(1);
    expect(harness.dispatcher.dispatched[0]?.mail.to).toBe('colleague@example.com');
  });
});

describe('repeating a reset on an account with no 2FA — MEDIUM-2, a true no-op', () => {
  it('answers wasEnabled: false without touching sessions, the permission version or mail', async () => {
    const harness = buildHarness();

    const result = await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(result).toEqual({
      userId: SUBJECT_ID,
      wasEnabled: false,
      recoveryCodesDeleted: 0,
      sessionsRevoked: 0,
    });
    expect(harness.userRoles.versionBumps).toEqual([]);
    expect(harness.dispatcher.dispatched).toEqual([]);
  });

  it('LOW-2: still writes the trail entry — a no-op reset is not a free oracle on 2FA enrolment', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: '203.0.113.7',
    });

    // The attempt is on record even though nothing else moved: an actor may not learn "this
    // colleague's 2FA is off" by getting silence back with no row anywhere that they asked.
    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.mfa_reset_by_admin',
        target: { type: 'USER', id: SUBJECT_ID },
        actor: expect.objectContaining({
          userId: ADMIN_ID,
          organizationId: ORGANIZATION_ID,
          ipAddress: '203.0.113.7',
        }),
        before: { totpEnabled: false },
        after: { totpEnabled: false, recoveryCodesDeleted: 0, sessionsRevoked: 0 },
      }),
    );
  });

  it('does not revoke a live session that belongs to an account with no 2FA', async () => {
    const harness = buildHarness();

    harness.openSession(SUBJECT_ID, 'family-1');

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    const row = [...harness.sessions.rows.values()].find(
      (session) => session.userId === SUBJECT_ID,
    );

    expect(row?.revokedAt).toBeNull();
  });

  it('is a no-op on every repeat of a loop — MEDIUM-2 attack: revoke-and-mail spam', async () => {
    const harness = buildHarness({ rateLimitLimits: { mfa_admin_reset_attempt: 100 } });

    await harness.enableTotp();
    harness.openSession(SUBJECT_ID, 'family-1');

    // First call really disables 2FA and closes the one session that existed.
    const first = await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(first.wasEnabled).toBe(true);
    expect(harness.dispatcher.dispatched).toHaveLength(1);

    // The victim opens a brand-new session, unrelated to the one the first call closed.
    harness.openSession(SUBJECT_ID, 'family-2');

    // A held permission looped against an account whose 2FA is already off must not touch that new
    // session or send a second mail — the entire point of the fix.
    const second = await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(second.wasEnabled).toBe(false);
    expect(second.sessionsRevoked).toBe(0);
    expect(harness.dispatcher.dispatched).toHaveLength(1);

    const family2 = [...harness.sessions.rows.values()].find(
      (session) => session.userId === SUBJECT_ID && session.familyId === 'family-2',
    );

    expect(family2?.revokedAt).toBeNull();
  });
});

describe('rate limiting an administrative reset — MEDIUM-2', () => {
  it('spends the mfa_admin_reset_attempt budget, keyed on the actor, before the transaction opens', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(harness.rateLimit.consumed).toContainEqual({
      policy: 'mfa_admin_reset_attempt',
      subject: { userId: ADMIN_ID },
    });
  });

  it('refuses the sixth call in the window with 429 rate_limited, and writes nothing', async () => {
    const harness = buildHarness({ rateLimitLimits: { mfa_admin_reset_attempt: 5 } });

    for (let index = 0; index < 5; index += 1) {
      await harness.useCase.execute({
        actor: actorWith(),
        subjectUserId: SUBJECT_ID,
        ipAddress: undefined,
      });
    }

    await expect(
      harness.useCase.execute({
        actor: actorWith(),
        subjectUserId: SUBJECT_ID,
        ipAddress: undefined,
      }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe('HIGH-1: an administrator may not reach further than their own standing', () => {
  it('refuses an admin resetting the organization owner’s 2FA — not_the_owner', async () => {
    const harness = buildHarness({
      capabilitiesByUser: {
        [OWNER_ID]: {
          isOwner: true,
          granted: ['acl:grant', 'audit:export'],
          denied: [],
          roleKeys: ['owner'],
          permissionsVersion: 1,
        },
      },
    });

    await harness.enableTotp(OWNER_ID);
    harness.openSession(OWNER_ID, 'owner-family-1');

    let caught: unknown;

    try {
      await harness.useCase.execute({
        actor: actorWith(),
        subjectUserId: OWNER_ID,
        ipAddress: undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccessRefusedError);
    expect((caught as AccessRefusedError).reason).toBe('not_the_owner');

    // Nothing about the owner's account moved: the secret is intact, the session is live.
    const state = await harness.enrollment.find(OWNER_ID);

    // Stated positively, and about the enrolment rather than about one field of it. The finder
    // answers `null` when there is no enrolment at all, `state?.enabledAt` was then `undefined`,
    // and `not.toBeNull()` passed — a use case that wiped the owner's second factor before
    // refusing satisfied the very assertion written to forbid it.
    expect(state).toMatchObject({ enabledAt: expect.any(Date) });

    const ownerSession = [...harness.sessions.rows.values()].find(
      (session) => session.userId === OWNER_ID,
    );

    expect(ownerSession?.revokedAt).toBeNull();
    expect(harness.audit.events).toEqual([]);
    expect(harness.dispatcher.dispatched).toEqual([]);
  });

  it('refuses an admin against admin: the subject holds a permission the actor does not — T-IAM-09', async () => {
    const harness = buildHarness({
      capabilitiesByUser: {
        [SUBJECT_ID]: {
          isOwner: false,
          granted: ['role:update'],
          denied: [],
          roleKeys: ['admin'],
          permissionsVersion: 1,
        },
      },
    });

    let caught: unknown;

    try {
      await harness.useCase.execute({
        actor: actorWith(),
        subjectUserId: SUBJECT_ID,
        ipAddress: undefined,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AccessRefusedError);
    expect((caught as AccessRefusedError).reason).toBe('permission_not_granted');
    expect(harness.audit.events).toEqual([]);
  });

  it('CONTROL: the same subject goes through once the caller holds that permission too', async () => {
    const harness = buildHarness({
      capabilitiesByUser: {
        [SUBJECT_ID]: {
          isOwner: false,
          granted: ['role:update'],
          denied: [],
          roleKeys: ['admin'],
          permissionsVersion: 1,
        },
      },
    });

    const result = await harness.useCase.execute({
      actor: actorWith({ permissions: new Set(['user:reset_mfa', 'role:update']) }),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(result.userId).toBe(SUBJECT_ID);
  });

  it('answers 404, not a crash, when the subject vanishes between the two reads', async () => {
    const harness = buildHarness({ capabilitiesByUser: { [SUBJECT_ID]: null } });

    await expect(
      harness.useCase.execute({
        actor: actorWith(),
        subjectUserId: SUBJECT_ID,
        ipAddress: undefined,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('lets the owner reset an ordinary colleague’s 2FA', async () => {
    const harness = buildHarness();

    await harness.enableTotp();

    const result = await harness.useCase.execute({
      actor: actorWith({ userId: OWNER_ID, isOwner: true, permissions: new Set() }),
      subjectUserId: SUBJECT_ID,
      ipAddress: undefined,
    });

    expect(result.wasEnabled).toBe(true);
  });
});

describe('refusing a reset targeting the actor’s own account — acceptance 7', () => {
  it('throws self_lockout and writes nothing', async () => {
    const harness = buildHarness();

    await expect(
      harness.useCase.execute({
        actor: actorWith({ userId: SUBJECT_ID }),
        subjectUserId: SUBJECT_ID,
        ipAddress: undefined,
      }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(harness.audit.events).toEqual([]);
  });
});

describe('refusing a subject of another organization — acceptance 9', () => {
  it('answers 404 user_not_found, not 403', async () => {
    const harness = buildHarness();

    await expect(
      harness.useCase.execute({
        actor: actorWith(),
        subjectUserId: 'not-in-this-org',
        ipAddress: undefined,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(harness.audit.events).toEqual([]);
  });
});

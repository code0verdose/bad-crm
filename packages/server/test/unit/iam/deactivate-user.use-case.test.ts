import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type CapabilityFacts } from '@/application/iam/ports/effective-permissions-reader.port.js';
import {
  DeactivateUserUseCase,
  PENDING_OFFBOARDING_STEPS,
} from '@/application/iam/use-cases/deactivate-user.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';

import {
  FakeAuditLogger,
  FakeClock,
  FakeSessions,
  FakeUnitOfWork,
} from '../../support/identity-doubles.util.js';
import {
  FakeEffectivePermissionsReader,
  FakeUserLifecycleRepository,
} from '../../support/iam-doubles.util.js';

const ORGANIZATION_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const ADMIN_ID = 'b3f1c2d4-5e6a-4b7c-8d9e-0f1a2b3c4d5e';
const SUBJECT_ID = 'a1e2c3d4-5e6a-4b7c-8d9e-0f1a2b3c4d5f';
const OWNER_ID = 'c2d3e4f5-6a7b-4c8d-9e0f-1a2b3c4d5e6f';

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
  permissions: new Set<SharedPermissions.PermissionKey>(['user:suspend']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const buildHarness = (
  options: {
    readonly capabilitiesByUser?: Readonly<Record<string, CapabilityFacts | null>>;
  } = {},
) => {
  const clock = new FakeClock();
  const lifecycle = new FakeUserLifecycleRepository();

  lifecycle.rows.set(SUBJECT_ID, {
    userId: SUBJECT_ID,
    status: 'ACTIVE',
    organizationOwnerId: OWNER_ID,
  });

  const sessions = new FakeSessions(clock);
  const permissions = new FakeEffectivePermissionsReader(
    NO_CAPABILITIES,
    options.capabilitiesByUser,
  );
  const audit = new FakeAuditLogger();
  const unitOfWork = new FakeUnitOfWork();

  const useCase = new DeactivateUserUseCase(
    unitOfWork,
    lifecycle,
    sessions,
    permissions,
    audit,
    clock,
  );

  return { useCase, lifecycle, sessions, permissions, audit, unitOfWork, clock };
};

describe('deactivating an already-suspended account — the idempotent branch', () => {
  it('reports alreadyDeactivated without touching sessions or teams', async () => {
    const harness = buildHarness();

    harness.lifecycle.rows.set(SUBJECT_ID, {
      userId: SUBJECT_ID,
      status: 'SUSPENDED',
      organizationOwnerId: OWNER_ID,
    });

    const result = await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      reason: 'repeat offboarding call',
      ipAddress: undefined,
    });

    expect(result).toEqual({
      userId: SUBJECT_ID,
      alreadyDeactivated: true,
      sessionsRevoked: 0,
      teamsLeft: 0,
      pending: PENDING_OFFBOARDING_STEPS,
    });
    expect(harness.lifecycle.suspended).toEqual([]);
  });

  it('still writes a user.suspended trail entry with the caller address — a repeat is not a free oracle on account status', async () => {
    const harness = buildHarness();

    harness.lifecycle.rows.set(SUBJECT_ID, {
      userId: SUBJECT_ID,
      status: 'SUSPENDED',
      organizationOwnerId: OWNER_ID,
    });

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      reason: 'repeat offboarding call',
      ipAddress: '203.0.113.7',
    });

    // A holder of `user:suspend` without `employee:read` has no other way to learn an account's
    // status (`employee-access.policy.ts`'s `seesAccountStatus`) — the response already answers
    // that question on every call, idempotent or not, so the trail is the only place a repeat gets
    // put on record at all.
    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.suspended',
        target: { type: 'USER', id: SUBJECT_ID },
        actor: expect.objectContaining({
          userId: ADMIN_ID,
          organizationId: ORGANIZATION_ID,
          ipAddress: '203.0.113.7',
        }),
        before: { status: 'SUSPENDED' },
      }),
    );
  });

  it('CONTROL: a real offboarding still writes with the same shape', async () => {
    const harness = buildHarness();

    await harness.useCase.execute({
      actor: actorWith(),
      subjectUserId: SUBJECT_ID,
      reason: 'leaving the company',
      ipAddress: '203.0.113.7',
    });

    expect(harness.audit.events).toContainEqual(
      expect.objectContaining({
        action: 'user.suspended',
        before: { status: 'ACTIVE' },
        actor: expect.objectContaining({ ipAddress: '203.0.113.7' }),
      }),
    );
  });
});

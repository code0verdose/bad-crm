import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  type AssignmentDraft,
  type UserRoleRepositoryPort,
} from '@/application/iam/ports/user-role-repository.port.js';
import { AssignRoleUseCase } from '@/application/iam/use-cases/assign-role.use-case.js';
import { RevokeRoleUseCase } from '@/application/iam/use-cases/revoke-role.use-case.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { NotFoundError } from '@/domain/shared/errors/app.errors.js';

/**
 * What the two commands do beyond calling the policy: the order of the checks, what counts as a
 * change, and what the trail ends up saying.
 *
 * The policy itself is proved in `role-assignment-policy.test.ts`; here the subject is the wiring
 * around it, and three of its properties are the kind that pass review and fail in production —
 * a 403 where the answer must be 404, a version bump that never happens so the change takes effect
 * only after the next sign-in, and a trail entry written for an operation that changed nothing.
 */

const ORG = 'org-1';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'role:assign',
    'role:revoke',
    'task:read',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const unitOfWork: UnitOfWorkPort = { withTenant: (_scope, work) => work() };

interface RepositoryState {
  readonly roleExists?: boolean;
  readonly userExists?: boolean;
  readonly roleKey?: string;
  readonly rolePermissions?: SharedPermissions.PermissionKey[];
  readonly held?: string[];
  readonly ownersAfter?: number;
  readonly assignCreated?: boolean;
  readonly revokeRemoved?: boolean;
}

const repositoryWith = (state: RepositoryState = {}) => {
  const assign = vi.fn<(draft: AssignmentDraft) => Promise<{ created: boolean }>>().mockResolvedValue({
    created: state.assignCreated ?? true,
  });
  const revoke = vi.fn<() => Promise<boolean>>().mockResolvedValue(state.revokeRemoved ?? true);
  const bumpPermissionsVersion = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  const repository: UserRoleRepositoryPort = {
    roleFacts: () =>
      Promise.resolve(
        (state.roleExists ?? true)
          ? {
              roleId: 'role-1',
              key: state.roleKey ?? 'manager',
              permissions: state.rolePermissions ?? ['task:read'],
            }
          : null,
      ),
    roleIdsOf: () => Promise.resolve(state.held ?? []),
    userExists: () => Promise.resolve(state.userExists ?? true),
    countHoldersOfKey: () => Promise.resolve(state.ownersAfter ?? 2),
    assign,
    revoke,
    bumpPermissionsVersion,
  };

  return { repository, assign, revoke, bumpPermissionsVersion };
};

const auditSpy = () => {
  const events: AuditEvent[] = [];

  return {
    events,
    port: {
      record: (event: AuditEvent) => {
        events.push(event);

        return Promise.resolve();
      },
    },
  };
};

describe('assigning a role', () => {
  it('writes the assignment, bumps the version and records the key of the role', async () => {
    const { repository, assign, bumpPermissionsVersion } = repositoryWith({});
    const audit = auditSpy();
    const useCase = new AssignRoleUseCase(unitOfWork, repository, audit.port);

    const result = await useCase.execute({
      actor: actorWith(),
      userId: 'ivan',
      roleId: 'role-1',
      expiresAt: null,
    });

    expect(result).toEqual({ created: true });
    expect(assign).toHaveBeenCalledWith({
      userId: 'ivan',
      roleId: 'role-1',
      grantedById: 'admin',
      expiresAt: null,
    });
    expect(bumpPermissionsVersion).toHaveBeenCalledWith('ivan');
    expect(audit.events[0]).toMatchObject({
      action: 'role.assigned',
      target: { type: 'USER_ROLE', id: 'ivan' },
      // The key as well as the id: «role 7f3a…» is unreadable a year later, and the role may be
      // gone by then.
      after: { roleKey: 'manager', roleId: 'role-1' },
    });
  });

  /**
   * Idempotency is not «no error»: it is «nothing happened». A version bump would invalidate every
   * request the person has in flight for no reason, and a trail entry would record an event that
   * did not occur — which is precisely what makes a trail unusable as evidence.
   */
  it('changes nothing when the person already holds the role', async () => {
    const { repository, bumpPermissionsVersion } = repositoryWith({ assignCreated: false });
    const audit = auditSpy();
    const useCase = new AssignRoleUseCase(unitOfWork, repository, audit.port);

    const result = await useCase.execute({
      actor: actorWith(),
      userId: 'ivan',
      roleId: 'role-1',
      expiresAt: null,
    });

    expect(result).toEqual({ created: false });
    expect(bumpPermissionsVersion).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });

  it.each([
    ['the role', { roleExists: false }],
    ['the person', { userExists: false }],
  ])('answers 404 when %s is not in this organization', async (_what, state) => {
    const { repository } = repositoryWith(state);
    const useCase = new AssignRoleUseCase(unitOfWork, repository, auditSpy().port);

    const failing = useCase.execute({
      actor: actorWith(),
      userId: 'ivan',
      roleId: 'role-1',
      expiresAt: null,
    });

    // Not 403: that answer would confirm the id exists in an organization the caller cannot see.
    await expect(failing).rejects.toBeInstanceOf(NotFoundError);
    await expect(failing).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to hand out a permission the assigner lacks, and writes nothing', async () => {
    const { repository, assign } = repositoryWith({ rolePermissions: ['invoice:issue'] });
    const audit = auditSpy();
    const useCase = new AssignRoleUseCase(unitOfWork, repository, audit.port);

    const failing = useCase.execute({
      actor: actorWith(),
      userId: 'ivan',
      roleId: 'role-1',
      expiresAt: null,
    });

    await expect(failing).rejects.toBeInstanceOf(AccessRefusedError);
    expect(assign).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });
});

describe('revoking a role', () => {
  it('removes it, bumps the version and records what stopped existing', async () => {
    const { repository, revoke, bumpPermissionsVersion } = repositoryWith({ held: ['role-1'] });
    const audit = auditSpy();
    const useCase = new RevokeRoleUseCase(unitOfWork, repository, audit.port);

    const result = await useCase.execute({
      actor: actorWith(),
      userId: 'ivan',
      roleId: 'role-1',
    });

    expect(result).toEqual({ removed: true });
    expect(revoke).toHaveBeenCalledWith('ivan', 'role-1');
    expect(bumpPermissionsVersion).toHaveBeenCalledWith('ivan');
    expect(audit.events[0]).toMatchObject({
      action: 'role.revoked',
      // `before`, because what the trail must preserve is the state that is gone.
      before: { roleKey: 'manager', roleId: 'role-1' },
    });
  });

  it('is not an error when the person did not hold it', async () => {
    const { repository, bumpPermissionsVersion } = repositoryWith({ revokeRemoved: false });
    const audit = auditSpy();
    const useCase = new RevokeRoleUseCase(unitOfWork, repository, audit.port);

    expect(await useCase.execute({ actor: actorWith(), userId: 'ivan', roleId: 'role-1' })).toEqual({
      removed: false,
    });
    expect(bumpPermissionsVersion).not.toHaveBeenCalled();
    expect(audit.events).toEqual([]);
  });

  it.each([
    ['the role', { roleExists: false }],
    ['the person', { userExists: false }],
  ])('answers 404 when %s is not in this organization', async (_what, state) => {
    const { repository, revoke } = repositoryWith(state);
    const useCase = new RevokeRoleUseCase(unitOfWork, repository, auditSpy().port);

    const failing = useCase.execute({ actor: actorWith(), userId: 'ivan', roleId: 'role-1' });

    await expect(failing).rejects.toMatchObject({ status: 404 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('refuses to take away the actor’s own last role', async () => {
    // The state nobody can undo from inside: the person who could put it back is the person who just
    // lost the right to.
    const { repository, revoke } = repositoryWith({ held: ['role-1'] });
    const useCase = new RevokeRoleUseCase(unitOfWork, repository, auditSpy().port);

    const failing = useCase.execute({ actor: actorWith(), userId: 'admin', roleId: 'role-1' });

    await expect(failing).rejects.toMatchObject({ code: 'self_lockout', status: 409 });
    expect(revoke).not.toHaveBeenCalled();
  });

  it('refuses to remove the last owner', async () => {
    const { repository, revoke } = repositoryWith({ roleKey: 'owner', ownersAfter: 0 });
    const useCase = new RevokeRoleUseCase(unitOfWork, repository, auditSpy().port);

    const failing = useCase.execute({ actor: actorWith(), userId: 'ivan', roleId: 'role-1' });

    await expect(failing).rejects.toMatchObject({ code: 'last_owner_required', status: 409 });
    expect(revoke).not.toHaveBeenCalled();
  });

  /**
   * The count that decides it is taken inside the transaction and *after* the subject is excluded —
   * «how many owners would be left», not «how many are there». Asserted through the argument the
   * use-case passes, because the difference between the two questions is invisible in the result.
   */
  it('asks how many owners would remain, excluding the subject', async () => {
    const countHoldersOfKey = vi.fn<() => Promise<number>>().mockResolvedValue(1);
    const { repository } = repositoryWith({ roleKey: 'owner' });
    const useCase = new RevokeRoleUseCase(
      unitOfWork,
      { ...repository, countHoldersOfKey },
      auditSpy().port,
    );

    await useCase.execute({ actor: actorWith(), userId: 'ivan', roleId: 'role-1' });

    expect(countHoldersOfKey).toHaveBeenCalledWith('owner', 'ivan');
  });
});

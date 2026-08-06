import { SharedPermissions } from '@bad-crm/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { ListRolesQuery } from '@/application/iam/use-cases/list-roles.query.js';
import { DeleteCustomRoleUseCase } from '@/application/iam/use-cases/delete-custom-role.use-case.js';
import { UpdateCustomRoleUseCase } from '@/application/iam/use-cases/write-custom-role.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { ConfirmationRequiredError, NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeCustomRoleRepository } from '../../support/iam-doubles.util.js';
import { FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * The two commands where the actor is inside the change they are making.
 *
 * The policy is proved in `role-composition-policy.test.ts` and the endpoints in
 * `custom-role-endpoints.test.ts`; what is left here is the wiring the other two cannot reach,
 * because it depends on the actor's own id appearing among the holders of the role:
 *
 *   * **what the actor keeps elsewhere is read, not assumed.** If the command skipped that read, the
 *     lockout rule would refuse every self-edit — including the ones another role covers;
 *   * **the confirmation applies to an edit too.** Otherwise «create harmless, then add
 *     `user:impersonate`» stores a dangerous key without anybody being asked.
 */

const ORG = 'org-1';
const ROLE_ID = 'role-1';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'role:create',
    'role:update',
    'role:delete',
    'user:impersonate',
    'task:read',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

/**
 * The real double, which **records** the scope it was opened with.
 *
 * A passthrough would run the work and discard the scope, and then «this command opens the tenant of
 * its actor» — the first invariant of the project — would be an assertion nobody makes: an
 * organization id taken from somewhere else is a cross-tenant read that no test would notice.
 */
let unitOfWork: FakeUnitOfWork;

beforeEach(() => {
  unitOfWork = new FakeUnitOfWork();
});

const scopeOfActor = [{ organizationId: ORG, userId: 'admin' }];

const auditSpy = (): {
  events: AuditEvent[];
  port: { record: (e: AuditEvent) => Promise<void> };
} => {
  const events: AuditEvent[] = [];

  return {
    events,
    port: {
      record: (event: AuditEvent): Promise<void> => {
        events.push(event);

        return Promise.resolve();
      },
    },
  };
};

/** A role the actor holds themselves, which is the only state these tests are about. */
const heldByActor = (
  elsewhere: readonly string[] = [],
  options: { readonly vanishesBeforeUpdate?: boolean } = {},
): FakeCustomRoleRepository => {
  const repository = new FakeCustomRoleRepository({ elsewhere, ...options });

  repository.roles.set(ROLE_ID, {
    roleId: ROLE_ID,
    key: 'tech_writer',
    name: 'Technical writer',
    isSystem: false,
    permissions: ['role:update', 'role:delete', 'task:read'],
  });
  repository.holders.set(ROLE_ID, ['admin', 'ivan']);

  return repository;
};

describe('deleting a role the actor holds', () => {
  it('allows it when another role still grants the right to edit roles', async () => {
    const roles = heldByActor(['role:update', 'role:delete']);
    const useCase = new DeleteCustomRoleUseCase(unitOfWork, roles, auditSpy().port);

    await useCase.execute({ actor: actorWith(), roleId: ROLE_ID });

    expect(roles.roles.size).toBe(0);
    // Everybody who held it, the actor included: the permissions are gone at this instant, so the
    // loss has to apply on their next request rather than at their next sign-in.
    expect(roles.versionBumps).toEqual(['admin', 'ivan']);
    expect(unitOfWork.scopes).toEqual(scopeOfActor);
  });

  it('records the composition that no longer exists to be looked up', async () => {
    const roles = heldByActor(['role:update', 'role:delete']);
    const audit = auditSpy();

    await new DeleteCustomRoleUseCase(unitOfWork, roles, audit.port).execute({
      actor: actorWith(),
      roleId: ROLE_ID,
    });

    // «Role 7f3a… deleted» is unreadable a year later, and the role it names is exactly the thing
    // that no longer exists to be looked up — so the trail carries the composition, not the id.
    expect(audit.events).toEqual([
      {
        action: 'role.deleted',
        actor: { userId: 'admin', organizationId: ORG, ipAddress: undefined },
        target: { type: 'ROLE', id: ROLE_ID },
        before: {
          key: 'tech_writer',
          name: 'Technical writer',
          permissions: ['role:update', 'role:delete', 'task:read'],
          holders: 2,
        },
        requestId: undefined,
      },
    ]);
  });

  it('refuses when it would take away the actor’s own last way back', async () => {
    const roles = heldByActor();
    const useCase = new DeleteCustomRoleUseCase(unitOfWork, roles, auditSpy().port);

    await expect(useCase.execute({ actor: actorWith(), roleId: ROLE_ID })).rejects.toBeInstanceOf(
      AccessRefusedError,
    );
    expect(roles.roles.size).toBe(1);
  });
});

describe('reading the roles', () => {
  it('opens the tenant of the actor and nothing else', async () => {
    const roles = heldByActor();

    await new ListRolesQuery(unitOfWork, roles).execute({ actor: actorWith() });

    // The whole answer is «every role of this tenant», so the scope *is* the authorization: an
    // organization id from anywhere but the actor would be somebody else's roles.
    expect(unitOfWork.scopes).toEqual(scopeOfActor);
  });
});

describe('editing a role', () => {
  it('records both compositions, whole rather than as a delta', async () => {
    const roles = heldByActor(['role:update', 'role:delete']);
    const audit = auditSpy();

    await new UpdateCustomRoleUseCase(unitOfWork, roles, audit.port).execute({
      actor: actorWith(),
      roleId: ROLE_ID,
      name: 'Writer',
      description: null,
      permissions: ['task:read'],
      confirmedDangerous: false,
    });

    expect(unitOfWork.scopes).toEqual(scopeOfActor);
    // Both sets in full: «what did this role grant» has to be answerable from one entry, and a delta
    // forces a reader to replay the history to find out.
    expect(audit.events).toEqual([
      {
        action: 'role.updated',
        actor: { userId: 'admin', organizationId: ORG, ipAddress: undefined },
        target: { type: 'ROLE', id: ROLE_ID },
        before: {
          key: 'tech_writer',
          name: 'Technical writer',
          permissions: ['role:update', 'role:delete', 'task:read'],
        },
        after: { key: 'tech_writer', name: 'Writer', permissions: ['task:read'] },
        requestId: undefined,
      },
    ]);
  });

  it('does not invalidate anybody for a rename', async () => {
    const roles = heldByActor(['role:update', 'role:delete']);
    const audit = auditSpy();

    await new UpdateCustomRoleUseCase(unitOfWork, roles, audit.port).execute({
      actor: actorWith(),
      roleId: ROLE_ID,
      name: 'Writers',
      description: null,
      // The same set in a different order: nobody's rights moved.
      permissions: ['task:read', 'role:delete', 'role:update'],
      // The composition already contained a dangerous key; storing it again asks for the same
      // confirmation, because the request is judged by what it stores, not by what it changes.
      confirmedDangerous: true,
    });

    // A bump answers 401 to every holder at once and sends them all into refresh together — a load
    // spike on the most sensitive endpoint, and here it would buy nothing.
    expect(roles.versionBumps).toEqual([]);
    // And nothing was granted, so «somebody stored a dangerous key» must not appear in the trail.
    expect(audit.events.map((event) => event.action)).toEqual(['role.updated']);
  });

  it('invalidates the holders when the composition really moves', async () => {
    const roles = heldByActor(['role:update', 'role:delete']);

    await new UpdateCustomRoleUseCase(unitOfWork, roles, auditSpy().port).execute({
      actor: actorWith(),
      roleId: ROLE_ID,
      name: 'Writer',
      description: null,
      permissions: ['task:read'],
      confirmedDangerous: false,
    });

    expect(roles.versionBumps).toEqual(['admin', 'ivan']);
  });

  it('answers «not there» when the role is deleted between the read and the write', async () => {
    // Writing the grants anyway would either violate the foreign key — a 500 for what is a 404 — or,
    // for an empty composition, succeed silently and file a trail entry about a role that is gone.
    const roles = heldByActor(['role:update', 'role:delete'], { vanishesBeforeUpdate: true });
    const audit = auditSpy();

    await expect(
      new UpdateCustomRoleUseCase(unitOfWork, roles, audit.port).execute({
        actor: actorWith(),
        roleId: ROLE_ID,
        name: 'Writer',
        description: null,
        permissions: ['task:read'],
        confirmedDangerous: false,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.events).toEqual([]);
  });

  it('asks for a confirmation before storing something dangerous', async () => {
    const roles = heldByActor(['role:update', 'role:delete']);
    const useCase = new UpdateCustomRoleUseCase(unitOfWork, roles, auditSpy().port);

    const input = {
      actor: actorWith(),
      roleId: ROLE_ID,
      name: 'Support',
      description: null,
      permissions: ['user:impersonate'] as SharedPermissions.PermissionKey[],
      confirmedDangerous: false,
    };

    await expect(useCase.execute(input)).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(roles.roles.get(ROLE_ID)?.permissions).toEqual([
      'role:update',
      'role:delete',
      'task:read',
    ]);

    await useCase.execute({ ...input, confirmedDangerous: true });

    expect(roles.roles.get(ROLE_ID)?.permissions).toEqual(['user:impersonate']);
  });
});

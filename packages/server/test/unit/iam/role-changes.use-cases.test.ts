import { SharedPermissions } from '@bad-crm/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  ApplyRoleChangesUseCase,
  PreviewRoleChangesQuery,
} from '@/application/iam/use-cases/write-role-changes.use-case.js';
import { type AuditEvent } from '@/application/platform/ports/audit-logger.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { ConfirmationRequiredError, NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeCustomRoleRepository } from '../../support/iam-doubles.util.js';
import { FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * The draft of the administration matrix, previewed and saved.
 *
 * Two properties carry the story, and neither is visible one change at a time:
 *
 *   * **all of it or none of it.** Eleven changes of twelve landing leaves the screen describing a
 *     state that exists nowhere, and the administrator with no way to tell which is which;
 *   * **the preview and the save agree**, because they judge with the same policy over the same
 *     read. A summary computed anywhere else is a second opinion, and the one that disagrees is the
 *     one the administrator reads.
 */

const ORG = 'org-1';
const WRITERS = 'role-1';
const AUDITORS = 'role-2';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>([
    'role:read',
    'role:update',
    'role:delete',
    'task:read',
    'task:update',
    'user:impersonate',
  ]),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

let unitOfWork: FakeUnitOfWork;
let audit: { events: AuditEvent[]; port: { record: (event: AuditEvent) => Promise<void> } };

const auditSpy = (): typeof audit => {
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

const twoRoles = (options: { readonly heldByActor?: boolean } = {}): FakeCustomRoleRepository => {
  const repository = new FakeCustomRoleRepository();

  repository.roles.set(WRITERS, {
    roleId: WRITERS,
    key: 'tech_writer',
    name: 'Technical writer',
    description: null,
    isSystem: false,
    permissions: ['task:read'],
  });
  repository.roles.set(AUDITORS, {
    roleId: AUDITORS,
    key: 'auditor',
    name: 'Auditor',
    description: null,
    isSystem: false,
    permissions: ['task:read'],
  });
  repository.holders.set(WRITERS, options.heldByActor === true ? ['admin', 'ivan'] : ['ivan']);
  repository.holders.set(AUDITORS, ['petr']);

  return repository;
};

beforeEach(() => {
  unitOfWork = new FakeUnitOfWork();
  audit = auditSpy();
});

describe('previewing a draft', () => {
  it('reports what each change does and how many people it reaches', async () => {
    const roles = twoRoles();

    const outcomes = await new PreviewRoleChangesQuery(unitOfWork, roles).execute({
      actor: actorWith(),
      changes: [
        { roleId: WRITERS, permissions: ['task:read', 'task:update'] },
        { roleId: AUDITORS, permissions: [] },
      ],
    });

    expect(outcomes).toMatchObject([
      {
        roleId: WRITERS,
        key: 'tech_writer',
        name: 'Technical writer',
        isSystem: false,
        holderCount: 1,
        added: ['task:update'],
        removed: [],
        reason: null,
      },
      { roleId: AUDITORS, holderCount: 1, added: [], removed: ['task:read'], reason: null },
    ]);
    // A preview writes nothing: an abandoned draft costs a query and no rows.
    expect(roles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);
    expect(roles.versionBumps).toEqual([]);
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: 'admin' }]);
  });

  it('names the refusal instead of hiding the change', async () => {
    const roles = twoRoles();

    roles.roles.set(AUDITORS, {
      roleId: AUDITORS,
      key: 'manager',
      name: 'Manager',
      description: null,
      isSystem: true,
      permissions: ['task:read'],
    });

    const outcomes = await new PreviewRoleChangesQuery(unitOfWork, roles).execute({
      actor: actorWith(),
      changes: [
        { roleId: WRITERS, permissions: ['task:read', 'task:update'] },
        { roleId: AUDITORS, permissions: [] },
      ],
    });

    // The screen greys the cell out **because** it knows why, and it learned it from the same policy
    // that would have refused the save.
    expect(outcomes.map((outcome) => outcome.reason)).toEqual([null, 'system_role_immutable']);
  });

  it('reads a role nobody holds as reaching nobody', async () => {
    // `groupBy` leaves a role with no assignments out of its result entirely, so «zero holders» is
    // an absent row rather than a zero — and the screen shows «0 people» either way.
    const roles = twoRoles();

    roles.holders.set(AUDITORS, []);

    const outcomes = await new PreviewRoleChangesQuery(unitOfWork, roles).execute({
      actor: actorWith(),
      changes: [{ roleId: AUDITORS, permissions: [] }],
    });

    expect(outcomes[0]).toMatchObject({ roleId: AUDITORS, holderCount: 0 });
  });

  it('answers 404 for a role of another organization, for the whole draft', async () => {
    const roles = twoRoles();

    await expect(
      new PreviewRoleChangesQuery(unitOfWork, roles).execute({
        actor: actorWith(),
        changes: [{ roleId: 'role-of-another-org', permissions: [] }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('saving a draft', () => {
  const apply = (roles: FakeCustomRoleRepository): ApplyRoleChangesUseCase =>
    new ApplyRoleChangesUseCase(unitOfWork, roles, audit.port);

  it('applies every change and invalidates the holders of each role that moved', async () => {
    const roles = twoRoles();

    await apply(roles).execute({
      actor: actorWith(),
      changes: [
        { roleId: WRITERS, permissions: ['task:read', 'task:update'] },
        { roleId: AUDITORS, permissions: [] },
      ],
    });

    expect(roles.roles.get(WRITERS)?.permissions).toEqual(['task:read', 'task:update']);
    expect(roles.roles.get(AUDITORS)?.permissions).toEqual([]);
    expect(roles.versionBumps).toEqual(['ivan', 'petr']);
    expect(audit.events.map((event) => event.action)).toEqual(['role.updated', 'role.updated']);
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: 'admin' }]);
  });

  it('applies nothing when one change is refused', async () => {
    const roles = twoRoles();

    roles.roles.set(AUDITORS, {
      roleId: AUDITORS,
      key: 'manager',
      name: 'Manager',
      description: null,
      isSystem: true,
      permissions: ['task:read'],
    });

    await expect(
      apply(roles).execute({
        actor: actorWith(),
        changes: [
          { roleId: WRITERS, permissions: ['task:read', 'task:update'] },
          { roleId: AUDITORS, permissions: [] },
        ],
      }),
    ).rejects.toBeInstanceOf(AccessRefusedError);

    // The good change is not applied either — «eleven of twelve» is the outcome this refuses.
    expect(roles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);
    expect(roles.versionBumps).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('touches nobody for a change that moves nothing', async () => {
    // A cell clicked twice. Nobody's rights moved, so nobody is invalidated and the trail records
    // no change — a bump here would answer 401 to every holder for nothing.
    const roles = twoRoles();

    await apply(roles).execute({
      actor: actorWith(),
      changes: [{ roleId: WRITERS, permissions: ['task:read'] }],
    });

    expect(roles.versionBumps).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('asks for a confirmation once for the whole draft', async () => {
    const roles = twoRoles();
    const draft = {
      actor: actorWith(),
      changes: [
        { roleId: WRITERS, permissions: ['task:read', 'user:impersonate'] as const },
        { roleId: AUDITORS, permissions: ['user:impersonate'] as const },
      ],
    };

    await expect(apply(roles).execute(draft)).rejects.toBeInstanceOf(ConfirmationRequiredError);
    expect(roles.roles.get(WRITERS)?.permissions).toEqual(['task:read']);

    await apply(roles).execute({ ...draft, confirmedDangerous: true });

    // Two roles gained the key, so two critical entries — one per role, because that is what a
    // reader filters by later.
    expect(audit.events.filter((event) => event.action === 'role.dangerous_granted')).toHaveLength(
      2,
    );
  });

  it('keeps the description of a role whose composition changed', async () => {
    // The composition is what this operation edits; the prose beside it belongs to whoever wrote it,
    // and the trail records the keys — so an erased description would be invisible as well as lost.
    const roles = twoRoles();

    roles.roles.set(WRITERS, {
      roleId: WRITERS,
      key: 'tech_writer',
      name: 'Technical writer',
      description: 'Writes the manuals',
      isSystem: false,
      permissions: ['task:read'],
    });

    await apply(roles).execute({
      actor: actorWith(),
      changes: [{ roleId: WRITERS, permissions: ['task:read', 'task:update'] }],
    });

    expect(roles.updates).toContainEqual(
      expect.objectContaining({ description: 'Writes the manuals' }),
    );
  });

  it('takes the whole draft down when a role disappears mid-save', async () => {
    // The window between reading the draft and writing it. Refusing here is what keeps «eleven of
    // twelve» from being a state anybody can reach.
    const roles = twoRoles();

    roles.vanishOnUpdate();

    await expect(
      apply(roles).execute({
        actor: actorWith(),
        changes: [{ roleId: WRITERS, permissions: ['task:read', 'task:update'] }],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(roles.versionBumps).toEqual([]);
  });

  it('refuses the draft that would take away the author’s own last way to edit roles', async () => {
    const roles = twoRoles({ heldByActor: true });

    roles.roles.set(WRITERS, {
      roleId: WRITERS,
      key: 'tech_writer',
      name: 'Technical writer',
      description: null,
      isSystem: false,
      permissions: ['role:update'],
    });

    await expect(
      apply(roles).execute({
        actor: actorWith(),
        changes: [{ roleId: WRITERS, permissions: ['task:read'] }],
      }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(roles.roles.get(WRITERS)?.permissions).toEqual(['role:update']);
  });
});

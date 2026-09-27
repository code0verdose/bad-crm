import { describe, expect, it } from 'vitest';

import { CreateProjectUseCase } from '@/application/project/use-cases/create-project.use-case.js';

import {
  ADDRESS,
  IVAN,
  ORGANIZATION_ID,
  PETR,
  SUSPENDED,
  actorWith,
  projectHarness,
} from '../../support/project-harness.util.js';

/**
 * Creating a project — STORY-014-01, acceptance 1 and 2, the use-case half.
 *
 * What is decided here and nowhere else: the creator and the lead are the first two `LEAD`
 * memberships, written in the same transaction as the row; both folded views are invalidated; the
 * trail carries the seats; and the lead is looked up as a subject before anything is written, so a
 * suspended or foreign lead costs no row (acceptance 9, as 409 / 404 rather than the story's 422).
 */

const draft = {
  key: 'OPS',
  name: 'Operations',
  description: null,
  visibility: 'PUBLIC_ORG' as const,
  leadId: PETR,
  startedAt: null,
  dueAt: null,
  color: 'teal',
};

const build = (harness = projectHarness()) => ({
  harness,
  useCase: new CreateProjectUseCase(
    harness.unitOfWork,
    harness.store,
    harness.store,
    harness.acl,
    harness.audit,
  ),
});

describe('CreateProjectUseCase', () => {
  it('CONTROL: creates the project with the creator and the lead as LEADs, in one scope', async () => {
    const { harness, useCase } = build();

    const created = await useCase.execute({
      actor: actorWith(['project:create']),
      ipAddress: ADDRESS,
      ...draft,
    });

    expect(created).toMatchObject({
      key: 'OPS',
      name: 'Operations',
      status: 'ACTIVE',
      memberCount: 2,
    });
    await expect(harness.store.roster(created.projectId)).resolves.toEqual([
      expect.objectContaining({ userId: IVAN, projectRole: 'LEAD', allocationPct: 100 }),
      expect.objectContaining({ userId: PETR, projectRole: 'LEAD', allocationPct: 100 }),
    ]);
    expect(harness.store.versionBumps).toEqual([IVAN, PETR]);
    expect(harness.unitOfWork.scopes).toEqual([{ organizationId: ORGANIZATION_ID, userId: IVAN }]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.created',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: created.projectId },
        after: {
          key: 'OPS',
          name: 'Operations',
          visibility: 'PUBLIC_ORG',
          leadId: PETR,
          members: [
            { userId: IVAN, projectRole: 'LEAD' },
            { userId: PETR, projectRole: 'LEAD' },
          ],
        },
      }),
    ]);
  });

  it('writes one LEAD seat when the creator leads their own project', async () => {
    const { harness, useCase } = build();

    const created = await useCase.execute({
      actor: actorWith(['project:create']),
      ipAddress: undefined,
      ...draft,
      leadId: IVAN,
    });

    expect(created.memberCount).toBe(1);
    expect(harness.store.versionBumps).toEqual([IVAN]);
  });

  /**
   * The response is the same `ProjectDetail` the card reads, so it carries the same block, decided
   * the same way: the creator's fresh `LEAD` seat is `MANAGER` on the chain, and each flag is then
   * what the caller's capability allows — `project:manage_members` needs `MANAGER`, so a `true`
   * there is the seat written in this transaction being read back, not a default.
   */
  it('answers the permissions block over the seat it has just written', async () => {
    const { useCase } = build();

    const created = await useCase.execute({
      actor: actorWith(['project:create', 'project:update', 'project:manage_members']),
      ipAddress: undefined,
      ...draft,
    });

    expect(created.permissions).toEqual({
      canEdit: true,
      canManageMembers: true,
      canChangeVisibility: false,
      canArchive: false,
      canDelete: false,
    });
  });

  /**
   * The row is already written when the block is decided, so a resolver that answers `unavailable`
   * must not undo the creation — and must not guess either: every flag is `false` (fail-closed), and
   * the client learns the real answer from the next read of the card. This is the application-side
   * failure only: a failed SQL statement aborts the transaction on a real database and the creation
   * fails with it — the double here cannot show that, and does not claim to.
   */
  it('answers every flag false, and still creates, when the chain cannot be read', async () => {
    const { harness, useCase } = build();

    harness.store.aclFailure = new Error('chain read failed');

    const created = await useCase.execute({
      actor: actorWith(['project:create', 'project:update', 'project:manage_members']),
      ipAddress: undefined,
      ...draft,
    });

    expect(created.permissions).toEqual({
      canEdit: false,
      canManageMembers: false,
      canChangeVisibility: false,
      canArchive: false,
      canDelete: false,
    });
    expect(harness.audit.events.map((event) => event.action)).toEqual(['project.created']);
  });

  it('refuses a caller without project:create before anything is read', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({ actor: actorWith([]), ipAddress: undefined, ...draft }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  it('answers 409 project_already_exists for a key a live project of this tenant holds', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({
        actor: actorWith(['project:create']),
        ipAddress: undefined,
        ...draft,
        key: 'BAD',
      }),
    ).rejects.toMatchObject({ code: 'project_already_exists' });
    expect(harness.audit.events).toEqual([]);
  });

  /** Acceptance 9: a lead of another organization is nobody — 404, and no row is written. */
  it('answers 404 user_not_found for a lead the tenant cannot see, before creating anything', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({
        actor: actorWith(['project:create']),
        ipAddress: undefined,
        ...draft,
        leadId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5bff',
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
    expect(harness.store.trace).not.toContain('create');
  });

  it('answers 409 member_not_active for a suspended lead, to a caller who may read the directory', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({
        actor: actorWith(['project:create', 'user:read']),
        ipAddress: undefined,
        ...draft,
        leadId: SUSPENDED,
      }),
    ).rejects.toMatchObject({ code: 'member_not_active' });
    expect(harness.store.trace).not.toContain('create');
  });
});

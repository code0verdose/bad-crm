import { describe, expect, it } from 'vitest';

import { UpdateProjectUseCase } from '@/application/project/use-cases/update-project.use-case.js';

import {
  ADDRESS,
  IVAN,
  OLGA,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  PETR,
  PROJECT_ID,
  SUSPENDED,
  actorWith,
  inTenant,
  projectHarness,
} from '../../support/project-harness.util.js';

/**
 * Editing a project — STORY-014-01, acceptance 3, 5 and 6, plus the one field of the patch that
 * moves rights.
 *
 * The lead is a column **and** a `LEAD` membership. A new `leadId` therefore writes a membership
 * (or promotes one), and that is a change of rights — so the use-case demands
 * `project:manage_members` on top of `project:update` for that field, and files the membership
 * entry beside `project.updated`. An `EDITOR` renaming the project pays nothing extra; an `EDITOR`
 * trying to hand `MANAGER` to somebody through the rename form is refused.
 */

const patch = {
  name: 'Bad CRM 2',
  description: null,
  leadId: PETR,
  startedAt: new Date('2026-10-01T00:00:00.000Z'),
  dueAt: null,
  color: 'grape',
};

const build = (
  harness = projectHarness({
    members: [
      [IVAN, 'MEMBER'],
      [PETR, 'LEAD'],
    ],
  }),
) => ({
  harness,
  useCase: new UpdateProjectUseCase(
    harness.unitOfWork,
    harness.store,
    harness.store,
    harness.acl,
    harness.audit,
  ),
});

describe('UpdateProjectUseCase', () => {
  it('CONTROL: a MEMBER (EDITOR) with project:update replaces the fields and files both sides', async () => {
    const { harness, useCase } = build();

    await useCase.execute({
      actor: actorWith(['project:update']),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      ...patch,
    });

    await expect(inTenant(harness, () => harness.store.detail(PROJECT_ID))).resolves.toMatchObject({
      name: 'Bad CRM 2',
      color: 'grape',
      startedAt: patch.startedAt,
    });
    expect(harness.store.versionBumps).toEqual([]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.updated',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: PROJECT_ID },
        before: {
          name: 'Bad CRM',
          description: 'The product itself',
          leadId: PETR,
          startedAt: null,
          dueAt: null,
          color: 'indigo',
        },
        after: {
          name: 'Bad CRM 2',
          description: null,
          leadId: PETR,
          startedAt: '2026-10-01T00:00:00.000Z',
          dueAt: null,
          color: 'grape',
        },
      }),
    ]);
  });

  it('reads the locked row and the chain, decides, and only then writes', async () => {
    const { harness, useCase } = build();

    await useCase.execute({
      actor: actorWith(['project:update']),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      ...patch,
    });

    expect(harness.store.trace).toEqual(['lockForWrite', 'aclFacts', 'entriesAlong', 'update']);
  });

  /** Acceptance 5: an OBSERVER holds the key and is one level short — 403 inside the contour. */
  it('refuses an OBSERVER (VIEWER) with insufficient_acl_level', async () => {
    const { harness, useCase } = build(projectHarness({ members: [[IVAN, 'OBSERVER']] }));

    await expect(
      useCase.execute({
        actor: actorWith(['project:update']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        ...patch,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'insufficient_acl_level' });
    expect(harness.store.trace).not.toContain('update');
  });

  /** Acceptance 6: MANAGER on the chain and no key — the conjunction, not the disjunction. */
  it('refuses a LEAD (MANAGER) without the key, before reading a single fact', async () => {
    const { harness, useCase } = build(projectHarness({ members: [[IVAN, 'LEAD']] }));

    await expect(
      useCase.execute({
        actor: actorWith([]),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        ...patch,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);
  });

  describe('the closed contour on a mutation', () => {
    it.each<[string, () => ReturnType<typeof projectHarness>]>([
      [
        'a project of another organization',
        () => projectHarness({ organizationId: OTHER_ORGANIZATION_ID }),
      ],
      ['a deleted project', () => projectHarness({ isDeleted: true })],
      ['a PRIVATE project the caller is not on', () => projectHarness({ visibility: 'PRIVATE' })],
    ])('%s → project_not_found, nothing written', async (_case, seed) => {
      const { harness, useCase } = build(seed());

      await expect(
        useCase.execute({
          actor: actorWith(['project:update']),
          ipAddress: undefined,
          projectId: PROJECT_ID,
          ...patch,
        }),
      ).rejects.toMatchObject({ code: 'project_not_found' });
      expect(harness.store.trace).not.toContain('update');
      expect(harness.audit.events).toEqual([]);
    });
  });

  /**
   * The lock closes this window on a real database; the double cannot hold one, so the branch is
   * reached here — and it answers the same 404 a foreign id gets, with no trail entry for a change
   * that did not happen.
   */
  it('answers 404 when the row vanished between the decision and the write', async () => {
    const { harness, useCase } = build();

    harness.store.vanishesBeforeWrite = true;

    await expect(
      useCase.execute({
        actor: actorWith(['project:update']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        ...patch,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(harness.audit.events).toEqual([]);
  });

  describe('changing the lead', () => {
    it('CONTROL: a LEAD with both keys hands the lead to a non-member, who joins as LEAD', async () => {
      const { harness, useCase } = build(projectHarness({ members: [[IVAN, 'LEAD']] }));

      await useCase.execute({
        actor: actorWith(['project:update', 'project:manage_members']),
        ipAddress: ADDRESS,
        projectId: PROJECT_ID,
        ...patch,
        leadId: OLGA,
      });

      await expect(harness.store.membershipOf(PROJECT_ID, OLGA)).resolves.toEqual({
        projectRole: 'LEAD',
        allocationPct: 100,
      });
      expect(harness.store.versionBumps).toEqual([OLGA]);
      expect(harness.audit.events.map((event) => event.action)).toEqual([
        'project.updated',
        'project.member_added',
      ]);
      expect(harness.audit.events[1]).toMatchObject({
        target: { type: 'PROJECT', id: PROJECT_ID },
        after: { userId: OLGA, projectRole: 'LEAD', allocationPct: 100 },
      });
    });

    it('promotes a lead who is already a MEMBER, and files the role change', async () => {
      const { harness, useCase } = build(
        projectHarness({
          members: [
            [IVAN, 'LEAD'],
            [OLGA, 'MEMBER'],
          ],
        }),
      );

      await useCase.execute({
        actor: actorWith(['project:update', 'project:manage_members']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        ...patch,
        leadId: OLGA,
      });

      await expect(harness.store.membershipOf(PROJECT_ID, OLGA)).resolves.toMatchObject({
        projectRole: 'LEAD',
      });
      expect(harness.store.versionBumps).toEqual([OLGA]);
      expect(harness.audit.events[1]).toMatchObject({
        action: 'project.member_role_changed',
        before: { userId: OLGA, projectRole: 'MEMBER', allocationPct: 100 },
        after: { userId: OLGA, projectRole: 'LEAD', allocationPct: 100 },
      });
    });

    it('writes no membership entry when the new lead already leads', async () => {
      const { harness, useCase } = build(
        projectHarness({
          members: [
            [IVAN, 'LEAD'],
            [OLGA, 'LEAD'],
          ],
        }),
      );

      await useCase.execute({
        actor: actorWith(['project:update', 'project:manage_members']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        ...patch,
        leadId: OLGA,
      });

      expect(harness.store.versionBumps).toEqual([]);
      expect(harness.audit.events.map((event) => event.action)).toEqual(['project.updated']);
    });

    /** The escalation rule 10 forbids: an EDITOR must not hand MANAGER to anybody through a rename. */
    it('refuses an EDITOR without project:manage_members, and writes nothing', async () => {
      const { harness, useCase } = build();

      await expect(
        useCase.execute({
          actor: actorWith(['project:update']),
          ipAddress: undefined,
          projectId: PROJECT_ID,
          ...patch,
          leadId: OLGA,
        }),
      ).rejects.toMatchObject({
        code: 'project_forbidden',
        reason: 'permission_not_granted',
        permissionKey: 'project:manage_members',
      });
      expect(harness.store.trace).not.toContain('update');
      expect(harness.audit.events).toEqual([]);
    });

    /**
     * The security gate's finding on the first draft: `assertNotSelfJoin` guarded `POST …/members`
     * and not this path, so a `MANAGER` by an expiring ACL grant could write themselves a
     * permanent `LEAD` seat through the rename form. Nobody hands the lead to themselves.
     */
    it('refuses the caller as the new lead, even with both keys, and writes nothing', async () => {
      const { harness, useCase } = build(projectHarness({ members: [[PETR, 'LEAD']] }));

      await expect(
        useCase.execute({
          actor: actorWith(['project:update', 'project:manage_members'], { isOwner: true }),
          ipAddress: undefined,
          projectId: PROJECT_ID,
          ...patch,
          leadId: IVAN,
        }),
      ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'self_assignment_forbidden' });
      expect(harness.store.trace).not.toContain('update');
      expect(harness.store.trace).not.toContain('add');
      expect(harness.audit.events).toEqual([]);
    });

    it('refuses a suspended lead as 409 and a foreign one as 404, before writing', async () => {
      const { harness, useCase } = build(projectHarness({ members: [[IVAN, 'LEAD']] }));
      const actor = actorWith(['project:update', 'project:manage_members', 'user:read']);

      await expect(
        useCase.execute({
          actor,
          ipAddress: undefined,
          projectId: PROJECT_ID,
          ...patch,
          leadId: SUSPENDED,
        }),
      ).rejects.toMatchObject({ code: 'member_not_active' });
      await expect(
        useCase.execute({
          actor,
          ipAddress: undefined,
          projectId: PROJECT_ID,
          ...patch,
          leadId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5bff',
        }),
      ).rejects.toMatchObject({ code: 'user_not_found' });
      expect(harness.store.trace).not.toContain('update');
    });
  });
});

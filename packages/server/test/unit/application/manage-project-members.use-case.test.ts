import { describe, expect, it } from 'vitest';

import {
  AddProjectMemberUseCase,
  RemoveProjectMemberUseCase,
  UpdateProjectMemberUseCase,
} from '@/application/project/use-cases/manage-project-members.use-case.js';

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
  projectHarness,
} from '../../support/project-harness.util.js';

/**
 * The roster — STORY-014-02, acceptance 1, 4, 5, 6, 7, 8 and 11, the use-case half.
 *
 * Every command is a `MANAGER` decision over the locked project row, and every change of the
 * roster bumps the folded view of the person concerned in the same scope and files a `WARNING`
 * entry against the project. Beyond the ladder: nobody adds themselves; the last lead stays; a
 * repeated add is a role change when the role differs and a silent no-op when it does not — the
 * same reading the team roster settled on, so that a client is never told 204 for a state it did
 * not reach.
 */

const KEYS = ['project:manage_members'] as const;

const lead = (): ReturnType<typeof projectHarness> =>
  projectHarness({
    members: [
      [IVAN, 'LEAD'],
      [PETR, 'MEMBER'],
    ],
  });

const build = (harness = lead()) => ({
  harness,
  add: new AddProjectMemberUseCase(
    harness.unitOfWork,
    harness.store,
    harness.store,
    harness.acl,
    harness.audit,
  ),
  update: new UpdateProjectMemberUseCase(
    harness.unitOfWork,
    harness.store,
    harness.store,
    harness.acl,
    harness.audit,
  ),
  remove: new RemoveProjectMemberUseCase(
    harness.unitOfWork,
    harness.store,
    harness.store,
    harness.acl,
    harness.audit,
  ),
});

describe('AddProjectMemberUseCase', () => {
  it('CONTROL: a LEAD with the key adds an active colleague, bumps them and files the seat', async () => {
    const { harness, add } = build();

    await add.execute({
      actor: actorWith(KEYS),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      userId: OLGA,
      projectRole: 'REVIEWER',
      allocationPct: 50,
    });

    await expect(harness.store.membershipOf(PROJECT_ID, OLGA)).resolves.toEqual({
      projectRole: 'REVIEWER',
      allocationPct: 50,
    });
    expect(harness.store.versionBumps).toEqual([OLGA]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.member_added',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: PROJECT_ID },
        after: { userId: OLGA, projectRole: 'REVIEWER', allocationPct: 50 },
      }),
    ]);
  });

  /** Acceptance 6, `T-PROJ-02`: the key does not buy a seat for oneself. */
  it('refuses the caller’s own id even with the key, as a 403 with self_assignment_forbidden', async () => {
    const { harness, add } = build(projectHarness({ members: [[PETR, 'LEAD']] }));

    await expect(
      add.execute({
        actor: actorWith(KEYS, { isOwner: true }),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: IVAN,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'self_assignment_forbidden' });
    expect(harness.store.trace).not.toContain('add');
  });

  it('refuses a caller with project:read only, before any fact is read', async () => {
    const { harness, add } = build();

    await expect(
      add.execute({
        actor: actorWith(['project:read']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: OLGA,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);
  });

  it('refuses an EDITOR holding the key: MANAGER is the level', async () => {
    const { add } = build(projectHarness({ members: [[IVAN, 'MEMBER']] }));

    await expect(
      add.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: OLGA,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_acl_level' });
  });

  /** Acceptance 8: a foreign account is 404, a suspended one 409 — and only with `user:read`. */
  it('answers 404 for a foreign account and 409 for a suspended one', async () => {
    const { harness, add } = build();
    const input = {
      ipAddress: undefined,
      projectId: PROJECT_ID,
      projectRole: 'MEMBER' as const,
      allocationPct: 100,
    };

    await expect(
      add.execute({
        actor: actorWith(KEYS),
        ...input,
        userId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5bff',
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
    await expect(
      add.execute({ actor: actorWith([...KEYS, 'user:read']), ...input, userId: SUSPENDED }),
    ).rejects.toMatchObject({ code: 'member_not_active' });
    await expect(
      add.execute({ actor: actorWith(KEYS), ...input, userId: SUSPENDED }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
    expect(harness.store.trace).not.toContain('add');
    expect(harness.audit.events).toEqual([]);
  });

  it('is a silent no-op for a repeat with the same role and allocation', async () => {
    const { harness, add } = build();

    await add.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
      projectRole: 'MEMBER',
      allocationPct: 100,
    });

    expect(harness.store.versionBumps).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  it('applies a repeat with a different role as a role change, and files it as one', async () => {
    const { harness, add } = build();

    await add.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
      projectRole: 'LEAD',
      allocationPct: 80,
    });

    await expect(harness.store.membershipOf(PROJECT_ID, PETR)).resolves.toEqual({
      projectRole: 'LEAD',
      allocationPct: 80,
    });
    expect(harness.store.versionBumps).toEqual([PETR]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.member_role_changed',
        before: { userId: PETR, projectRole: 'MEMBER', allocationPct: 100 },
        after: { userId: PETR, projectRole: 'LEAD', allocationPct: 80 },
      }),
    ]);
  });

  it('applies a repeat with only a different allocation quietly: nothing about rights moved', async () => {
    const { harness, add } = build();

    await add.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
      projectRole: 'MEMBER',
      allocationPct: 30,
    });

    await expect(harness.store.membershipOf(PROJECT_ID, PETR)).resolves.toMatchObject({
      allocationPct: 30,
    });
    expect(harness.store.versionBumps).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  /** Acceptance 7 through the add path: a repeat that would demote the only lead. */
  it('refuses to demote the only lead through a repeated add', async () => {
    const { harness, add } = build();

    await expect(
      add.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: IVAN,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'self_assignment_forbidden' });
    // Not the lead rule: self-join is refused first. The lead rule is reached with a second lead
    // as the actor and Ivan as the only remaining… no — a project with two leads has a lead to
    // spare. So the rule is reached with Petr as the only lead and Ivan as an owner acting on him.
    const owner = build(projectHarness({ members: [[PETR, 'LEAD']] }));

    await expect(
      owner.add.execute({
        actor: actorWith(KEYS, { isOwner: true }),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
        projectRole: 'OBSERVER',
        allocationPct: 100,
      }),
    ).rejects.toMatchObject({ code: 'last_project_lead_required' });
    expect(owner.harness.audit.events).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  /** The insert lost a race the lock does not cover on this double: the seat exists, nothing is filed. */
  it('treats an insert the database refused as the seat already held', async () => {
    const { harness, add } = build();

    harness.store.refusesInsert = true;

    await add.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: OLGA,
      projectRole: 'MEMBER',
      allocationPct: 100,
    });

    expect(harness.store.versionBumps).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  it.each<[string, () => ReturnType<typeof projectHarness>]>([
    [
      'a project of another organization',
      () => projectHarness({ organizationId: OTHER_ORGANIZATION_ID }),
    ],
    ['a deleted project', () => projectHarness({ isDeleted: true, members: [[IVAN, 'LEAD']] })],
    ['a PRIVATE project the caller is not on', () => projectHarness({ visibility: 'PRIVATE' })],
  ])('%s → project_not_found', async (_case, seed) => {
    const { harness, add } = build(seed());

    await expect(
      add.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: OLGA,
        projectRole: 'MEMBER',
        allocationPct: 100,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(harness.store.trace).not.toContain('add');
  });
});

describe('UpdateProjectMemberUseCase', () => {
  it('CONTROL: promotes a MEMBER to LEAD, bumps them and files both sides', async () => {
    const { harness, update } = build();

    await update.execute({
      actor: actorWith(KEYS),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      userId: PETR,
      projectRole: 'LEAD',
    });

    await expect(harness.store.membershipOf(PROJECT_ID, PETR)).resolves.toMatchObject({
      projectRole: 'LEAD',
    });
    expect(harness.store.versionBumps).toEqual([PETR]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.member_role_changed',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: PROJECT_ID },
        before: { userId: PETR, projectRole: 'MEMBER', allocationPct: 100 },
        after: { userId: PETR, projectRole: 'LEAD', allocationPct: 100 },
      }),
    ]);
  });

  it('changes the allocation alone without a bump or an entry', async () => {
    const { harness, update } = build();

    await update.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
      allocationPct: 25,
    });

    await expect(harness.store.membershipOf(PROJECT_ID, PETR)).resolves.toEqual({
      projectRole: 'MEMBER',
      allocationPct: 25,
    });
    expect(harness.store.versionBumps).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  it('writes nothing when the patch changes nothing', async () => {
    const { harness, update } = build();

    await update.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
      projectRole: 'MEMBER',
      allocationPct: 100,
    });

    expect(harness.store.trace).not.toContain('member.update');
  });

  /** Acceptance 7: the only lead cannot be demoted — by an owner acting on them, since one's own role is off limits. */
  it('refuses to demote the only lead, as last_project_lead_required', async () => {
    const { harness, update } = build(projectHarness({ members: [[PETR, 'LEAD']] }));

    await expect(
      update.execute({
        actor: actorWith(KEYS, { isOwner: true }),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
        projectRole: 'MEMBER',
      }),
    ).rejects.toMatchObject({ code: 'last_project_lead_required' });
    expect(harness.store.trace).toContain('leads');
    expect(harness.audit.events).toEqual([]);
  });

  /** The same rule as on `POST`: nobody raises their own seat (the security gate's finding). */
  it('refuses the caller changing their own role, even as owner; allocation alone is theirs to change', async () => {
    const { harness, update } = build(
      projectHarness({
        members: [
          [IVAN, 'MEMBER'],
          [PETR, 'LEAD'],
        ],
      }),
    );
    const owner = actorWith(KEYS, { isOwner: true });

    await expect(
      update.execute({
        actor: owner,
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: IVAN,
        projectRole: 'LEAD',
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'self_assignment_forbidden' });
    expect(harness.store.trace).not.toContain('member.update');

    await update.execute({
      actor: owner,
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: IVAN,
      allocationPct: 40,
    });

    await expect(harness.store.membershipOf(PROJECT_ID, IVAN)).resolves.toEqual({
      projectRole: 'MEMBER',
      allocationPct: 40,
    });
  });

  it('demotes a lead when another one remains', async () => {
    const { harness, update } = build(
      projectHarness({
        members: [
          [IVAN, 'LEAD'],
          [PETR, 'LEAD'],
        ],
      }),
    );

    await update.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
      projectRole: 'OBSERVER',
    });

    await expect(harness.store.membershipOf(PROJECT_ID, PETR)).resolves.toMatchObject({
      projectRole: 'OBSERVER',
    });
  });

  it('answers 404 user_not_found for somebody not on the project, and for a row that vanished', async () => {
    const { harness, update } = build();

    await expect(
      update.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: OLGA,
        projectRole: 'LEAD',
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });

    harness.store.vanishesBeforeWrite = true;

    await expect(
      update.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
        projectRole: 'LEAD',
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
    expect(harness.audit.events).toEqual([]);
  });

  it('refuses without the key and refuses a foreign project as 404', async () => {
    const { harness, update } = build();

    await expect(
      update.execute({
        actor: actorWith([]),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
        projectRole: 'LEAD',
      }),
    ).rejects.toMatchObject({ reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);

    const foreign = build(projectHarness({ organizationId: OTHER_ORGANIZATION_ID }));

    await expect(
      foreign.update.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
        projectRole: 'LEAD',
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });
});

describe('RemoveProjectMemberUseCase', () => {
  it('CONTROL: ends the membership, keeps the row, bumps and files before', async () => {
    const { harness, remove } = build();

    await remove.execute({
      actor: actorWith(KEYS),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      userId: PETR,
    });

    await expect(harness.store.membershipOf(PROJECT_ID, PETR)).resolves.toBeNull();
    await expect(harness.store.roster(PROJECT_ID, { includeLeft: true })).resolves.toEqual([
      expect.objectContaining({ userId: IVAN, leftAt: null }),
      expect.objectContaining({ userId: PETR, leftAt: expect.any(Date) }),
    ]);
    expect(harness.store.versionBumps).toEqual([PETR]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.member_removed',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: PROJECT_ID },
        before: { userId: PETR, projectRole: 'MEMBER', allocationPct: 100 },
      }),
    ]);
  });

  /** Acceptance 7: the only lead cannot leave. */
  it('refuses to let the only lead go', async () => {
    const { harness, remove } = build();

    await expect(
      remove.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: IVAN,
      }),
    ).rejects.toMatchObject({ code: 'last_project_lead_required' });
    expect(harness.audit.events).toEqual([]);
  });

  it('lets a lead go when another remains', async () => {
    const { harness, remove } = build(
      projectHarness({
        members: [
          [IVAN, 'LEAD'],
          [PETR, 'LEAD'],
        ],
      }),
    );

    await remove.execute({
      actor: actorWith(KEYS),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      userId: PETR,
    });

    await expect(harness.store.leads(PROJECT_ID)).resolves.toEqual([IVAN]);
  });

  it('answers 404 for somebody not on the project, for a row that vanished, and for a foreign project', async () => {
    const { harness, remove } = build();

    await expect(
      remove.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: OLGA,
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });

    harness.store.vanishesBeforeWrite = true;

    await expect(
      remove.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
      }),
    ).rejects.toMatchObject({ code: 'user_not_found' });

    const foreign = build(projectHarness({ organizationId: OTHER_ORGANIZATION_ID }));

    await expect(
      foreign.remove.execute({
        actor: actorWith(KEYS),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(harness.audit.events).toEqual([]);
  });

  it('refuses without the key before any fact is read', async () => {
    const { harness, remove } = build();

    await expect(
      remove.execute({
        actor: actorWith([]),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        userId: PETR,
      }),
    ).rejects.toMatchObject({ reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';

import { ArchiveProjectUseCase } from '@/application/project/use-cases/archive-project.use-case.js';
import { ChangeProjectVisibilityUseCase } from '@/application/project/use-cases/change-project-visibility.use-case.js';
import { DeleteProjectUseCase } from '@/application/project/use-cases/delete-project.use-case.js';

import {
  ADDRESS,
  IVAN,
  ORGANIZATION_ID,
  OTHER_ORGANIZATION_ID,
  PETR,
  PROJECT_ID,
  actorWith,
  inTenant,
  projectHarness,
} from '../../support/project-harness.util.js';

/**
 * The three lifecycle commands — STORY-014-01, acceptance 7 (visibility) and 11 (deletion), and
 * the archive half the story names beside them (the way back is STORY-014-07).
 *
 * All three are `MANAGER` decisions over a locked row, and two of them stand behind a `dangerous`
 * key. What each holds beyond the ladder: a visibility change is refused without the confirmation
 * header even for a caller who may make it; a repeat that asks for the state already held writes
 * nothing and files nothing; a deletion invalidates every member's folded view and carries the
 * roster in its trail entry.
 */

const manager = (): ReturnType<typeof projectHarness> =>
  projectHarness({
    members: [
      [IVAN, 'LEAD'],
      [PETR, 'MEMBER'],
    ],
  });

describe('ChangeProjectVisibilityUseCase', () => {
  const build = (harness = manager()) => ({
    harness,
    useCase: new ChangeProjectVisibilityUseCase(
      harness.unitOfWork,
      harness.store,
      harness.acl,
      harness.audit,
    ),
  });

  it('CONTROL: a confirmed MANAGER with the key makes the project PRIVATE and files it loud', async () => {
    const { harness, useCase } = build();

    await useCase.execute({
      actor: actorWith(['project:manage_visibility']),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
      visibility: 'PRIVATE',
      confirmedDangerous: true,
    });

    await expect(inTenant(harness, () => harness.store.detail(PROJECT_ID))).resolves.toMatchObject({
      visibility: 'PRIVATE',
    });
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.visibility_changed',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: PROJECT_ID },
        before: { visibility: 'PUBLIC_ORG' },
        after: { visibility: 'PRIVATE' },
      }),
    ]);
  });

  /** Acceptance 7: «требуется подтверждение» — after the decision, so nobody probes through it. */
  it('answers 428 confirmation_required without the header, and writes nothing', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({
        actor: actorWith(['project:manage_visibility']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
        confirmedDangerous: false,
      }),
    ).rejects.toMatchObject({ code: 'confirmation_required' });
    expect(harness.store.trace).not.toContain('changeVisibility');
    expect(harness.audit.events).toEqual([]);
  });

  /**
   * The order the class docstring promises, as a test: a caller who may not change the visibility
   * and did not send the header is refused by the capability, never by the confirmation — a 428
   * to them would say «you hold the right, say it twice».
   */
  it('refuses a caller without the key by the capability, not by the confirmation', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({
        actor: actorWith(['project:read']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
        confirmedDangerous: false,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);

    const editor = build(projectHarness({ members: [[IVAN, 'MEMBER']] }));

    await expect(
      editor.useCase.execute({
        actor: actorWith(['project:manage_visibility']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
        confirmedDangerous: false,
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_acl_level' });
  });

  it('is idempotent: asking for the visibility already held writes and files nothing', async () => {
    const { harness, useCase } = build();

    await useCase.execute({
      actor: actorWith(['project:manage_visibility']),
      ipAddress: undefined,
      projectId: PROJECT_ID,
      visibility: 'PUBLIC_ORG',
      confirmedDangerous: false,
    });

    expect(harness.store.trace).not.toContain('changeVisibility');
    expect(harness.audit.events).toEqual([]);
  });

  it('refuses an EDITOR one level short, inside the contour', async () => {
    const { useCase } = build(projectHarness({ members: [[IVAN, 'MEMBER']] }));

    await expect(
      useCase.execute({
        actor: actorWith(['project:manage_visibility']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
        confirmedDangerous: true,
      }),
    ).rejects.toMatchObject({ code: 'project_forbidden', reason: 'insufficient_acl_level' });
  });

  it('answers 404 for a foreign project and for a row that vanished before the write', async () => {
    const foreign = build(projectHarness({ organizationId: OTHER_ORGANIZATION_ID }));

    await expect(
      foreign.useCase.execute({
        actor: actorWith(['project:manage_visibility']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
        confirmedDangerous: true,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });

    const vanishing = build();

    vanishing.harness.store.vanishesBeforeWrite = true;

    await expect(
      vanishing.useCase.execute({
        actor: actorWith(['project:manage_visibility']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
        visibility: 'PRIVATE',
        confirmedDangerous: true,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(vanishing.harness.audit.events).toEqual([]);
  });
});

describe('ArchiveProjectUseCase', () => {
  const build = (harness = manager()) => ({
    harness,
    useCase: new ArchiveProjectUseCase(
      harness.unitOfWork,
      harness.store,
      harness.acl,
      harness.audit,
    ),
  });

  it('CONTROL: a MANAGER with project:archive archives and files before/after', async () => {
    const { harness, useCase } = build();

    await useCase.execute({
      actor: actorWith(['project:archive']),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
    });

    await expect(inTenant(harness, () => harness.store.detail(PROJECT_ID))).resolves.toMatchObject({
      status: 'ARCHIVED',
    });
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.archived',
        target: { type: 'PROJECT', id: PROJECT_ID },
        before: { status: 'ACTIVE' },
        after: { status: 'ARCHIVED' },
      }),
    ]);
  });

  it('is idempotent on an archived project', async () => {
    const { harness, useCase } = build(
      projectHarness({ status: 'ARCHIVED', members: [[IVAN, 'LEAD']] }),
    );

    await useCase.execute({
      actor: actorWith(['project:archive']),
      ipAddress: undefined,
      projectId: PROJECT_ID,
    });

    expect(harness.store.trace).not.toContain('changeStatus');
    expect(harness.audit.events).toEqual([]);
  });

  it('refuses an EDITOR, and answers 404 for a deleted project and for a vanished row', async () => {
    const editor = build(projectHarness({ members: [[IVAN, 'MEMBER']] }));

    await expect(
      editor.useCase.execute({
        actor: actorWith(['project:archive']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_acl_level' });

    const deleted = build(projectHarness({ isDeleted: true, members: [[IVAN, 'LEAD']] }));

    await expect(
      deleted.useCase.execute({
        actor: actorWith(['project:archive']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });

    const vanishing = build();

    vanishing.harness.store.vanishesBeforeWrite = true;

    await expect(
      vanishing.useCase.execute({
        actor: actorWith(['project:archive']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });
});

describe('DeleteProjectUseCase', () => {
  const build = (harness = manager()) => ({
    harness,
    useCase: new DeleteProjectUseCase(
      harness.unitOfWork,
      harness.store,
      harness.store,
      harness.acl,
      harness.audit,
    ),
  });

  it('CONTROL: hides the project, bumps every live member at once, and files the roster', async () => {
    const { harness, useCase } = build();

    await useCase.execute({
      actor: actorWith(['project:delete']),
      ipAddress: ADDRESS,
      projectId: PROJECT_ID,
    });

    await expect(inTenant(harness, () => harness.store.list())).resolves.toEqual([]);
    await expect(inTenant(harness, () => harness.store.scope(PROJECT_ID))).resolves.toMatchObject({
      isDeleted: true,
    });
    // The memberships stay as history — `left_at` is not stamped by a deletion.
    await expect(harness.store.roster(PROJECT_ID)).resolves.toHaveLength(2);
    expect(harness.store.versionBumps).toEqual([IVAN, PETR]);
    expect(harness.audit.events).toEqual([
      expect.objectContaining({
        action: 'project.deleted',
        actor: { userId: IVAN, organizationId: ORGANIZATION_ID, ipAddress: ADDRESS },
        target: { type: 'PROJECT', id: PROJECT_ID },
        before: {
          key: 'BAD',
          name: 'Bad CRM',
          members: [
            { userId: IVAN, projectRole: 'LEAD' },
            { userId: PETR, projectRole: 'MEMBER' },
          ],
        },
      }),
    ]);
  });

  it('answers a deleted project as 404, not as a second deletion', async () => {
    const { harness, useCase } = build(
      projectHarness({ isDeleted: true, members: [[IVAN, 'LEAD']] }),
    );

    await expect(
      useCase.execute({
        actor: actorWith(['project:delete']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(harness.audit.events).toEqual([]);
  });

  it('answers 404 when the row vanished before the write, bumping nobody', async () => {
    const { harness, useCase } = build();

    harness.store.vanishesBeforeWrite = true;

    await expect(
      useCase.execute({
        actor: actorWith(['project:delete']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
    expect(harness.store.versionBumps).toEqual([]);
    expect(harness.audit.events).toEqual([]);
  });

  it('refuses without the key before any fact is read, and refuses an EDITOR with the key', async () => {
    const { harness, useCase } = build();

    await expect(
      useCase.execute({ actor: actorWith([]), ipAddress: undefined, projectId: PROJECT_ID }),
    ).rejects.toMatchObject({ reason: 'permission_not_granted', permissionKey: 'project:delete' });
    expect(harness.store.trace).toEqual([]);

    const editor = build(projectHarness({ members: [[IVAN, 'MEMBER']] }));

    await expect(
      editor.useCase.execute({
        actor: actorWith(['project:delete']),
        ipAddress: undefined,
        projectId: PROJECT_ID,
      }),
    ).rejects.toMatchObject({ reason: 'insufficient_acl_level' });
  });
});

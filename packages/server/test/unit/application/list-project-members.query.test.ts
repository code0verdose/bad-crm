import { describe, expect, it } from 'vitest';

import { ListProjectMembersQuery } from '@/application/project/use-cases/list-project-members.query.js';

import {
  IVAN,
  OTHER_ORGANIZATION_ID,
  PETR,
  PROJECT_ID,
  actorWith,
  projectHarness,
} from '../../support/project-harness.util.js';

/**
 * The roster read — STORY-014-02, acceptance 10, the server half: the people who left are shown
 * only on request, and the read is gated exactly as the project card is (`project:read`, `VIEWER`
 * on the chain), so a `PRIVATE` project's roster is 404 to an outsider.
 */

const build = (
  harness = projectHarness({
    members: [
      [IVAN, 'MEMBER'],
      [PETR, 'LEAD'],
    ],
  }),
) => ({
  harness,
  query: new ListProjectMembersQuery(harness.unitOfWork, harness.store, harness.store, harness.acl),
});

describe('ListProjectMembersQuery', () => {
  it('CONTROL: a reader on the project gets the live roster', async () => {
    const { harness, query } = build();

    await harness.store.leave(PROJECT_ID, PETR);
    harness.store.addMember(PROJECT_ID, PETR, 'OBSERVER');

    await expect(
      query.execute({
        actor: actorWith(['project:read']),
        projectId: PROJECT_ID,
        includeLeft: false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({ userId: IVAN, projectRole: 'MEMBER', leftAt: null }),
      expect.objectContaining({ userId: PETR, projectRole: 'OBSERVER', leftAt: null }),
    ]);
  });

  it('includes the people who left only when asked to', async () => {
    const { harness, query } = build();

    await harness.store.leave(PROJECT_ID, PETR);

    const roster = await query.execute({
      actor: actorWith(['project:read']),
      projectId: PROJECT_ID,
      includeLeft: true,
    });

    expect(roster.map((entry) => entry.userId)).toEqual([IVAN, PETR]);
    expect(roster[1]?.leftAt).toEqual(expect.any(Date));
  });

  it('reads the scope under FOR SHARE, not the write lock', async () => {
    const { harness, query } = build();

    await query.execute({
      actor: actorWith(['project:read']),
      projectId: PROJECT_ID,
      includeLeft: false,
    });

    expect(harness.store.trace).toEqual(['scope', 'aclFacts', 'entriesAlong', 'roster']);
  });

  it('refuses without project:read before reading, and answers 404 for a PRIVATE project to an outsider', async () => {
    const { harness, query } = build();

    await expect(
      query.execute({ actor: actorWith([]), projectId: PROJECT_ID, includeLeft: false }),
    ).rejects.toMatchObject({ reason: 'permission_not_granted' });
    expect(harness.store.trace).toEqual([]);

    const outsider = build(projectHarness({ visibility: 'PRIVATE', members: [[PETR, 'LEAD']] }));

    await expect(
      outsider.query.execute({
        actor: actorWith(['project:read']),
        projectId: PROJECT_ID,
        includeLeft: false,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });

    const foreign = build(projectHarness({ organizationId: OTHER_ORGANIZATION_ID }));

    await expect(
      foreign.query.execute({
        actor: actorWith(['project:read']),
        projectId: PROJECT_ID,
        includeLeft: false,
      }),
    ).rejects.toMatchObject({ code: 'project_not_found' });
  });
});

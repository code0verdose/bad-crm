import { type SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { DeleteTeamUseCase } from '@/application/iam/use-cases/delete-team.use-case.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeTeamRepository } from '../../support/iam-doubles.util.js';
import { FakeAuditLogger, FakeUnitOfWork } from '../../support/identity-doubles.util.js';
import { FakeAclRepository } from '../application/acl-doubles.util.js';

/**
 * STORY-012-07 acceptance 5, the half the endpoint suite (`team-endpoints.test.ts`) could not reach
 * until a team could be the subject of a grant: disbanding a team removes its `TEAM` rows of
 * `resource_acl` in the same transaction, and files `acl.revoked` for each of them.
 *
 * The subject is polymorphic and has no foreign key, so nothing in the database does this. What is
 * held here is the use-case: exactly this team's rows go, the neighbours stay, the trail names every
 * grant it took, and a disbanding that does not happen takes nothing.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const ADMIN = '018f4a3b-0000-7000-8000-0000000000b1';
const IVAN = '018f4a3b-0000-7000-8000-0000000000c1';
const PETR = '018f4a3b-0000-7000-8000-0000000000c2';
const PROJECT_A = '018f4a3b-0000-7000-8000-0000000000d1';
const PROJECT_B = '018f4a3b-0000-7000-8000-0000000000d2';
const TEAM = '018f4a3b-0000-7000-8000-0000000000e1';
const OTHER_TEAM = '018f4a3b-0000-7000-8000-0000000000e2';
const ROLE = '018f4a3b-0000-7000-8000-0000000000f1';
const JOINED = new Date('2026-09-01T00:00:00.000Z');

const admin = (): Actor => ({
  userId: ADMIN,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['team:delete']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
});

const setup = (options: ConstructorParameters<typeof FakeTeamRepository>[0] = {}) => {
  const unitOfWork = new FakeUnitOfWork();
  const teams = new FakeTeamRepository(options);
  const acl = new FakeAclRepository();
  const audit = new FakeAuditLogger();

  teams.seed({
    teamId: TEAM,
    members: [
      { userId: IVAN, teamRole: 'LEAD', joinedAt: JOINED },
      { userId: PETR, teamRole: 'MEMBER', joinedAt: JOINED },
    ],
  });

  const ids = [
    acl.seed({
      resource: { type: 'PROJECT', id: PROJECT_A },
      subject: { type: 'TEAM', id: TEAM },
      level: 'EDITOR',
      expiresAt: null,
      grantedById: ADMIN,
    }),
    acl.seed({
      resource: { type: 'PROJECT', id: PROJECT_B },
      subject: { type: 'TEAM', id: TEAM },
      level: 'NONE',
      expiresAt: new Date('2026-12-31T00:00:00.000Z'),
      grantedById: null,
    }),
  ];

  // Neighbours the cascade must not touch: another team, a role and a person, on the same project.
  acl.seed({
    resource: { type: 'PROJECT', id: PROJECT_A },
    subject: { type: 'TEAM', id: OTHER_TEAM },
    level: 'VIEWER',
    expiresAt: null,
    grantedById: ADMIN,
  });
  acl.seed({
    resource: { type: 'PROJECT', id: PROJECT_A },
    subject: { type: 'ROLE', id: ROLE },
    level: 'COMMENTER',
    expiresAt: null,
    grantedById: ADMIN,
  });
  acl.seed({
    resource: { type: 'PROJECT', id: PROJECT_A },
    subject: { type: 'USER', id: IVAN },
    level: 'MANAGER',
    expiresAt: null,
    grantedById: ADMIN,
  });

  const useCase = new DeleteTeamUseCase(unitOfWork, teams, acl, audit);

  return { unitOfWork, teams, acl, audit, useCase, ids };
};

const disband = (ipAddress: string | undefined = '203.0.113.7') => ({
  actor: admin(),
  teamId: TEAM,
  ipAddress,
});

describe('DeleteTeamUseCase — the ACL cascade', () => {
  it('removes exactly this team’s grants and bumps every former member once', async () => {
    const { acl, teams, useCase, unitOfWork } = setup();

    await useCase.execute(disband());

    expect(acl.rows.map((row) => `${row.subject.type}:${row.subject.id}`)).toEqual([
      `TEAM:${OTHER_TEAM}`,
      `ROLE:${ROLE}`,
      `USER:${IVAN}`,
    ]);
    // The people the grants reached are the members, and the roster bump already covers them: one
    // statement, collected before the memberships were deleted.
    expect(teams.versionBumps).toEqual([IVAN, PETR]);
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: ADMIN }]);
  });

  it('files team.deleted, then acl.revoked for each grant it took, with what was there', async () => {
    const { audit, useCase, ids } = setup();

    await useCase.execute(disband());

    const actor = { userId: ADMIN, organizationId: ORG, ipAddress: '203.0.113.7' };

    expect(audit.events.map((event) => event.action)).toEqual([
      'team.deleted',
      'acl.revoked',
      'acl.revoked',
    ]);
    expect(audit.events.slice(1)).toEqual([
      {
        action: 'acl.revoked',
        actor,
        target: { type: 'RESOURCE_ACL', id: ids[0] },
        before: {
          resourceType: 'PROJECT',
          resourceId: PROJECT_A,
          subjectType: 'TEAM',
          subjectId: TEAM,
          accessLevel: 'EDITOR',
          expiresAt: null,
        },
        after: { cause: 'team.deleted' },
        requestId: undefined,
      },
      {
        action: 'acl.revoked',
        actor,
        target: { type: 'RESOURCE_ACL', id: ids[1] },
        before: {
          resourceType: 'PROJECT',
          resourceId: PROJECT_B,
          subjectType: 'TEAM',
          subjectId: TEAM,
          accessLevel: 'NONE',
          expiresAt: '2026-12-31T00:00:00.000Z',
        },
        after: { cause: 'team.deleted' },
        requestId: undefined,
      },
    ]);
  });

  /**
   * Grants before people (the re-gate's deadlock, 5/5 `40P01` against a revocation, measured in
   * `acl-subject-cascade.test.ts`): `RevokeAclUseCase` locks a grant row and then updates `users`,
   * so this cascade takes the grant rows before it bumps the members. The disbanding stays first — a
   * team somebody else disbanded keeps its grants for the transaction that did it.
   */
  it('disbands, then takes the grants, then bumps the members — in that order', async () => {
    const { acl, teams, useCase } = setup();
    const journal: string[] = [];
    const disbandTeam = teams.disband.bind(teams);
    const bump = teams.bumpPermissionsVersionOf.bind(teams);
    const collect = acl.removeAllOfSubject.bind(acl);

    teams.disband = (teamId) => {
      journal.push(`team.disband:${teamId}`);

      return disbandTeam(teamId);
    };
    teams.bumpPermissionsVersionOf = (userIds) => {
      journal.push(`team.bumpPermissionsVersionOf:${userIds.join(',')}`);

      return bump(userIds);
    };
    acl.removeAllOfSubject = (subject) => {
      journal.push(`acl.removeAllOfSubject:${subject.id}`);

      return collect(subject);
    };

    await useCase.execute(disband());

    expect(journal).toEqual([
      `team.disband:${TEAM}`,
      `acl.removeAllOfSubject:${TEAM}`,
      `team.bumpPermissionsVersionOf:${IVAN},${PETR}`,
    ]);
  });

  it('files only team.deleted for a team that held no grants', async () => {
    const { acl, audit, useCase } = setup();

    acl.rows.splice(0, 2);

    await useCase.execute(disband());

    expect(audit.events.map((event) => event.action)).toEqual(['team.deleted']);
    expect(acl.rows).toHaveLength(3);
  });

  /**
   * Disbanded by somebody else between the decision and the write: the answer is the 404 a foreign
   * team gets, and the grants stay — the other transaction, which did disband it, is the one that
   * removes them. A cascade run ahead of `disband()` would take them here and then roll back only
   * in a real database; the order is what makes the double honest.
   */
  it('takes no grant when the team vanishes before the write', async () => {
    const { acl, audit, useCase } = setup({ vanishesBeforeWrite: true });

    await expect(useCase.execute(disband())).rejects.toBeInstanceOf(NotFoundError);
    expect(acl.rows).toHaveLength(5);
    expect(audit.events).toEqual([]);
  });

  it('takes no grant when the actor may not disband teams', async () => {
    const { acl, useCase } = setup();

    await expect(
      useCase.execute({ ...disband(), actor: { ...admin(), permissions: new Set() } }),
    ).rejects.toBeInstanceOf(AccessRefusedError);
    expect(acl.rows).toHaveLength(5);
  });
});

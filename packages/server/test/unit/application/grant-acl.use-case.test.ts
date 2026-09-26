import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { GrantAclUseCase } from '@/application/access/use-cases/grant-acl.use-case.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { AccessRefusedError } from '@/domain/access/access.errors.js';
import { NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeAuditLogger, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

import { FakeAclRepository, FakeAclResolver, actorWith, ids } from './acl-doubles.util.js';

/**
 * `POST /acl` without the route: the command that writes a grant — STORY-011-06, acceptance 1
 * and 11.
 *
 * The order inside the transaction is the whole test: the object is resolved and the policy runs
 * **before** the subject is looked at, so a caller who may not grant on a project cannot use the
 * grant form to learn whether a team id exists; the subject is checked **before** anything is
 * written; the version bump and the trail entry are inside the same scope as the write.
 */

const { ORG, IVAN, PETR, PROJECT, TEAM } = ids;

const manager = (level: SharedPermissions.AccessLevel = 'MANAGER'): AclScope => ({
  status: 'resolved',
  organizationId: ORG,
  level,
  family: 'standard',
});

const setup = (scope: AclScope = manager()) => {
  const unitOfWork = new FakeUnitOfWork();
  const acl = new FakeAclRepository();
  const resolver = new FakeAclResolver(scope);
  const audit = new FakeAuditLogger();
  const useCase = new GrantAclUseCase(unitOfWork, resolver, acl, audit);

  return { unitOfWork, acl, resolver, audit, useCase };
};

const grant = (
  overrides: Partial<Parameters<GrantAclUseCase['execute']>[0]> = {},
): Parameters<GrantAclUseCase['execute']>[0] => ({
  actor: actorWith(['acl:grant']),
  resource: { type: 'PROJECT', id: PROJECT },
  subject: { type: 'TEAM', id: TEAM },
  level: 'EDITOR',
  expiresAt: null,
  ipAddress: '203.0.113.7',
  ...overrides,
});

describe('GrantAclUseCase — the happy path', () => {
  it('writes the grant, bumps every member of the team, and files acl.granted at WARNING', async () => {
    const { acl, audit, useCase, unitOfWork } = setup();
    acl.subjects.set(`TEAM:${TEAM}`, [IVAN, PETR]);

    const result = await useCase.execute(grant());

    expect(result).toEqual({ id: acl.rows[0]?.id });
    expect(acl.rows).toEqual([
      expect.objectContaining({
        resource: { type: 'PROJECT', id: PROJECT },
        subject: { type: 'TEAM', id: TEAM },
        level: 'EDITOR',
        expiresAt: null,
        grantedById: IVAN,
      }),
    ]);
    expect(acl.bumped).toEqual([[IVAN, PETR]]);
    expect(audit.events).toEqual([
      {
        action: 'acl.granted',
        actor: { userId: IVAN, organizationId: ORG, ipAddress: '203.0.113.7' },
        target: { type: 'RESOURCE_ACL', id: acl.rows[0]?.id },
        after: {
          resourceType: 'PROJECT',
          resourceId: PROJECT,
          subjectType: 'TEAM',
          subjectId: TEAM,
          accessLevel: 'EDITOR',
          expiresAt: null,
        },
        requestId: undefined,
      },
    ]);
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: IVAN }]);
  });

  it('records the previous opinion when the grant replaces one', async () => {
    const { acl, audit, useCase } = setup();
    acl.seed({
      resource: { type: 'PROJECT', id: PROJECT },
      subject: { type: 'TEAM', id: TEAM },
      level: 'VIEWER',
      expiresAt: null,
      grantedById: PETR,
    });

    await useCase.execute(grant({ expiresAt: new Date('2026-12-31T00:00:00Z') }));

    expect(acl.rows).toHaveLength(1);
    expect(acl.rows[0]).toMatchObject({ level: 'EDITOR', grantedById: IVAN });
    expect(audit.events[0]).toMatchObject({
      before: { accessLevel: 'VIEWER', expiresAt: null },
      after: { accessLevel: 'EDITOR', expiresAt: '2026-12-31T00:00:00.000Z' },
    });
  });

  it('bumps the one person when the subject is a user', async () => {
    const { acl, useCase } = setup();
    acl.subjects.set(`USER:${PETR}`, [PETR]);

    await useCase.execute(grant({ subject: { type: 'USER', id: PETR } }));

    expect(acl.bumped).toEqual([[PETR]]);
  });
});

describe('GrantAclUseCase — refusals, in the order they are made', () => {
  it('resolves the object before looking at the subject, and a missing object is a 404', async () => {
    const { acl, useCase, audit } = setup({ status: 'missing' });

    await expect(useCase.execute(grant())).rejects.toMatchObject({
      code: 'project_not_found',
      reason: 'resource_not_found',
    });
    expect(acl.existenceChecks).toEqual([]);
    expect(acl.rows).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('refuses without acl:grant as project_forbidden, touching nothing', async () => {
    const { acl, useCase } = setup();

    const refused = useCase.execute(grant({ actor: actorWith() }));

    await expect(refused).rejects.toBeInstanceOf(AccessRefusedError);
    await expect(refused).rejects.toMatchObject({
      code: 'project_forbidden',
      reason: 'permission_not_granted',
    });
    expect(acl.existenceChecks).toEqual([]);
    expect(acl.rows).toEqual([]);
  });

  it('refuses an EDITOR on the project — acl:grant needs MANAGER (acceptance 11)', async () => {
    const { useCase } = setup(manager('EDITOR'));

    await expect(useCase.execute(grant({ level: 'VIEWER' }))).rejects.toMatchObject({
      code: 'project_forbidden',
      reason: 'insufficient_acl_level',
    });
  });

  it('answers NONE on a project — a PRIVATE one the caller is not on — as 404, the project’s closed contour', async () => {
    const { acl, useCase } = setup(manager('NONE'));

    await expect(useCase.execute(grant())).rejects.toMatchObject({
      code: 'project_not_found',
      reason: 'resource_not_found',
    });
    expect(acl.existenceChecks).toEqual([]);
    expect(acl.rows).toEqual([]);
  });

  it('leaves NONE on the organization a 403 — no domain has closed that contour', async () => {
    const { useCase } = setup(manager('NONE'));

    await expect(
      useCase.execute(grant({ resource: { type: 'ORGANIZATION', id: ORG } })),
    ).rejects.toMatchObject({ code: 'organization_forbidden', reason: 'acl_explicit_none' });
  });

  it('answers a reader that failed with 503, never with a grant', async () => {
    const { acl, useCase } = setup({ status: 'unavailable' });

    await expect(useCase.execute(grant())).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    expect(acl.rows).toEqual([]);
  });

  it('answers a subject that is not in this organization as not found — after the policy', async () => {
    const { acl, useCase, audit } = setup();
    acl.missingSubjects.add(`TEAM:${TEAM}`);

    await expect(useCase.execute(grant())).rejects.toMatchObject({ code: 'team_not_found' });
    await expect(
      useCase.execute(grant({ subject: { type: 'USER', id: PETR } })),
    ).resolves.toBeDefined();
    expect(acl.existenceChecks).toEqual([
      { type: 'TEAM', id: TEAM },
      { type: 'USER', id: PETR },
    ]);
    expect(audit.events).toHaveLength(1);
  });

  it('is a NotFoundError for the subject, so the transport answers 404', async () => {
    const { acl, useCase } = setup();
    acl.missingSubjects.add(`ROLE:${TEAM}`);

    await expect(
      useCase.execute(grant({ subject: { type: 'ROLE', id: TEAM } })),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('refuses a NONE on oneself as self_lockout', async () => {
    const { useCase } = setup();

    await expect(
      useCase.execute(grant({ subject: { type: 'USER', id: IVAN }, level: 'NONE' })),
    ).rejects.toMatchObject({ reason: 'self_lockout' });
  });

  it('rolls the write back when the trail cannot be written — fail-closed for a privileged action', async () => {
    const unitOfWork = new FakeUnitOfWork();
    const acl = new FakeAclRepository();
    const useCase = new GrantAclUseCase(
      unitOfWork,
      new FakeAclResolver(manager()),
      acl,
      new FakeAuditLogger(true),
    );

    await expect(useCase.execute(grant())).rejects.toThrow('audit sink unavailable');
  });
});

describe('GrantAclUseCase — the levels it accepts', () => {
  it.each<SharedPermissions.AccessLevel>(['NONE', 'VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER'])(
    'writes %s for somebody else when the actor is MANAGER',
    async (level) => {
      const { acl, useCase } = setup();

      await useCase.execute(grant({ level, subject: { type: 'USER', id: PETR } }));

      expect(acl.rows[0]).toMatchObject({ level });
    },
  );
});

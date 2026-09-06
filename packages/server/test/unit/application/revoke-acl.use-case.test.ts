import { describe, expect, it } from 'vitest';

import { RevokeAclUseCase } from '@/application/access/use-cases/revoke-acl.use-case.js';
import { type AclScope } from '@/domain/access/authorize.util.js';
import { NotFoundError } from '@/domain/shared/errors/app.errors.js';

import { FakeAuditLogger, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

import { FakeAclRepository, FakeAclResolver, actorWith, ids } from './acl-doubles.util.js';

/**
 * Taking a grant away — the mirror of `grant-acl.use-case.test.ts`, with one refusal of its own: a
 * grant that is not there is a 404 coded on the **object**, because «there was no such grant» and
 * «there is no such project» must read alike to somebody who may not know either.
 */

const { ORG, IVAN, PETR, PROJECT, TEAM } = ids;

const manager = (): AclScope => ({
  status: 'resolved',
  organizationId: ORG,
  level: 'MANAGER',
  family: 'standard',
});

const setup = (scope: AclScope = manager()) => {
  const unitOfWork = new FakeUnitOfWork();
  const acl = new FakeAclRepository();
  const audit = new FakeAuditLogger();
  const useCase = new RevokeAclUseCase(unitOfWork, new FakeAclResolver(scope), acl, audit);

  return { unitOfWork, acl, audit, useCase };
};

const revoke = (
  overrides: Partial<Parameters<RevokeAclUseCase['execute']>[0]> = {},
): Parameters<RevokeAclUseCase['execute']>[0] => ({
  actor: actorWith(['acl:revoke']),
  resource: { type: 'PROJECT', id: PROJECT },
  subject: { type: 'TEAM', id: TEAM },
  ipAddress: '203.0.113.7',
  ...overrides,
});

const existing = () => ({
  resource: { type: 'PROJECT' as const, id: PROJECT },
  subject: { type: 'TEAM' as const, id: TEAM },
  level: 'EDITOR' as const,
  expiresAt: null,
  grantedById: PETR,
});

describe('RevokeAclUseCase', () => {
  it('removes the grant, bumps everyone it reached, and files acl.revoked with what was there', async () => {
    const { acl, audit, useCase, unitOfWork } = setup();
    const id = acl.seed(existing());
    acl.subjects.set(`TEAM:${TEAM}`, [IVAN, PETR]);

    await useCase.execute(revoke());

    expect(acl.rows).toEqual([]);
    expect(acl.bumped).toEqual([[IVAN, PETR]]);
    expect(audit.events).toEqual([
      {
        action: 'acl.revoked',
        actor: { userId: IVAN, organizationId: ORG, ipAddress: '203.0.113.7' },
        target: { type: 'RESOURCE_ACL', id },
        before: {
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

  it('answers a grant that is not there as the object’s 404, and writes nothing', async () => {
    const { acl, audit, useCase } = setup();

    await expect(useCase.execute(revoke())).rejects.toBeInstanceOf(NotFoundError);
    await expect(useCase.execute(revoke())).rejects.toMatchObject({ code: 'project_not_found' });
    expect(acl.bumped).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('runs the policy before reading the grant: without acl:revoke nothing is looked up', async () => {
    const { acl, useCase } = setup();
    acl.seed(existing());

    await expect(useCase.execute(revoke({ actor: actorWith() }))).rejects.toMatchObject({
      code: 'project_forbidden',
    });
    expect(acl.finds).toEqual([]);
    expect(acl.rows).toHaveLength(1);
  });

  it('answers a missing object as 404 before anything else', async () => {
    const { acl, useCase } = setup({ status: 'missing' });

    await expect(useCase.execute(revoke())).rejects.toMatchObject({ code: 'project_not_found' });
    expect(acl.finds).toEqual([]);
  });

  it('answers a reader that failed with 503 and removes nothing', async () => {
    const { acl, useCase } = setup({ status: 'unavailable' });
    acl.seed(existing());

    await expect(useCase.execute(revoke())).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    expect(acl.rows).toHaveLength(1);
    expect(acl.finds).toEqual([]);
  });

  it('carries the expiry of the removed grant into the trail', async () => {
    const { acl, audit, useCase } = setup();
    acl.seed({ ...existing(), expiresAt: new Date('2026-12-31T00:00:00Z') });

    await useCase.execute(revoke());

    expect(audit.events[0]).toMatchObject({ before: { expiresAt: '2026-12-31T00:00:00.000Z' } });
  });
});

import { describe, expect, it } from 'vitest';

import { ListResourceAclQuery } from '@/application/access/use-cases/list-resource-acl.query.js';
import { type AclScope } from '@/domain/access/authorize.util.js';

import { FakeClock, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

import { FakeAclRepository, FakeAclResolver, actorWith, ids } from './acl-doubles.util.js';

/**
 * `GET /acl?resourceType=&resourceId=` without the route — who holds what on one object.
 *
 * Gated as the model gates reading grants: `acl:read` **and** `VIEWER` on the object, decided
 * before a single grant is read, with refusals coded on the object (`project_*`) — the caller
 * addressed a project, and «not there» for it is the answer the project card gives too. Only live
 * grants come back: an expired row decides nothing (`acl-resolution.policy.ts`, rule 4) and the
 * moment it expired is read from the clock, not from the database's own `now()`, so the list and
 * the resolver agree on one instant.
 */

const { ORG, IVAN, PETR, PROJECT, TEAM } = ids;
const OTHER_PROJECT = '018f4a3b-0000-7000-8000-0000000000d2';
const NOW = new Date('2026-09-20T10:00:00.000Z');

const viewer = (level: 'VIEWER' | 'NONE' = 'VIEWER'): AclScope => ({
  status: 'resolved',
  organizationId: ORG,
  level,
  family: 'standard',
});

const setup = (scope: AclScope = viewer()) => {
  const unitOfWork = new FakeUnitOfWork();
  const acl = new FakeAclRepository();
  const resolver = new FakeAclResolver(scope);
  const useCase = new ListResourceAclQuery(unitOfWork, resolver, acl, new FakeClock(NOW));

  return { unitOfWork, acl, resolver, useCase };
};

const project = { type: 'PROJECT' as const, id: PROJECT };

const grant = (overrides: Partial<Parameters<FakeAclRepository['seed']>[0]> = {}) => ({
  resource: project,
  subject: { type: 'TEAM' as const, id: TEAM },
  level: 'EDITOR' as const,
  expiresAt: null,
  grantedById: PETR,
  ...overrides,
});

describe('ListResourceAclQuery', () => {
  it('CONTROL: answers the live grants of this object and of no other, inside the caller’s scope', async () => {
    const { acl, resolver, unitOfWork, useCase } = setup();
    const team = acl.seed(grant());
    const person = acl.seed(grant({ subject: { type: 'USER', id: IVAN }, level: 'VIEWER' }));
    acl.seed(grant({ resource: { type: 'PROJECT', id: OTHER_PROJECT } }));

    const entries = await useCase.execute({ actor: actorWith(['acl:read']), resource: project });

    expect(entries.map((entry) => entry.id)).toEqual([team, person]);
    expect(entries[0]).toMatchObject({ subject: { type: 'TEAM', id: TEAM }, level: 'EDITOR' });
    expect(resolver.asked.map((asked) => asked.ref)).toEqual([project]);
    expect(acl.listed).toEqual([{ resource: project, now: NOW }]);
    expect(unitOfWork.scopes).toEqual([{ organizationId: ORG, userId: IVAN }]);
  });

  it('leaves out a grant that expired before the clock’s now, and keeps one that expires after', async () => {
    const { acl, useCase } = setup();
    acl.seed(grant({ expiresAt: new Date(NOW.getTime() - 1000) }));
    const later = acl.seed(
      grant({ subject: { type: 'USER', id: IVAN }, expiresAt: new Date(NOW.getTime() + 1000) }),
    );

    const entries = await useCase.execute({ actor: actorWith(['acl:read']), resource: project });

    expect(entries.map((entry) => entry.id)).toEqual([later]);
  });

  it('refuses a caller without acl:read as 403 project_forbidden, before the object or a grant is read', async () => {
    const { acl, resolver, useCase } = setup();
    acl.seed(grant());

    await expect(useCase.execute({ actor: actorWith(), resource: project })).rejects.toMatchObject({
      code: 'project_forbidden',
      reason: 'permission_not_granted',
    });
    expect(resolver.asked).toEqual([]);
    expect(acl.listed).toEqual([]);
  });

  it('answers an object the caller cannot see as 404 project_not_found and lists nothing', async () => {
    const { acl, useCase } = setup({ status: 'missing' });
    acl.seed(grant());

    await expect(
      useCase.execute({ actor: actorWith(['acl:read']), resource: project }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
    expect(acl.listed).toEqual([]);
  });

  it('answers NONE on the project with the same 404 — the grants of a PRIVATE project are as closed as the project', async () => {
    const { acl, useCase } = setup(viewer('NONE'));
    acl.seed(grant());

    await expect(
      useCase.execute({ actor: actorWith(['acl:read']), resource: project }),
    ).rejects.toMatchObject({ code: 'project_not_found', reason: 'resource_not_found' });
    expect(acl.listed).toEqual([]);
  });

  it('answers a resolver that failed with 503 and lists nothing', async () => {
    const { acl, useCase } = setup({ status: 'unavailable' });

    await expect(
      useCase.execute({ actor: actorWith(['acl:read']), resource: project }),
    ).rejects.toMatchObject({ code: 'service_unavailable', reason: 'acl_resolution_failed' });
    expect(acl.listed).toEqual([]);
  });
});

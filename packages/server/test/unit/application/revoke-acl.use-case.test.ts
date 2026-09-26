import { describe, expect, it } from 'vitest';

import { RevokeAclUseCase } from '@/application/access/use-cases/revoke-acl.use-case.js';
import { type AclScope } from '@/domain/access/authorize.util.js';

import { FakeAuditLogger, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

import { FakeAclRepository, FakeAclResolver, actorWith, ids } from './acl-doubles.util.js';

/**
 * Taking a grant away, addressed by the grant's own id (`DELETE /acl/{aclId}`).
 *
 * The id names no object, so the row is the first thing read — and that is why every refusal here
 * is coded **`acl_*`** rather than on the object: «there is no such grant» (the id is wrong, or
 * another organization's, where the tenant scope reads nothing) and «there is such a grant on a
 * project you cannot see» must be one answer. Coding the second on the project would split them
 * into `acl_not_found` and `project_not_found`, which is an oracle for grant ids. A caller who sees
 * the object and lacks the level is told `acl_forbidden` — inside the contour, where the grant's
 * existence is not a secret (`GET /acl` on the same object lists it).
 */

const { ORG, IVAN, PETR, PROJECT, TEAM } = ids;
const NOBODYS_GRANT = '018f4a3b-0000-7000-8000-0000000000ff';

const manager = (level: 'MANAGER' | 'EDITOR' | 'NONE' = 'MANAGER'): AclScope => ({
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
  const useCase = new RevokeAclUseCase(unitOfWork, resolver, acl, audit);

  return { unitOfWork, acl, resolver, audit, useCase };
};

const revoke = (
  aclId: string,
  overrides: Partial<Parameters<RevokeAclUseCase['execute']>[0]> = {},
): Parameters<RevokeAclUseCase['execute']>[0] => ({
  actor: actorWith(['acl:revoke']),
  aclId,
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
    const { acl, audit, resolver, useCase, unitOfWork } = setup();
    const id = acl.seed(existing());
    const neighbour = acl.seed({ ...existing(), subject: { type: 'USER', id: PETR } });
    acl.subjects.set(`TEAM:${TEAM}`, [IVAN, PETR]);

    await useCase.execute(revoke(id));

    // The neighbour on the same object stays: the id names one row, not the object's grants.
    expect(acl.rows.map((row) => row.id)).toEqual([neighbour]);
    expect(acl.bumped).toEqual([[IVAN, PETR]]);
    // The level is resolved on the object the row names — not on anything the request said.
    expect(resolver.asked.map((asked) => asked.ref)).toEqual([{ type: 'PROJECT', id: PROJECT }]);
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

  /**
   * The gate's L-1. The row is read, the decision is made on it, and only then deleted — and a
   * concurrent revocation of the same id can land in between. The delete is addressed by the id and
   * reports what it removed, so the second caller removes nothing, bumps nobody and files nothing:
   * one grant, one `acl.revoked`. It is the same 404 an unknown id gets — from where the caller
   * stands, the grant is not there.
   */
  it('answers 404 acl_not_found when the grant is removed between the read and the delete, filing nothing', async () => {
    const { acl, audit, useCase } = setup();
    const id = acl.seed(existing());
    acl.subjects.set(`TEAM:${TEAM}`, [IVAN, PETR]);
    acl.afterFindById = (found) => {
      acl.rows.splice(acl.rows.indexOf(found), 1);
    };

    await expect(useCase.execute(revoke(id))).rejects.toMatchObject({
      code: 'acl_not_found',
      reason: 'resource_not_found',
    });
    expect(acl.bumped).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  /**
   * The other half of L-1: the row is re-granted (the upsert keeps its id) between the read and the
   * delete. What goes into the trail is what the statement removed, not what was read before it —
   * otherwise the entry would name a level that was no longer there when the grant ended.
   */
  it('files what the delete actually removed, not the row it read before', async () => {
    const { acl, audit, useCase } = setup();
    const id = acl.seed(existing());
    acl.afterFindById = (found) => {
      acl.rows[acl.rows.indexOf(found)] = { ...found, level: 'VIEWER' };
    };

    await useCase.execute(revoke(id));

    expect(acl.rows).toEqual([]);
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.before).toMatchObject({ accessLevel: 'VIEWER' });
  });

  it('answers an id that names no grant as 404 acl_not_found, asks the resolver nothing and writes nothing', async () => {
    const { acl, audit, resolver, useCase } = setup();
    acl.seed(existing());

    await expect(useCase.execute(revoke(NOBODYS_GRANT))).rejects.toMatchObject({
      code: 'acl_not_found',
      reason: 'resource_not_found',
    });
    expect(resolver.asked).toEqual([]);
    expect(acl.rows).toHaveLength(1);
    expect(acl.bumped).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('answers a grant on an object the caller cannot see with the same 404 acl_not_found', async () => {
    const { acl, audit, useCase } = setup({ status: 'missing' });
    const id = acl.seed(existing());

    await expect(useCase.execute(revoke(id))).rejects.toMatchObject({
      code: 'acl_not_found',
      reason: 'resource_not_found',
    });
    expect(acl.rows).toHaveLength(1);
    expect(audit.events).toEqual([]);
  });

  it('answers a grant on a project that is NONE for the caller with the same 404 acl_not_found', async () => {
    const { acl, useCase } = setup(manager('NONE'));
    const id = acl.seed(existing());

    await expect(useCase.execute(revoke(id))).rejects.toMatchObject({
      code: 'acl_not_found',
      reason: 'resource_not_found',
    });
    expect(acl.rows).toHaveLength(1);
  });

  it('refuses a caller who sees the object without MANAGER as 403 acl_forbidden, removing nothing', async () => {
    const { acl, audit, useCase } = setup(manager('EDITOR'));
    const id = acl.seed(existing());

    await expect(useCase.execute(revoke(id))).rejects.toMatchObject({
      code: 'acl_forbidden',
      reason: 'insufficient_acl_level',
    });
    expect(acl.rows).toHaveLength(1);
    expect(acl.bumped).toEqual([]);
    expect(audit.events).toEqual([]);
  });

  it('refuses a caller without acl:revoke before the grant is read, whether the id exists or not', async () => {
    const { acl, resolver, useCase } = setup();
    const id = acl.seed(existing());

    // One answer for a real id and a made-up one: the capability is decided before the row is
    // looked up, so the refusal cannot be used to test which grant ids exist.
    for (const aclId of [id, NOBODYS_GRANT]) {
      await expect(useCase.execute(revoke(aclId, { actor: actorWith() }))).rejects.toMatchObject({
        code: 'acl_forbidden',
        reason: 'permission_not_granted',
      });
    }
    expect(acl.idLookups).toEqual([]);
    expect(resolver.asked).toEqual([]);
    expect(acl.rows).toHaveLength(1);
  });

  it('answers a reader that failed with 503 and removes nothing', async () => {
    const { acl, useCase } = setup({ status: 'unavailable' });
    const id = acl.seed(existing());

    await expect(useCase.execute(revoke(id))).rejects.toMatchObject({
      code: 'service_unavailable',
      reason: 'acl_resolution_failed',
    });
    expect(acl.rows).toHaveLength(1);
  });

  it('carries the expiry of the removed grant into the trail', async () => {
    const { acl, audit, useCase } = setup();
    const id = acl.seed({ ...existing(), expiresAt: new Date('2026-12-31T00:00:00Z') });

    await useCase.execute(revoke(id));

    expect(audit.events[0]).toMatchObject({ before: { expiresAt: '2026-12-31T00:00:00.000Z' } });
  });
});

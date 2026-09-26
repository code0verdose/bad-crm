import { type SharedPermissions } from '@bad-crm/shared';

import {
  type AclEntryDraft,
  type AclEntryRow,
  type AclListEntry,
  type AclRepositoryPort,
} from '@/application/access/ports/acl-repository.port.js';
import { type AclResourceRef, type AclSubjectRef } from '@/domain/access/acl-chain.types.js';
import { bumpPermissionsVersionOf } from '@/infrastructure/persistence/prisma/permissions-version.util.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';
import { type TxClient } from '@/infrastructure/persistence/prisma/tenant.context.js';

/** One row `DELETE … RETURNING` hands back, in the column names of `resource_acl`. */
interface RemovedGrantRow {
  readonly id: string;
  readonly resource_type: SharedPermissions.AclResourceType;
  readonly resource_id: string;
  readonly access_level: SharedPermissions.AccessLevel;
  readonly expires_at: Date | null;
  readonly granted_by_id: string | null;
}

/** The same, with the subject — for a delete addressed by id, which knows neither half in advance. */
interface RemovedRow extends RemovedGrantRow {
  readonly subject_type: SharedPermissions.AclSubjectType;
  readonly subject_id: string;
}

/**
 * The grants of the current tenant, through Prisma, inside the scope the caller opened.
 *
 * Nothing here decides access — that is the reader's rows and the policy's rules. What this
 * repository knows is the *subject*: whether it is here, and whom it stands for.
 *
 * `subjectExists` answers about the subject **in this organization**, and only as a live thing —
 * a user not soft-deleted, a team not disbanded, a role that exists. The policy filters other
 * tenants out on its own, so a foreign id simply finds nothing; the point of stating the
 * `deleted_at` predicates is that a grant to somebody who has left is a grant nobody can see or
 * revoke from the interface — the orphan STORY-011-06 acceptance 13 is written against.
 */
export class PrismaResourceAclRepository
  extends TenantScopedRepository
  implements AclRepositoryPort
{
  protected readonly resource = 'organization' as const;
  protected readonly repositoryName = 'ResourceAclRepository';

  find(resource: AclResourceRef, subject: AclSubjectRef): Promise<AclEntryRow | null> {
    return this.run('find', async (tx) => {
      const row = await tx.resourceAcl.findFirst({
        where: {
          organizationId: this.organizationId('find'),
          resourceType: resource.type,
          resourceId: resource.id,
          subjectType: subject.type,
          subjectId: subject.id,
        },
        select: { id: true, accessLevel: true, expiresAt: true, grantedById: true },
      });

      return row === null
        ? null
        : {
            id: row.id,
            resource,
            subject,
            level: row.accessLevel,
            expiresAt: row.expiresAt,
            grantedById: row.grantedById,
          };
    });
  }

  findById(id: string): Promise<AclEntryRow | null> {
    return this.run('findById', async (tx) => {
      const row = await tx.resourceAcl.findFirst({
        where: { organizationId: this.organizationId('findById'), id },
        select: {
          id: true,
          resourceType: true,
          resourceId: true,
          subjectType: true,
          subjectId: true,
          accessLevel: true,
          expiresAt: true,
          grantedById: true,
        },
      });

      return row === null
        ? null
        : {
            id: row.id,
            resource: { type: row.resourceType, id: row.resourceId },
            subject: { type: row.subjectType, id: row.subjectId },
            level: row.accessLevel,
            expiresAt: row.expiresAt,
            grantedById: row.grantedById,
          };
    });
  }

  /**
   * One statement, served by `uq_resource_acl`: its leading `(organization_id, resource_id,
   * resource_type)` is exactly this predicate. The expiry is a filter over the handful of rows an
   * object carries, not an index condition — the same trade the reader makes.
   */
  listOn(resource: AclResourceRef, now: Date): Promise<readonly AclListEntry[]> {
    return this.run('listOn', async (tx) => {
      const rows = await tx.resourceAcl.findMany({
        where: {
          organizationId: this.organizationId('listOn'),
          resourceType: resource.type,
          resourceId: resource.id,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ grantedAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          subjectType: true,
          subjectId: true,
          accessLevel: true,
          expiresAt: true,
          grantedById: true,
          grantedAt: true,
        },
      });

      return rows.map((row) => ({
        id: row.id,
        resource,
        subject: { type: row.subjectType, id: row.subjectId },
        level: row.accessLevel,
        expiresAt: row.expiresAt,
        grantedById: row.grantedById,
        grantedAt: row.grantedAt,
      }));
    });
  }

  upsert(draft: AclEntryDraft): Promise<string> {
    return this.run('upsert', async (tx) => {
      const organizationId = this.organizationId('upsert');
      const { id } = await tx.resourceAcl.upsert({
        where: {
          organizationId_resourceId_resourceType_subjectId_subjectType: {
            organizationId,
            resourceId: draft.resource.id,
            resourceType: draft.resource.type,
            subjectId: draft.subject.id,
            subjectType: draft.subject.type,
          },
        },
        create: {
          organizationId,
          resourceType: draft.resource.type,
          resourceId: draft.resource.id,
          subjectType: draft.subject.type,
          subjectId: draft.subject.id,
          accessLevel: draft.level,
          expiresAt: draft.expiresAt,
          grantedById: draft.grantedById,
        },
        // The grantor and the moment are rewritten too: a changed grant is a new decision by a new
        // person, and a trail that kept the first author would name the wrong one.
        update: {
          accessLevel: draft.level,
          expiresAt: draft.expiresAt,
          grantedById: draft.grantedById,
          grantedAt: new Date(),
        },
        select: { id: true },
      });

      return id;
    });
  }

  removeById(id: string): Promise<AclEntryRow | null> {
    return this.run('removeById', async (tx) => {
      // `DELETE … RETURNING`, one statement: a concurrent revocation of the same id waits on the row
      // lock and then deletes nothing, and the row reported is the one that went — the gate's L-1.
      const rows = await tx.$queryRaw<RemovedRow[]>`
        DELETE FROM resource_acl
         WHERE organization_id = ${this.organizationId('removeById')}::uuid
           AND id = ${id}::uuid
        RETURNING id, resource_type, resource_id, subject_type, subject_id, access_level,
                  expires_at, granted_by_id`;
      const row = rows[0];

      return row === undefined
        ? null
        : {
            id: row.id,
            resource: { type: row.resource_type, id: row.resource_id },
            subject: { type: row.subject_type, id: row.subject_id },
            level: row.access_level,
            expiresAt: row.expires_at,
            grantedById: row.granted_by_id,
          };
    });
  }

  removeAllOfSubject(subject: AclSubjectRef): Promise<readonly AclEntryRow[]> {
    return this.run('removeAllOfSubject', async (tx) => {
      // One statement that deletes and reports, not a `findMany` and a `deleteMany`: a grant
      // committed between the two would be removed without the `acl.revoked` entry the caller files
      // for each row. The predicate leads with the uuid columns of `idx_resource_acl_subject`; the
      // enum after them is a filter, not an index condition, under `FORCE RLS` (`enum_eq` is not
      // leakproof — `rules/polymorphic-access.mdc`, 9).
      const rows = await tx.$queryRaw<RemovedGrantRow[]>`
        DELETE FROM resource_acl
         WHERE organization_id = ${this.organizationId('removeAllOfSubject')}::uuid
           AND subject_id = ${subject.id}::uuid
           AND subject_type = ${subject.type}::acl_subject_type
        RETURNING id, resource_type, resource_id, access_level, expires_at, granted_by_id`;

      return rows.map((row) => ({
        id: row.id,
        resource: { type: row.resource_type, id: row.resource_id },
        subject,
        level: row.access_level,
        expiresAt: row.expires_at,
        grantedById: row.granted_by_id,
      }));
    });
  }

  /**
   * Answers under a row lock held to the end of the caller's transaction — the gate's M-1, measured
   * in `test/integration/db/acl-subject-cascade.test.ts`. `resource_acl.subject_id` has no foreign
   * key, so without the lock a grant and the deletion of its subject can both proceed from the same
   * stale fact and leave a grant to nobody:
   *
   * - `TEAM` — `FOR SHARE`, and `deleted_at` read **after** the lock is granted. Disbanding is an
   *   `UPDATE` of a non-key column, which `FOR KEY SHARE` does not conflict with; a share lock makes
   *   `disband()` wait for this grant (and its `DELETE … RETURNING` then sees the new row), or makes
   *   this read wait for the disbanding and return the committed `deleted_at` — the same lock
   *   `PrismaTeamRepository.scope` takes.
   * - `ROLE` — `FOR KEY SHARE`, the lock a foreign key check would take; it conflicts with the
   *   `SELECT … FOR UPDATE` `DeleteCustomRoleUseCase` takes on the role before removing its grants
   *   (`CustomRoleRepositoryPort.lockForRemoval`). Waiting on a role that is then deleted returns no
   *   row. This lock alone is not enough — the deletion removes the grants before the role, so a
   *   grant committed between the two would outlive the role — and that is what the other half is for.
   * - `USER` — a plain count, as before. The race is between a grant and a deletion that removes
   *   the subject's grants, and only the two above do that; nothing removes a person's grants today.
   */
  subjectExists(subject: AclSubjectRef): Promise<boolean> {
    return this.run('subjectExists', async (tx) => {
      const organizationId = this.organizationId('subjectExists');

      switch (subject.type) {
        case 'USER':
          return this.userExists(tx, subject.id);
        case 'ROLE': {
          const rows = await tx.$queryRaw<{ id: string }[]>`
            SELECT id FROM roles
             WHERE organization_id = ${organizationId}::uuid
               AND id = ${subject.id}::uuid
             FOR KEY SHARE`;

          return rows.length > 0;
        }
        case 'TEAM': {
          const rows = await tx.$queryRaw<{ deleted_at: Date | null }[]>`
            SELECT deleted_at FROM teams
             WHERE organization_id = ${organizationId}::uuid
               AND id = ${subject.id}::uuid
             FOR SHARE`;
          const team = rows[0];

          return team !== undefined && team.deleted_at === null;
        }
      }
    });
  }

  subjectUserIds(subject: AclSubjectRef): Promise<readonly string[]> {
    return this.run('subjectUserIds', async (tx) => {
      const organizationId = this.organizationId('subjectUserIds');

      switch (subject.type) {
        case 'USER':
          return (await this.userExists(tx, subject.id)) ? [subject.id] : [];
        case 'ROLE': {
          const rows = await tx.userRole.findMany({
            where: { organizationId, roleId: subject.id },
            select: { userId: true },
          });

          return rows.map((row) => row.userId);
        }
        case 'TEAM': {
          const rows = await tx.teamMember.findMany({
            where: { organizationId, teamId: subject.id },
            select: { userId: true },
          });

          return rows.map((row) => row.userId);
        }
      }
    });
  }

  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void> {
    return this.run('bumpPermissionsVersionOf', (tx) =>
      bumpPermissionsVersionOf(tx, this.organizationId('bumpPermissionsVersionOf'), userIds),
    );
  }

  /** Whether the person is a live account of this organization — not soft-deleted. */
  private async userExists(tx: TxClient, userId: string): Promise<boolean> {
    const organizationId = this.organizationId('userExists');

    return (await tx.user.count({ where: { organizationId, id: userId, deletedAt: null } })) > 0;
  }
}

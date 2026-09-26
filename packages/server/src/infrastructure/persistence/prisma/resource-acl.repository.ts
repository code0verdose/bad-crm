import { type SharedPermissions } from '@bad-crm/shared';

import {
  type AclEntryDraft,
  type AclEntryRow,
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

  remove(resource: AclResourceRef, subject: AclSubjectRef): Promise<boolean> {
    return this.run('remove', async (tx) => {
      const { count } = await tx.resourceAcl.deleteMany({
        where: {
          organizationId: this.organizationId('remove'),
          resourceType: resource.type,
          resourceId: resource.id,
          subjectType: subject.type,
          subjectId: subject.id,
        },
      });

      return count > 0;
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

  subjectExists(subject: AclSubjectRef): Promise<boolean> {
    return this.run('subjectExists', async (tx) => {
      return (await this.countSubject(tx, subject)) > 0;
    });
  }

  subjectUserIds(subject: AclSubjectRef): Promise<readonly string[]> {
    return this.run('subjectUserIds', async (tx) => {
      const organizationId = this.organizationId('subjectUserIds');

      switch (subject.type) {
        case 'USER':
          return (await this.countSubject(tx, subject)) > 0 ? [subject.id] : [];
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

  /** How many rows the subject is — one or none — as a live thing of this organization. */
  private countSubject(tx: TxClient, subject: AclSubjectRef): Promise<number> {
    const organizationId = this.organizationId('countSubject');

    switch (subject.type) {
      case 'USER':
        return tx.user.count({ where: { organizationId, id: subject.id, deletedAt: null } });
      case 'ROLE':
        return tx.role.count({ where: { organizationId, id: subject.id } });
      case 'TEAM':
        return tx.team.count({ where: { organizationId, id: subject.id, deletedAt: null } });
    }
  }
}

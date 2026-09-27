import { Prisma } from '@prisma/client';

import {
  type ProjectListFacets,
  type ProjectListFilter,
  type ProjectListPage,
  type ProjectListQueryPort,
  type ProjectListSort,
  type ProjectListViewer,
} from '@/application/project/ports/project-list-query.port.js';
import {
  type ProjectOption,
  type ProjectOptionsFilter,
  type ProjectOptionsQueryPort,
} from '@/application/project/ports/project-options-query.port.js';
import { type ProjectListEntry } from '@/application/project/ports/project-repository.port.js';
import {
  PROJECT_STATUSES,
  type ProjectStatus,
  type ProjectVisibility,
} from '@/domain/project/project.enums.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

interface ListRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly visibility: string;
  readonly lead_id: string;
  readonly color: string;
  readonly member_count: number;
}

interface OptionRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: string;
  readonly color: string;
}

interface FacetRow {
  readonly facet: 'status' | 'lead';
  readonly value: string;
}

/**
 * The orders a page may be asked in, as fixed SQL — an identifier cannot be bound, so the closed
 * list of `PROJECT_LIST_SORTS` maps to closed text here and nothing a caller sends reaches the
 * statement. `v.id` last in every one: two projects with the same name must not swap places between
 * two consecutive pages.
 */
const ORDER_BY: Readonly<Record<ProjectListSort, Prisma.Sql>> = {
  name: Prisma.sql`v.name ASC, v.id ASC`,
  '-name': Prisma.sql`v.name DESC, v.id ASC`,
  key: Prisma.sql`v.key ASC, v.id ASC`,
  '-key': Prisma.sql`v.key DESC, v.id ASC`,
  createdAt: Prisma.sql`v.created_at ASC, v.id ASC`,
  '-createdAt': Prisma.sql`v.created_at DESC, v.id ASC`,
};

/** The separator of the implicit keys: `PUBLIC_ORG:-` is «a bystander of a public project». */
const NOT_A_MEMBER = '-';

/**
 * The project list — the visibility plan applied **in SQL**, once, to the page, the count and the
 * facets alike (`rules/permissions.mdc`, 8; `docs/security/permission-model.md`, «Списки —
 * отдельная задача»).
 *
 * **What the statement restates, and only that.** `isProjectVisible` in
 * `domain/project/access/visible-projects.policy.ts` is the definition: a project with a live
 * grant for the caller on its own node is judged by that grant folded to one level (`NONE` beats
 * everything, else the maximum — `access_level` is an enum declared in rank order, so `max` is the
 * rank); a project without one is judged by its `(visibility, caller's role)` pair. The plan
 * arrives as two text arrays and the statement asks two `= ANY` questions — it knows nothing about
 * owners, guests, or what `NONE` on the organization means: all of that is already inside the
 * arrays. `test/integration/db/project-list.test.ts` holds this against `can()` project by project.
 *
 * **Subjects first, grants second.** `WITH subjects` lists who the caller is to the ACL — the
 * caller as `USER`, every unexpired role assignment as `ROLE`, every team as `TEAM` — and
 * `WITH grants` joins those few rows to `resource_acl` on `(organization_id, subject_id)`, the
 * leading columns of `idx_resource_acl_subject`, then folds the caller's grants on projects to one
 * level per project: one pass, not one resolution per row. The shape is measured, not a style:
 * matching the three kinds of subject by `OR` and `IN (subquery)` on the ACL row itself left
 * `subject_id` out of every index condition, and the plan read the organization's whole ACL — a
 * parallel seq scan of ~17 400 buffers and ~130 ms per statement on 1 010 000 grants, against an
 * index scan of 18 buffers and ~1 ms in this form (PostgreSQL 16, `pgvector/pgvector:0.8.6-pg16`,
 * 2026-09-26; `test/integration/db/project-list.test.ts` holds the plan).
 * `acl-reader.adapter.ts` keeps the `OR` form on purpose: there `resource_id` is the index
 * condition and selects a handful of rows before the subjects are looked at (4 buffers, 0.02 ms on
 * the same volume).
 *
 * **The tenant predicate is written into every join** although the policy would apply it anyway: a
 * statement that relied on the policy alone would have no leading column to seek on. Measured on
 * 1 000 projects and 10 000 memberships, the plan seeks `idx_project_members_org_user`,
 * `idx_user_roles_org_user`, `idx_team_members_org_user` and `idx_resource_acl_subject` on it;
 * `projects` itself is read by a seq scan there, since one organization is the whole table, and
 * `idx_projects_org_status` is not chosen. It is also bound, never interpolated — the unit suite
 * holds the values.
 *
 * `resource_type = 'PROJECT'` and `subject_type` are filters and not index conditions, and cannot
 * be: `enum_eq` is not leakproof, so under row-level security the planner will not evaluate them
 * ahead of the policy (`docs/security/rls-design.md`, «Ловушки», 6). Both sit after the uuid they
 * qualify, where they cost a filter over the caller's own grants and nothing more.
 */
export class PrismaProjectListQuery
  extends TenantScopedRepository
  implements ProjectListQueryPort, ProjectOptionsQueryPort
{
  protected readonly resource = 'project' as const;
  protected readonly repositoryName = 'ProjectListQuery';

  page(viewer: ProjectListViewer, filter: ProjectListFilter): Promise<ProjectListPage> {
    return this.run('page', async (tx) => {
      const visible = this.visibleSet(viewer, 'page');
      const narrowed = narrowing(filter);

      // Counted with the page's own predicate, in the page's transaction — but not of the page's
      // moment: under READ COMMITTED every statement takes its own snapshot, so a project created,
      // archived or regranted between the two can make `total` differ from the rows by that much.
      // Each statement applies the visibility plan itself, so the gap can never show a hidden row;
      // it is a pager that is off by a concurrent write until the next request.
      const counted = await tx.$queryRaw<{ total: number }[]>(Prisma.sql`
        ${visible}
        SELECT count(*)::int AS total
          FROM visible v
         WHERE ${narrowed}`);
      const rows = await tx.$queryRaw<ListRow[]>(Prisma.sql`
        ${visible}
        SELECT v.id, v.key, v.name, v.status, v.visibility, v.lead_id, v.color,
               (SELECT count(*)::int
                  FROM project_members m
                 WHERE m.organization_id = v.organization_id
                   AND m.project_id      = v.id
                   AND m.left_at IS NULL) AS member_count
          FROM visible v
         WHERE ${narrowed}
         ORDER BY ${ORDER_BY[filter.sort]}
         LIMIT ${filter.perPage} OFFSET ${(filter.page - 1) * filter.perPage}`);

      return { items: rows.map(toEntry), total: counted[0]?.total ?? 0 };
    });
  }

  facets(viewer: ProjectListViewer): Promise<ProjectListFacets> {
    return this.run('facets', async (tx) => {
      const rows = await tx.$queryRaw<FacetRow[]>(Prisma.sql`
        ${this.visibleSet(viewer, 'facets')}
        SELECT 'status' AS facet, v.status AS value FROM visible v GROUP BY v.status
        UNION ALL
        SELECT 'lead' AS facet, v.lead_id::text AS value FROM visible v GROUP BY v.lead_id`);

      const statuses = new Set(
        rows.filter((row) => row.facet === 'status').map((row) => row.value),
      );

      return {
        statuses: PROJECT_STATUSES.filter((status) => statuses.has(status)),
        leadIds: rows
          .filter((row) => row.facet === 'lead')
          .map((row) => row.value)
          .toSorted(),
      };
    });
  }

  /**
   * The header switcher's read (STORY-014-06): the **same** visible set as the page and the facets
   * — the prefix below, with the same plan — narrowed by text and, for the «recent» half, by ids.
   * Five columns and no per-row subquery: the switcher is opened far more often than the list.
   */
  options(
    viewer: ProjectListViewer,
    filter: ProjectOptionsFilter,
  ): Promise<readonly ProjectOption[]> {
    return this.run('options', async (tx) => {
      const conditions: Prisma.Sql[] = [
        Prisma.sql`v.status = ANY(${[...filter.statuses]}::text[])`,
      ];

      if (filter.query !== '') conditions.push(textMatch(filter.query));
      // `null` is «no id filter»; an empty array binds as «none of them».
      if (filter.ids !== null) conditions.push(Prisma.sql`v.id = ANY(${[...filter.ids]}::uuid[])`);

      const rows = await tx.$queryRaw<OptionRow[]>(Prisma.sql`
        ${this.visibleSet(viewer, 'options')}
        SELECT v.id, v.key, v.name, v.status, v.color
          FROM visible v
         WHERE ${Prisma.join(conditions, ' AND ')}
         ORDER BY v.name ASC, v.id ASC
         LIMIT ${filter.limit}`);

      return rows.map(toOption);
    });
  }

  /**
   * `WITH subjects …, grants …, visible …` — the caller's visible projects with their membership,
   * as a prefix every statement of this adapter starts with.
   */
  /**
   * An empty list in the plan is an empty array — «nothing is visible through this branch» — and the
   * statement keeps its shape, so a caller who sees nothing sends the same statement as one who
   * sees everything.
   */
  private visibleSet(viewer: ProjectListViewer, operation: string): Prisma.Sql {
    const organizationId = this.organizationId(operation);
    const readable = [...viewer.plan.readableExplicitLevels];
    const implicit = viewer.plan.implicitlyVisible.map(
      (cell) => `${cell.visibility}:${cell.memberRole ?? NOT_A_MEMBER}`,
    );

    return Prisma.sql`
      WITH subjects (subject_type, subject_id) AS (
        SELECT 'USER'::acl_subject_type, ${viewer.userId}::uuid
        UNION ALL
        SELECT 'ROLE'::acl_subject_type, ur.role_id
          FROM user_roles ur
         WHERE ur.organization_id = ${organizationId}::uuid
           AND ur.user_id         = ${viewer.userId}::uuid
           AND (ur.expires_at IS NULL OR ur.expires_at > now())
        UNION ALL
        SELECT 'TEAM'::acl_subject_type, tm.team_id
          FROM team_members tm
         WHERE tm.organization_id = ${organizationId}::uuid
           AND tm.user_id         = ${viewer.userId}::uuid
      ),
      grants AS (
        SELECT a.resource_id AS project_id,
               CASE WHEN bool_or(a.access_level = 'NONE') THEN 'NONE'
                    ELSE max(a.access_level)::text END AS level
          FROM subjects s
          JOIN resource_acl a
            ON a.organization_id = ${organizationId}::uuid
           AND a.subject_id      = s.subject_id
           AND a.subject_type    = s.subject_type
         WHERE a.resource_type = 'PROJECT'
           AND (a.expires_at IS NULL OR a.expires_at > now())
         GROUP BY a.resource_id
      ),
      visible AS (
        SELECT p.id, p.organization_id, p.key, p.name, p.status, p.visibility, p.lead_id, p.color,
               p.created_at, pm.project_role AS member_role
          FROM projects p
          LEFT JOIN project_members pm
            ON pm.organization_id = p.organization_id
           AND pm.project_id      = p.id
           AND pm.user_id         = ${viewer.userId}::uuid
           AND pm.left_at IS NULL
          LEFT JOIN grants g ON g.project_id = p.id
         WHERE p.organization_id = ${organizationId}::uuid
           AND p.deleted_at IS NULL
           AND CASE WHEN g.level IS NULL
                    THEN (p.visibility || ':' || COALESCE(pm.project_role, ${NOT_A_MEMBER}))
                         = ANY(${implicit}::text[])
                    ELSE g.level = ANY(${readable}::text[])
               END
      )`;
  }
}

/** The caller's own filters, on top of the visible set — `TRUE` when there are none. */
const narrowing = (filter: ProjectListFilter): Prisma.Sql => {
  const conditions: Prisma.Sql[] = [Prisma.sql`v.status = ANY(${[...filter.statuses]}::text[])`];

  if (filter.query !== '') conditions.push(textMatch(filter.query));

  if (filter.leadId !== null) conditions.push(Prisma.sql`v.lead_id = ${filter.leadId}::uuid`);

  // «The projects I am on» is the caller's live membership, already joined for the plan.
  if (filter.memberOnly) conditions.push(Prisma.sql`v.member_role IS NOT NULL`);

  return Prisma.join(conditions, ' AND ');
};

/** The name or the key contains what was typed — the list's and the switcher's one text match. */
const textMatch = (query: string): Prisma.Sql => {
  const pattern = `%${escapeLike(query)}%`;

  return Prisma.sql`(v.name ILIKE ${pattern} ESCAPE '\\' OR v.key ILIKE ${pattern} ESCAPE '\\')`;
};

/** `%`, `_` and the escape character are text the person typed, not patterns. */
const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/g, (match) => `\\${match}`);

const toEntry = (row: ListRow): ProjectListEntry => ({
  projectId: row.id,
  key: row.key,
  name: row.name,
  // `TEXT` held by `ck_projects_status` / `ck_projects_visibility`; the narrowing states the
  // constraint, as `project.repository.ts` does.
  status: row.status as ProjectStatus,
  visibility: row.visibility as ProjectVisibility,
  leadId: row.lead_id,
  color: row.color,
  memberCount: row.member_count,
});

const toOption = (row: OptionRow): ProjectOption => ({
  projectId: row.id,
  key: row.key,
  name: row.name,
  // `TEXT` held by `ck_projects_status`, as in `toEntry`.
  status: row.status as ProjectStatus,
  color: row.color,
});

/**
 * The closed lists of the project domain, exactly as `docs/architecture/data-model.md` §3 names
 * them and as the `CHECK` constraints of `projects` and `project_members` hold them.
 *
 * Text with a `CHECK` rather than a PostgreSQL enum, for the reason `team_role` gives: adding a
 * value to an enum is DDL on a type every table using it depends on. The two copies — this file and
 * the migration — are held together by `test/unit/domain/project/project-enums.test.ts`, which
 * parses the constraint out of the migration and compares.
 */

export const PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'ARCHIVED', 'CLOSED'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * `PUBLIC_ORG` — visible to every member of the organization; `PRIVATE` — reachable only through
 * `ProjectMember` and `ResourceAcl`. Not row-level security: RLS cuts other organizations off, and
 * visibility is a domain rule the policy layer applies inside one (`data-model.md`, «Про
 * `visibility`»).
 */
export const PROJECT_VISIBILITIES = ['PUBLIC_ORG', 'PRIVATE'] as const;

export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

/**
 * The role a person holds on a project. It is the source of the implicit access level of
 * `permission-model.md` §5 — `LEAD → MANAGER`, `MEMBER → EDITOR`, `REVIEWER → COMMENTER`,
 * `OBSERVER → VIEWER` — but that mapping is made once, in `domain/access/implicit-level.policy.ts`,
 * not by this list.
 */
export const PROJECT_ROLES = ['LEAD', 'MEMBER', 'REVIEWER', 'OBSERVER'] as const;

export type ProjectRole = (typeof PROJECT_ROLES)[number];

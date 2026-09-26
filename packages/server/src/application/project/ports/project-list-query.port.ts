import { type ProjectListEntry } from '@/application/project/ports/project-repository.port.js';
import { type ProjectVisibilityPlan } from '@/domain/project/access/visible-projects.policy.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';

/**
 * How a page of projects is ordered. Every order carries `id` as the last key in the adapter, so
 * two projects with the same name cannot swap places between two consecutive pages.
 */
export const PROJECT_LIST_SORTS = [
  'name',
  '-name',
  'key',
  '-key',
  'createdAt',
  '-createdAt',
] as const;

export type ProjectListSort = (typeof PROJECT_LIST_SORTS)[number];

/**
 * What a caller narrows the list by — the visible set first, these after.
 *
 * `leadId` and `memberOnly` are separate on purpose: «led by Ivan» is a column of the row, «the
 * projects I am on» is a live membership of the caller, resolved from the session and never taken
 * from the client (STORY-014-04, acceptance 8). There is no `clientId`: `Project.clientId` exists
 * in `data-model.md` and not in the schema — clients arrive with STORY-014-07.
 */
export interface ProjectListFilter {
  /** Trimmed; empty means «no text filter». Matched against the name and the key. */
  readonly query: string;
  /** Never empty here: the query decides the default of the screen. */
  readonly statuses: readonly ProjectStatus[];
  readonly leadId: string | null;
  readonly memberOnly: boolean;
  readonly sort: ProjectListSort;
  /** One-based, as the URL carries it. */
  readonly page: number;
  readonly perPage: number;
}

/**
 * Whose list this is: the plan decides which rows are visible, `userId` is the person whose
 * memberships and grants the plan is applied to. No `organizationId` — the tenant is the scope the
 * caller opened (`rules/tenancy-rls.mdc`, 9).
 */
export interface ProjectListViewer {
  readonly userId: string;
  readonly plan: ProjectVisibilityPlan;
}

export interface ProjectListPage {
  readonly items: readonly ProjectListEntry[];
  /** Rows matching the same predicate — visibility and filters — before pagination. */
  readonly total: number;
}

/**
 * The values the filters can take **among the projects this caller can see**, and nothing else: a
 * status or a lead that exists only on a project hidden from them would say that project is there
 * (STORY-014-04, acceptance 5 — «ни в фасетах фильтров»). Computed over the visible set without the
 * caller's own filters, so choosing one status does not make the others disappear from the picker.
 */
export interface ProjectListFacets {
  readonly statuses: readonly ProjectStatus[];
  readonly leadIds: readonly string[];
}

/**
 * The project list as a read model — a `*-query.port.ts` in the sense of
 * `rules/hexagonal-backend.mdc` 6: flat rows, a count, the facets; no aggregate, no decision.
 *
 * **The decision arrives as data.** Which rows are visible is the plan `visible-projects.policy.ts`
 * computed from the caller's organization node; the adapter restates it as one predicate and applies
 * it in SQL to the page, the count and the facets alike (`rules/permissions.mdc`, 8). A port that
 * took an `Actor` instead would have to decide, and deciding is the domain's.
 */
export interface ProjectListQueryPort {
  page(viewer: ProjectListViewer, filter: ProjectListFilter): Promise<ProjectListPage>;

  facets(viewer: ProjectListViewer): Promise<ProjectListFacets>;
}

import { type ProjectListSort } from '@/application/project/ports/project-list-query.port.js';
import { type ProjectListEntry } from '@/application/project/ports/project-repository.port.js';
import { type VisibleProjectPage } from '@/application/project/use-cases/list-projects.query.js';
import { type ProjectStatus, type ProjectVisibility } from '@/domain/project/project.enums.js';

/**
 * One row of the list → the `ProjectListItem` schema of `docs/api/openapi.yaml`.
 *
 * A whitelist, field by field, like the card's serializer: the read model is shaped for the query
 * and a spread would put whatever it grows next on the wire. **No money is here, and none can
 * arrive by accident** (STORY-014-04, acceptance 6): budget and burn are behind
 * `project:view_budget`, the read model has no such field, and the HTTP suite holds the keys with
 * `toEqual`.
 */
export interface ProjectListItemResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly visibility: ProjectVisibility;
  readonly leadId: string;
  readonly color: string;
  readonly memberCount: number;
}

export interface ProjectListPageResponse {
  readonly items: readonly ProjectListItemResponse[];
  readonly total: number;
  readonly page: number;
  readonly perPage: number;
  readonly sort: ProjectListSort;
  readonly facets: {
    readonly statuses: readonly ProjectStatus[];
    readonly leadIds: readonly string[];
  };
}

export const serializeProjectListItem = (project: ProjectListEntry): ProjectListItemResponse => ({
  id: project.projectId,
  key: project.key,
  name: project.name,
  status: project.status,
  visibility: project.visibility,
  leadId: project.leadId,
  color: project.color,
  memberCount: project.memberCount,
});

export const serializeProjectListPage = (page: VisibleProjectPage): ProjectListPageResponse => ({
  items: page.items.map(serializeProjectListItem),
  total: page.total,
  page: page.page,
  perPage: page.perPage,
  sort: page.sort,
  facets: { statuses: [...page.facets.statuses], leadIds: [...page.facets.leadIds] },
});

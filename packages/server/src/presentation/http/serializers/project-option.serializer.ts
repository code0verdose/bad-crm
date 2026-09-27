import { type ProjectOption } from '@/application/project/ports/project-options-query.port.js';
import { type ProjectOptionList } from '@/application/project/use-cases/list-project-options.query.js';
import { type ProjectStatus } from '@/domain/project/project.enums.js';

/**
 * One switcher row → the `ProjectOption` schema of `docs/api/openapi.yaml`. A whitelist, field by
 * field, like every serializer of this surface: whatever the read model grows next stays off the
 * wire until the contract names it.
 */
export interface ProjectOptionResponse {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly status: ProjectStatus;
  readonly color: string;
}

export interface ProjectOptionListResponse {
  readonly items: readonly ProjectOptionResponse[];
  readonly hasMore: boolean;
  readonly recent: readonly ProjectOptionResponse[];
}

export const serializeProjectOption = (option: ProjectOption): ProjectOptionResponse => ({
  id: option.projectId,
  key: option.key,
  name: option.name,
  status: option.status,
  color: option.color,
});

export const serializeProjectOptionList = (list: ProjectOptionList): ProjectOptionListResponse => ({
  items: list.items.map(serializeProjectOption),
  hasMore: list.hasMore,
  recent: list.recent.map(serializeProjectOption),
});

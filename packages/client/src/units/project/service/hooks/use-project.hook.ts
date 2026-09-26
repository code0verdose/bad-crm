import { type ProjectDetail } from '@units/project/api';
import { dateProgress } from '@units/project/lib';
import { PROJECT_STATUS_LABEL, PROJECT_VISIBILITY_LABEL } from '@units/project/model';
import { useProjectDetailQuery } from '@units/project/service/queries/project-detail.query.js';
import { type DateProgress } from '@units/project/types';

export interface ProjectView {
  readonly project: ProjectDetail;
  /** `ARCHIVED` — the card says so in a banner, and nothing on it may change the project. */
  readonly isArchived: boolean;
  readonly statusLabelKey: string;
  readonly visibilityLabelKey: string;
  /** How far the calendar has moved between start and deadline; `null` without both dates. */
  readonly progress: DateProgress | null;
}

/**
 * One project as its card renders it — the unit's public API for `ui` (`rules/frontend-fsd.mdc`
 * rule 6).
 *
 * **No `status` field, unlike every other read hook of the tree, and that is the point.** The route
 * has already loaded the card in `beforeLoad` (`requireProjectAccess`); this reads the same cache
 * entry under Suspense, so there is no pending and no error state to hand to a `DataState` — both
 * belong to the route's own boundaries (STORY-014-05, acceptance 3).
 *
 * The clock is read here, once per render, and handed to a pure function — never inside a row.
 */
export const useProject = (projectId: string): ProjectView => {
  const { data: project } = useProjectDetailQuery(projectId);

  return {
    project,
    isArchived: project.status === 'ARCHIVED',
    statusLabelKey: PROJECT_STATUS_LABEL[project.status],
    visibilityLabelKey: PROJECT_VISIBILITY_LABEL[project.visibility],
    progress: dateProgress(project.startedAt, project.dueAt, new Date()),
  };
};

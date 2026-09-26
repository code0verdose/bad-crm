/**
 * Where a project is in its life (`docs/api/openapi.yaml` → `ProjectDetail.status`).
 *
 * The labels are **keys**, never text (`rules/i18n.mdc` §5), and written out rather than built from
 * the value: a key assembled at runtime cannot be found by reading the source (ADR-0019).
 */
export const PROJECT_STATUSES = ['ACTIVE', 'ON_HOLD', 'ARCHIVED', 'CLOSED'] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABEL: Readonly<Record<ProjectStatus, string>> = {
  ACTIVE: 'projects.status.ACTIVE',
  ON_HOLD: 'projects.status.ON_HOLD',
  ARCHIVED: 'projects.status.ARCHIVED',
  CLOSED: 'projects.status.CLOSED',
};

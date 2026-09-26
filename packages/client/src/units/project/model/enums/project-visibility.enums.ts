/** Who a project is visible to — the whole organization or only the people on it. */
export const PROJECT_VISIBILITIES = ['PUBLIC_ORG', 'PRIVATE'] as const;

export type ProjectVisibility = (typeof PROJECT_VISIBILITIES)[number];

export const PROJECT_VISIBILITY_LABEL: Readonly<Record<ProjectVisibility, string>> = {
  PUBLIC_ORG: 'projects.visibility.PUBLIC_ORG',
  PRIVATE: 'projects.visibility.PRIVATE',
};

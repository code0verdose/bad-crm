import { type ProjectSection } from '@units/project/model/constants/project-sections.constant.js';

/** The routes of a project card a switch can land on — the shipped sections, nothing else. */
export type ProjectSwitchRoute =
  '/projects/$projectId' | '/projects/$projectId/members' | '/projects/$projectId/settings';

/** Where each shipped section lives; an unshipped one has no route, so it lands on the overview. */
const SECTION_ROUTE: Readonly<Partial<Record<ProjectSection, ProjectSwitchRoute>>> = {
  overview: '/projects/$projectId',
  members: '/projects/$projectId/members',
  settings: '/projects/$projectId/settings',
};

export interface ProjectSwitchTarget {
  readonly to: ProjectSwitchRoute;
  readonly params: { readonly projectId: string };
}

/**
 * Where choosing `projectId` in the switcher leads (STORY-014-06, acceptance 2): the **same section**
 * of the other project, so «members of p1» becomes «members of p2». Outside a project — `section`
 * is `null` — it is the overview.
 *
 * The search parameters are not carried: every one a project section has today names something of
 * *that* project (a member filter, a folder), and a filter of p1 applied to p2 is a filter nobody
 * chose. When a section grows a parameter that means the same in every project (`view`, `sort`),
 * it is carried here, by name.
 *
 * Settings is carried too, although the reader may hold no settings command on the other project:
 * the settings screen already answers that with a sentence rather than a 404, which is what
 * `settings.tsx` promises, and guessing here would be a second place deciding access.
 */
export const projectSwitchTarget = (
  projectId: string,
  section: ProjectSection | null,
): ProjectSwitchTarget => ({
  to: (section === null ? undefined : SECTION_ROUTE[section]) ?? '/projects/$projectId',
  params: { projectId },
});

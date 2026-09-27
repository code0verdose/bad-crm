import { useMatchRoute, useNavigate } from '@tanstack/react-router';

import { ProjectService, type ProjectModel } from '@units/project';

export interface ProjectSectionNavigation {
  /** The section whose route is on screen. */
  readonly active: ProjectModel.ProjectSection;
  /** Tabs this reader does not see at all. */
  readonly hidden: readonly ProjectModel.ProjectSection[];
  readonly select: (section: ProjectModel.ProjectSection) => void;
}

/**
 * Which tab of the card is selected, which are drawn, and where choosing one leads — the page's own
 * glue between the route tree and the unit's tab list (`rules/frontend-fsd.mdc` exceptions: page-scoped
 * hooks live in `pages/<page>/hooks`).
 *
 * The selected tab is **read from the route**, never stored: the address is the state, so a pasted
 * link and the back button select the right tab without anything copying it anywhere.
 *
 * Settings is hidden when the card's `permissions` block opens none of its commands — the block and
 * nothing else, never the reader's capability set (STORY-014-05, acceptance 5 — «Настройки» is
 * absent for a viewer).
 * Only the shipped sections navigate; the others are disabled tabs and never call `select`.
 */
export const useProjectSection = (projectId: string): ProjectSectionNavigation => {
  const matchRoute = useMatchRoute();
  const navigate = useNavigate();
  const controls = ProjectService.ProjectHooks.useProjectControls(projectId);

  const active: ProjectModel.ProjectSection =
    matchRoute({ to: '/projects/$projectId/members', params: { projectId } }) !== false
      ? 'members'
      : matchRoute({ to: '/projects/$projectId/settings', params: { projectId } }) !== false
        ? 'settings'
        : 'overview';

  const hidden: readonly ProjectModel.ProjectSection[] = controls.hasSettings ? [] : ['settings'];

  const select = (section: ProjectModel.ProjectSection): void => {
    if (section === 'members') {
      void navigate({ to: '/projects/$projectId/members', params: { projectId } });
    } else if (section === 'settings') {
      void navigate({ to: '/projects/$projectId/settings', params: { projectId } });
    } else {
      void navigate({ to: '/projects/$projectId', params: { projectId } });
    }
  };

  return { active, hidden, select };
};

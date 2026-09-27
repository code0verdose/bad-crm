import { useMatches, useNavigate } from '@tanstack/react-router';

import { IamService } from '@units/iam';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';

/**
 * The project switcher, wired to the router (STORY-014-06).
 *
 * The widget does the two things the unit must not: it reads where the reader stands from the
 * matched routes, and it performs the navigation. Everything else — what is offered, what is
 * recent, which section a switch keeps — is `useProjectSwitcher`.
 *
 * Hidden from somebody without `project:read`: a switcher whose every open answers 403 is a control
 * that cannot work. `holds`, like the sidebar — a hint for the interface, not a check: the server
 * refuses the read regardless (`rules/permissions.mdc` §11).
 */
export function ProjectSwitcherBar() {
  const { holds } = IamService.IamHooks.useCan();
  const navigate = useNavigate();
  const location = ProjectLib.projectLocation(useMatches());
  const switcher = ProjectService.ProjectHooks.useProjectSwitcher({
    currentProjectId: location.projectId,
    section: location.section,
    onSwitch: (target) => {
      void navigate(target);
    },
  });

  if (!holds('project:read')) return null;

  return <ProjectUi.ProjectSwitcher switcher={switcher} />;
}

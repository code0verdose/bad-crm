import { useMatches, useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';

import { AuthLib } from '@units/auth';
import { ProjectLib, ProjectService, ProjectUi } from '@units/project';

export interface SignedInProjectSwitcherProps {
  /** Whose remembered projects the switcher reads and writes. */
  readonly userId: string;
}

/**
 * The switcher of one signed-in person, wired to the router (STORY-014-06).
 *
 * It does the two things the unit must not: it reads where the reader stands from the matched
 * routes, and it performs the navigation. Everything else — what is offered, what is recent,
 * which section a switch keeps — is `useProjectSwitcher`.
 *
 * Mounted only with a person to name: the remembered list lives under their key, and a switcher
 * without one would have to read and write storage under a key that belongs to nobody.
 */
export function SignedInProjectSwitcher({ userId }: SignedInProjectSwitcherProps) {
  const navigate = useNavigate();
  const location = ProjectLib.projectLocation(useMatches());
  const switcher = ProjectService.ProjectHooks.useProjectSwitcher({
    userId,
    currentProjectId: location.projectId,
    section: location.section,
    onSwitch: (target) => {
      void navigate(target);
    },
  });

  const { forgetRemembered } = switcher;

  // A subscription to an external source, with its cleanup (`rules/frontend-fsd.mdc` rule 11): the
  // end of a session is an event of `units/auth`, and the browser's copy of the list goes with it.
  // Here and not in the unit's hook — units do not import each other; the tab's in-memory visits
  // are reset by the session-event subscriber in `app/`.
  useEffect(
    () =>
      AuthLib.onAuthEvent((event) => {
        if (event === 'logged-out') forgetRemembered();
      }),
    [forgetRemembered],
  );

  return <ProjectUi.ProjectSwitcher switcher={switcher} />;
}

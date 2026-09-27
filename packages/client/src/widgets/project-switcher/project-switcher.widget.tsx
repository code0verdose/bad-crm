import { AuthService } from '@units/auth';
import { IamService } from '@units/iam';

import { SignedInProjectSwitcher } from './ui/signed-in-project-switcher.component.js';

/**
 * The project switcher in the header (STORY-014-06) — shown to a signed-in person who may read
 * projects.
 *
 * Hidden from somebody without `project:read`: a switcher whose every open answers 403 is a control
 * that cannot work. `holds`, like the sidebar — a hint for the interface, not a check: the server
 * refuses the read regardless (`rules/permissions.mdc` §11).
 *
 * Hidden, too, until the session names its person: what the switcher remembers is that person's
 * (`recentProjectsStorageKey`), and nothing is read or written for nobody.
 */
export function ProjectSwitcherBar() {
  const { holds } = IamService.IamHooks.useCan();
  const session = AuthService.useBootstrapSession();

  if (session.status !== 'authenticated' || !holds('project:read')) return null;

  return <SignedInProjectSwitcher userId={session.userId} />;
}

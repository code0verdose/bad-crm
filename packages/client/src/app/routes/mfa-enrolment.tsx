/**
 * The page is imported from **its own module**, not from the `@pages` barrel — the barrel pulls
 * every screen into one shared chunk and defeats the route-level code splitting (STORY-012-03).
 */
import { createFileRoute } from '@tanstack/react-router';

import { MfaEnrolmentPage } from '@pages/mfa-enrolment';
import { AuthLib } from '@units/auth';

/**
 * `/mfa-enrolment` — wiring only (`rules/frontend-fsd.mdc` rule 10).
 *
 * **Outside `_authenticated`, and it has to be.** The screen needs a session like every screen
 * behind that branch, but the branch's guard is now `requireFullSession`, which sends a scoped
 * session *here* — mounted underneath it, this route would be a redirect loop with itself. So it
 * carries its own guard, `requireEnrolment`, which asks the session question and then the mirror of
 * the scope one: a session that is not scoped has no business on a wizard that tells people their
 * organization demands a second factor.
 *
 * That guard is also the way out. Finishing the enrolment rotates the session (`useMfaEnrolment`),
 * the router re-checks its guards, and this one carries the person into the application — which is
 * why the page navigates nowhere itself, the same arrangement `/login` and `/register` use.
 *
 * **No permission**, and none is possible: enrolling a second factor for one's own account is
 * self-service, and the two endpoints behind the screen are declared that way in the route registry.
 * No loader either — the wizard starts from a button, not from a read.
 */
export const Route = createFileRoute('/mfa-enrolment')({
  beforeLoad: AuthLib.requireEnrolment,
  component: MfaEnrolmentPage,
  staticData: { crumbKey: 'security.enrolment.title' },
});

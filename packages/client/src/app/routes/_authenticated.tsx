import { createFileRoute } from '@tanstack/react-router';

import { AuthLib } from '@units/auth';
import { AuthenticatedLayout } from '@app/ui';

/**
 * The pathless layout that owns the session check.
 *
 * Pathless (`_authenticated`, leading underscore) because it adds no segment to any URL: it exists
 * to hold one `beforeLoad` and one layout for the whole protected half of the application. The
 * guard therefore runs once per branch, not once per leaf — the leaves inherit it, and a new screen
 * added under here is protected by existing rather than by remembering
 * (`ux-architecture.md` → «Гарды в `beforeLoad`»).
 *
 * The guard asks two questions, not one: is there a session, and may it do more than enrol a second
 * factor. The second arrived with STORY-013-05 and is mounted **here** rather than per route for
 * exactly the argument above — the server refuses every route outside a three-entry whitelist to a
 * scoped session, so a screen this branch had not covered would be a screen where every control
 * answers 403 with nothing on it explaining what is wanted. `/mfa-enrolment` is the one authenticated
 * screen outside this branch, because it is where that guard sends people.
 */
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: AuthLib.requireFullSession,
  component: AuthenticatedLayout,
});

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
 */
export const Route = createFileRoute('/_authenticated')({
  beforeLoad: AuthLib.requireSession,
  component: AuthenticatedLayout,
});

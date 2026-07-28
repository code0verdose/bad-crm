import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';

import { SharedUi } from '@shared';

/**
 * One screen for «there is no such thing» and «you may not see it»
 * (`ux-architecture.md` → «403 vs 404»).
 *
 * The wording is deliberately unable to tell the two apart: a 404 that differs from a 403 turns the
 * application into an oracle for the existence of other people's projects, documents and channels —
 * the same reason invariant 2 in CLAUDE.md makes the *server* answer 404 for a foreign tenant. The
 * screen keeps the shell around it, so the navigation is still there to leave by.
 */
export function RouteNotFound() {
  return (
    <SharedUi.EmptyState
      action={
        <Button component={Link} to="/dashboard" variant="light">
          errors.not_found.action
        </Button>
      }
      descriptionKey="errors.not_found.description"
      titleKey="errors.not_found.title"
    />
  );
}

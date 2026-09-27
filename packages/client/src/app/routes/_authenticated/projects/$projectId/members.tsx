import { createFileRoute } from '@tanstack/react-router';

import { ProjectMembersPage } from '@pages/project';

/**
 * `/projects/$projectId/members` — the roster section; wiring only (STORY-014-02).
 *
 * No guard of its own: the layout above has decided access and loaded the card, and reading the
 * roster needs exactly what reading the card needs (`project:read`, `VIEWER` on the chain). What the
 * reader may *change* here is the card's `permissions` block, read by the section itself.
 */
export const Route = createFileRoute('/_authenticated/projects/$projectId/members')({
  component: ProjectMembersPage,
});

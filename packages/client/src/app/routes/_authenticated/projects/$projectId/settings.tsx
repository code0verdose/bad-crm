import { createFileRoute } from '@tanstack/react-router';

import { ProjectSettingsPage } from '@pages/project';

/**
 * `/projects/$projectId/settings` — editing, visibility and the danger zone; wiring only
 * (STORY-014-01).
 *
 * No guard beyond the layout's: which sections a reader sees is the card's `permissions` block, and a
 * reader it opens nothing to sees a sentence saying so instead of a 404 for a project they can read.
 */
export const Route = createFileRoute('/_authenticated/projects/$projectId/settings')({
  component: ProjectSettingsPage,
});

import { createFileRoute } from '@tanstack/react-router';

import { ProjectOverviewPage } from '@pages/project';

/**
 * `/projects/$projectId/` — the overview section; wiring only.
 *
 * No guard of its own: the layout above has already decided access and loaded the card. No search
 * schema either — the story names `?range=` for the «recent changes» block, and that block has no
 * operation behind it yet (the audit read is STORY-016-03); a parameter nothing reads is not state.
 */
export const Route = createFileRoute('/_authenticated/projects/$projectId/')({
  component: ProjectOverviewPage,
});

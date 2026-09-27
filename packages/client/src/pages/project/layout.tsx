import { Stack } from '@mantine/core';
import { Outlet, getRouteApi } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { ProjectHeader } from '@widgets/project-header';
import { ProjectService, ProjectUi } from '@units/project';

import { useProjectSection } from './hooks/use-project-section.hook.js';

const route = getRouteApi('/_authenticated/projects/$projectId');

/**
 * `/projects/$projectId/**` — the frame every section of a project card shares: the heading, the
 * project's head and the tab list, with the active section's route in the panel. Composition only.
 *
 * The `h1` is the project's «KEY · Name» (STORY-014-06, acceptance 8), read from the cached card
 * by `useProjectTitle` — the same source as the tab and the route announcement, so focus lands on a
 * heading that says what was just announced. The three part on one point: after a rename the
 * heading and the tab follow at once, while the announcement keeps what it said on arrival — a
 * rename is not a new page (`widgets/route-announcer`, `spokenPage`). The breadcrumb carries the
 * same title but is not drawn here: the project is its only crumb. The route's key («Project»)
 * stays the fallback. The name is also the `h2` of the head, where it is data among data.
 *
 * Which tab is selected is the route's to say, and which tabs a reader sees is the card's
 * `permissions` block's — both through `useProjectSection`.
 */
export function ProjectLayout() {
  const { projectId } = route.useParams();
  const section = useProjectSection(projectId);
  const title = ProjectService.ProjectHooks.useProjectTitle(projectId);

  return (
    <Stack gap="md">
      <SharedUi.PageHeader
        breadcrumbs={<Breadcrumbs />}
        title={title}
        titleKey="projects.detail.title"
      />
      <ProjectHeader projectId={projectId} />
      <ProjectUi.ProjectTabs
        active={section.active}
        hidden={section.hidden}
        onSelect={section.select}
      >
        <Outlet />
      </ProjectUi.ProjectTabs>
    </Stack>
  );
}

import { Stack } from '@mantine/core';
import { Outlet, getRouteApi } from '@tanstack/react-router';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { ProjectHeader } from '@widgets/project-header';
import { ProjectUi } from '@units/project';

const route = getRouteApi('/_authenticated/projects/$projectId');

/**
 * `/projects/$projectId/**` — the frame every section of a project card shares: the heading, the
 * project's head and the tab list, with the active section's route in the panel. Composition only.
 *
 * The `h1` is the generic «Project» rather than the project's name, for the reason the team page
 * gives: `PageHeader` takes an i18n key, and the breadcrumbs and the route announcer read the same
 * key. The name is the `h2` of the head, where it is data among data.
 *
 * The overview is the only section with a route today, so it is the active tab on every path under
 * this layout; a second section passes its own value when its route arrives.
 */
export function ProjectLayout() {
  const { projectId } = route.useParams();

  return (
    <Stack gap="md">
      <SharedUi.PageHeader breadcrumbs={<Breadcrumbs />} titleKey="projects.detail.title" />
      <ProjectHeader projectId={projectId} />
      <ProjectUi.ProjectTabs active="overview">
        <Outlet />
      </ProjectUi.ProjectTabs>
    </Stack>
  );
}

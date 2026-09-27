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
 * The `h1` is the project's «KEY · Name» (STORY-014-06, acceptance 8): the same words as the last
 * breadcrumb, the tab and the route announcement, because focus lands on this heading after a
 * navigation and a reader hears all four. The route's key («Project») stays the fallback. The name
 * is also the `h2` of the head, where it is data among data.
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

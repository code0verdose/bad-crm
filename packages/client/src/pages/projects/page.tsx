import { Button, Stack } from '@mantine/core';
import { getRouteApi, Link } from '@tanstack/react-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { Breadcrumbs } from '@widgets/breadcrumbs';
import { ProjectList } from '@widgets/project-list';
import { IamUi } from '@units/iam';
import { type ProjectService } from '@units/project';

const route = getRouteApi('/_authenticated/projects/');

/**
 * `/projects` — composition only (`rules/frontend-fsd.mdc` rule 7).
 *
 * It reads the typed search of the route and hands it, with a way to write it back, to the widget;
 * the filter logic lives in the unit's hook, and the URL is the only state there is.
 *
 * «New project» sits in the header for somebody who may create one (`<Can permission="project:create">`,
 * a hint — the server decides), and leads to `/projects/new`. It waited for that route: an action
 * leading nowhere is a dead end.
 */
export function ProjectsPage() {
  const { t } = useTranslation();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  /**
   * The router's `navigate`, narrowed to what the unit needs — wrapped rather than passed through,
   * because `units/` must not depend on the generated route tree two layers above it.
   */
  const write = useCallback<ProjectService.ProjectHooks.ProjectSearchNavigation>(
    (input) => {
      void navigate({ search: input.search, replace: input.replace });
    },
    [navigate],
  );

  return (
    <Stack gap="md">
      <SharedUi.PageHeader
        actions={
          <IamUi.Can permission="project:create">
            <Button component={Link} to="/projects/new">
              {t('projects.list.create')}
            </Button>
          </IamUi.Can>
        }
        breadcrumbs={<Breadcrumbs />}
        titleKey="projects.list.title"
      />
      <ProjectList navigate={write} search={search} />
    </Stack>
  );
}

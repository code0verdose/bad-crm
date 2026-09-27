import { Button } from '@mantine/core';
import { Link } from '@tanstack/react-router';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

/**
 * The not-found screen inside a project: the same words as `RouteNotFound`, a different way out
 * (STORY-014-05, acceptance 8).
 *
 * Somebody who arrives at a project that is not there — gone, never existed, or not theirs to see —
 * came looking for a project, and the list of projects is where the next one is; the dashboard is a
 * detour. Only the action differs: the heading and the description are `NotFoundState`'s, so a
 * refused project stays word for word the screen of an address that never existed, and 404 and 403
 * still cannot be told apart (`ux-architecture.md` → «403 vs 404»).
 *
 * Set as `notFoundComponent` of `/projects/$projectId`, which covers the resource guard's refusal;
 * an unknown section under a readable project falls to `_authenticated/$` and keeps the dashboard
 * exit. Every other route keeps the router's default.
 */
export function ProjectNotFound() {
  const { t } = useTranslation();

  return (
    <SharedUi.NotFoundState
      action={
        <Button component={Link} to="/projects" variant="light">
          {t('projects.notFound.action')}
        </Button>
      }
    />
  );
}

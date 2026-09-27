import { Anchor, Breadcrumbs as MantineBreadcrumbs, Text } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { Link } from '@tanstack/react-router';

import { type RouteCrumb } from './lib/route-crumbs.util.js';

export interface BreadcrumbTrailProps {
  readonly crumbs: readonly RouteCrumb[];
}

/**
 * The trail itself — markup over data, with no idea where the data came from.
 *
 * Split from the widget so that the interesting case could be tested at all: a trail of two or more
 * entries needs a nested route, and when this was written exactly one route declared a crumb, so
 * the rules — last crumb is not a link, `aria-current` marks it — could not be exercised through
 * the router.
 *
 * Still true as of 2026-09-27, and worth saying because a note of 2026-08-30 claimed otherwise: many
 * routes declare a crumb (`grep -rn 'crumbKey' packages/client/src/app/routes/`), but no route with
 * a crumb has a parent that declares one. `/admin/teams/$teamId` and `/projects/$projectId` are
 * siblings of their lists (`teams/index.tsx`, `projects/index.tsx`), not children of a layout, so
 * every page of the product today has a trail of one — and renders none. The rules are verified
 * here, on the component, by `test/widgets/breadcrumbs.test.tsx`; a trail on screen needs a layout
 * route above the list that carries its crumb.
 *
 * Nothing renders below two entries: a single crumb is the page title said twice.
 *
 * It sits beside the widget rather than under a `ui/` folder for a plain reason: from `ui/` it
 * would need `../lib/…` to reach the crumb type, and a parent-relative import is forbidden while
 * the alias that would replace it is a deep import into this same widget.
 */
export function BreadcrumbTrail({ crumbs }: BreadcrumbTrailProps) {
  const { t } = useTranslation();

  if (crumbs.length < 2) return null;

  return (
    <MantineBreadcrumbs aria-label={t('nav.breadcrumbs.aria')} separator="/">
      {crumbs.map((crumb) =>
        crumb.isCurrent ? (
          <Text aria-current="page" c="var(--bc-text-muted)" key={crumb.pathname} size="sm">
            {crumb.title ?? t(crumb.labelKey)}
          </Text>
        ) : (
          <Anchor component={Link} key={crumb.pathname} size="sm" to={crumb.pathname}>
            {crumb.title ?? t(crumb.labelKey)}
          </Anchor>
        ),
      )}
    </MantineBreadcrumbs>
  );
}

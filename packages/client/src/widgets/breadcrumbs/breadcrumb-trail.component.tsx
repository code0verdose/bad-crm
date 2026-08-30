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
 * The application has since grown past that (2026-08-30), and this docstring still said «in M1
 * exactly one route declares a crumb … unverified until then». Thirteen routes declare one
 * (`grep -rn 'staticData: { crumbKey' packages/client/src/app/routes/`), nested ones among them —
 * `/admin/teams/$teamId`, `/admin/members/$userId` — so real trails of two exist; and the rules are
 * verified, by `test/widgets/breadcrumbs.test.tsx`. The split is still the right shape; it is no
 * longer the only way to see the component work.
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
            {t(crumb.labelKey)}
          </Text>
        ) : (
          <Anchor component={Link} key={crumb.pathname} size="sm" to={crumb.pathname}>
            {t(crumb.labelKey)}
          </Anchor>
        ),
      )}
    </MantineBreadcrumbs>
  );
}

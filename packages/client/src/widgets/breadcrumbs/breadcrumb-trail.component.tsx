import { Anchor, Breadcrumbs as MantineBreadcrumbs, Text } from '@mantine/core';
import { Link } from '@tanstack/react-router';

import { type RouteCrumb } from './lib/route-crumbs.util.js';

export interface BreadcrumbTrailProps {
  readonly crumbs: readonly RouteCrumb[];
}

/**
 * The trail itself — markup over data, with no idea where the data came from.
 *
 * Split from the widget so that the interesting case can be tested at all: a trail of two or more
 * entries needs a nested route to exist, and in M1 exactly one route declares a crumb. A component
 * that can only be exercised once the application has grown is a component whose rules — last crumb
 * is not a link, `aria-current` marks it — are unverified until then.
 *
 * Nothing renders below two entries: a single crumb is the page title said twice.
 *
 * It sits beside the widget rather than under a `ui/` folder for a plain reason: from `ui/` it
 * would need `../lib/…` to reach the crumb type, and a parent-relative import is forbidden while
 * the alias that would replace it is a deep import into this same widget.
 */
export function BreadcrumbTrail({ crumbs }: BreadcrumbTrailProps) {
  if (crumbs.length < 2) return null;

  return (
    <MantineBreadcrumbs aria-label="nav.breadcrumbs.aria" separator="/">
      {crumbs.map((crumb) =>
        crumb.isCurrent ? (
          <Text aria-current="page" c="var(--bc-text-muted)" key={crumb.pathname} size="sm">
            {crumb.labelKey}
          </Text>
        ) : (
          <Anchor component={Link} key={crumb.pathname} size="sm" to={crumb.pathname}>
            {crumb.labelKey}
          </Anchor>
        ),
      )}
    </MantineBreadcrumbs>
  );
}

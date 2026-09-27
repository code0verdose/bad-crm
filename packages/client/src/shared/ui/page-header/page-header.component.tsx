import { Group, Stack, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { type ReactNode } from 'react';

import classes from './page-header.module.css';

/** The id the route announcer moves focus to after a navigation (`rules/a11y.mdc` §21). */
export const PAGE_TITLE_ID = 'page-title';

export interface PageHeaderProps {
  /** i18n key of the page title. Exactly one `h1` exists per page, and this is it. */
  readonly titleKey: string;
  /**
   * The page's own name, shown instead of the key — for a page named by its data (a project's
   * «KEY · Name»), which is data, not a translation. It must be the last breadcrumb's title too:
   * `null` or absent, the key speaks.
   */
  readonly title?: string | null;
  /** Breadcrumbs, rendered above the title so the reading order matches the visual one. */
  readonly breadcrumbs?: ReactNode;
  /** Page-level actions, right-aligned. */
  readonly actions?: ReactNode;
}

/**
 * The single `h1` of a page, plus the two things that always surround it.
 *
 * Centralised because the heading is load-bearing for accessibility, not for looks: exactly one
 * `h1` per page, matching the last breadcrumb, and the element focus lands on after a route change
 * — which is why it carries a stable id and `tabIndex={-1}` (an element that is not natively
 * focusable cannot receive programmatic focus without it).
 */
export function PageHeader({ titleKey, title, breadcrumbs, actions }: PageHeaderProps) {
  const { t } = useTranslation();

  // A plain block, not a `<header>`. The shell already owns the one `banner` landmark, and a second
  // `<header>` at the top of the content is read as another one by tooling that does not implement
  // the «not inside sectioning content» exception — two banners, neither meaning what it says.
  return (
    <Stack className={classes['root']} gap="xs">
      {breadcrumbs}
      <Group align="center" justify="space-between" wrap="nowrap">
        <Title id={PAGE_TITLE_ID} order={1} tabIndex={-1}>
          {title ?? t(titleKey)}
        </Title>
        {actions !== undefined && <Group gap="sm">{actions}</Group>}
      </Group>
    </Stack>
  );
}

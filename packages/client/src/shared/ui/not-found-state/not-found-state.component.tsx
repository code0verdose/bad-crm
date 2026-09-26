import { Stack, Text, Title } from '@mantine/core';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PAGE_TITLE_ID } from '@shared/ui';

import classes from './not-found-state.module.css';
import { NOT_FOUND_TITLE_KEY } from './not-found-title-key.constant.js';

export interface NotFoundStateProps {
  /** The way out. Supplied by the caller, because `shared/ui` knows no routes. */
  readonly action?: ReactNode;
}

/**
 * The 404 screen: «there is nothing at this address» — and, for the closed contour, «or you may not
 * see it», in words that cannot tell the two apart (`ux-architecture.md` → «403 vs 404»).
 *
 * **Why it is not `EmptyState`.** It used to be, and that is how it lost the page heading. An empty
 * state sits *inside* a page, under that page's `h1`, so its heading is an `h2` with no id. This
 * screen replaces the route's content entirely — it is the page — so its heading is the page's `h1`
 * and carries `PAGE_TITLE_ID`, the id the route announcer moves focus to after a navigation
 * (`rules/a11y.mdc` §21). As an `EmptyState` it had neither: a keyboard user arrived at «not found»
 * with focus on `<body>`, and a screen reader said nothing. Giving `EmptyState` a switch instead
 * would put a second `h1` one prop away on every list that is empty.
 *
 * The same contract as `ForbiddenState`, its counterpart.
 */
export function NotFoundState({ action }: NotFoundStateProps) {
  const { t } = useTranslation();

  return (
    <Stack align="center" className={classes['root']} gap="sm" data-testid="not-found-state">
      <Title id={PAGE_TITLE_ID} order={1} size="h3" tabIndex={-1}>
        {t(NOT_FOUND_TITLE_KEY)}
      </Title>
      <Text c="var(--bc-text-muted)" ta="center">
        {t('errors.not_found.description')}
      </Text>
      {action}
    </Stack>
  );
}

import { Stack, Title } from '@mantine/core';
import { useTranslation } from 'react-i18next';

import { ErrorState, PAGE_TITLE_ID } from '@shared/ui';

import { PAGE_ERROR_TITLE_KEY } from './page-error-title-key.constant.js';

export interface PageErrorStateProps {
  /** i18n key of the sentence in the alert. Never a message from the server. */
  readonly messageKey: string;
  /** The reload. Return its promise and «Retry» stays busy until it settles. */
  readonly onRetry?: () => Promise<unknown>;
}

/**
 * The screen of a page that did not load: the page's `h1`, then the error state with «Retry».
 *
 * **Why it is not a bare `ErrorState`.** It used to be, and that is how a failed route lost its
 * heading. An error state sits *inside* a page, under that page's `h1` — the roster of a project,
 * a list in a section — so it has none of its own. A route's error boundary replaces the route's
 * content entirely, heading included, so this screen *is* the page: its heading is the page's `h1`
 * and carries `PAGE_TITLE_ID`, the id the route announcer moves focus to (`rules/a11y.mdc` §20–21).
 * As a bare `ErrorState` it had none: a keyboard user arrived at «this page could not be opened»
 * with focus on `<body>`. Giving `ErrorState` a switch instead would put a second `h1` one prop
 * away on every section that fails.
 *
 * The same contract as `NotFoundState` and `ForbiddenState`, its neighbours.
 */
export function PageErrorState({ messageKey, onRetry }: PageErrorStateProps) {
  const { t } = useTranslation();

  return (
    <Stack gap="sm" data-testid="page-error-state">
      <Title id={PAGE_TITLE_ID} order={1} size="h3" tabIndex={-1}>
        {t(PAGE_ERROR_TITLE_KEY)}
      </Title>
      <ErrorState messageKey={messageKey} {...(onRetry === undefined ? {} : { onRetry })} />
    </Stack>
  );
}

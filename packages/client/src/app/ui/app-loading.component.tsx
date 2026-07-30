import { Center, Stack, VisuallyHidden } from '@mantine/core';

import { SharedUi } from '@shared';

import classes from './app-loading.module.css';

/** What the region says while it waits. A key, never a sentence (`rules/i18n.mdc` §1). */
const LOADING_MESSAGE_KEY = 'common.loading';

/**
 * The one screen shown before the client knows who it is.
 *
 * It exists because of the frame that would otherwise be there. Between the first paint and the
 * answer of `POST /auth/refresh` the session is `unknown`; render the router in that gap and a
 * signed-in user reloading the page sees the login form flash before being sent back — the failure
 * STORY-006-05 names outright («`/login` не рендерится ни на один кадр»). Rendering nothing at all
 * would be the other half of the same mistake: a blank page reads as broken, and says nothing to
 * anybody who is not looking at it.
 *
 * So: a skeleton for the eye, and a polite live region for everybody else. `aria-busy` on the
 * container and `aria-hidden` on the bars is the pairing `rules/a11y.mdc` §16 asks for — the
 * placeholder rectangles are not content to be read out. The message is visually hidden rather than
 * absent, because «loading» is exactly the thing a screen reader has nothing else to infer.
 */
export function AppLoading() {
  return (
    <Center aria-busy="true" aria-live="polite" className={classes['root']} role="status">
      <Stack className={classes['content']} gap="sm">
        <VisuallyHidden>{LOADING_MESSAGE_KEY}</VisuallyHidden>
        <SharedUi.TextSkeleton lines={3} />
      </Stack>
    </Center>
  );
}

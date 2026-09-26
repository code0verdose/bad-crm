import { useDocumentTitle } from '@mantine/hooks';
import { useMatches } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { BreadcrumbsLib } from '@widgets/breadcrumbs';
import { announcementStep, routePhase } from '@widgets/route-announcer/lib';

import classes from './route-announcer.module.css';

/** Not translated: the product name is a proper noun (`rules/i18n.mdc` → «Исключения»). */
const PRODUCT_NAME = 'Bad CRM';

/**
 * What a screen reader is told when the URL changes (`rules/a11y.mdc` §21).
 *
 * Mounted by the root route rather than by the shell: `/login`, the not-found screen and every
 * other page outside the authenticated branch change the URL too, and an announcer that only covers
 * half the application announces half the navigations.
 *
 * In a single-page application a navigation is invisible to assistive technology: no document
 * loads, focus stays wherever it was — usually on a link in a menu that no longer describes what is
 * on screen. Two things fix it, and both are needed: the document title changes, and focus moves to
 * the new `h1`, which makes the screen reader read the page it just arrived at.
 *
 * **The same move after a successful retry of a failed route.** The route's error state and its
 * content share one crumb, so «the page changed» never fires when «Retry» works — and the button
 * that was pressed goes away with the error, leaving focus on `<body>`. When exactly focus moves is
 * `announcementStep`'s decision (`lib/announcement.util.ts`), pure and tested on its own; this
 * component only performs it.
 *
 * The effect is the legitimate kind (`rules/frontend-fsd.mdc` rule 11): moving focus is an
 * imperative DOM action with no declarative equivalent. It stays one effect for both occasions,
 * because a successful retry is not an event this component handles — the button lives in the
 * route's error boundary, and the moment the heading exists is the router's, not the click's.
 */
export function RouteAnnouncer() {
  const { t } = useTranslation();
  const matches = useMatches();

  const titleKey = BreadcrumbsLib.currentCrumbKey(matches);
  const phase = routePhase(matches);

  useDocumentTitle(titleKey === undefined ? PRODUCT_NAME : `${t(titleKey)} · ${PRODUCT_NAME}`);

  /**
   * The page this component last announced — initialised to the page it is mounting on, which is
   * what makes «do not steal focus on the first render» survive a remount.
   *
   * A boolean `hasNavigated` ref was the obvious version and it was wrong: `StrictMode` mounts,
   * unmounts and mounts again, so on the second mount the flag was already set and focus jumped to
   * the `h1` on a plain page load — putting the skip link *behind* the first Tab and making the one
   * control that exists for keyboard users unreachable. Caught by running the suite under
   * `StrictMode`, which is how the application actually mounts; the browser had been doing this all
   * along.
   */
  const announced = useRef({ titleKey, failed: phase === 'failed' });

  // A real side effect with the outside world: moving focus is an imperative DOM call with no
  // declarative equivalent, and it is the only thing that tells a screen reader the page changed.
  // No cleanup: it neither subscribes nor allocates.
  useEffect(() => {
    const step = announcementStep(announced.current, titleKey, phase);

    announced.current = step.announced;
    if (step.focus) document.getElementById(SharedUi.PAGE_TITLE_ID)?.focus();
  }, [titleKey, phase]);

  return (
    <div
      aria-live="polite"
      className={classes['announcer']}
      data-testid="route-announcer"
      role="status"
    >
      {titleKey === undefined ? null : t(titleKey)}
    </div>
  );
}

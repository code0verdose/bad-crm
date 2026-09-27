import { useDocumentTitle } from '@mantine/hooks';
import { useMatches } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SharedUi } from '@shared';

import { BreadcrumbsLib, useRouteCrumbs } from '@widgets/breadcrumbs';
import {
  announcementStep,
  crumbName,
  openingPage,
  routePhase,
  spokenPage,
  tabPage,
} from '@widgets/route-announcer/lib';

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
 * **The same move after a retry of a failed route**, whichever way it ends. The button that was
 * pressed goes away with the error screen that held it — on a success, and on a second failure
 * too, because the router mounts a fresh error screen — leaving focus on `<body>`. When exactly
 * focus moves (not while the page reloads, never on the page the tab opened on) is
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

  /**
   * The page is the last crumb of the trail — with its title when it is named by its data, a
   * project «KEY · Name» (STORY-014-06, acceptance 8) — so the tab and the announcement say what
   * the trail and the heading say.
   */
  const page = useRouteCrumbs().at(-1);
  /** What «the page changed» is keyed on: another project is another page, a renamed one is not. */
  const pageKey = page === undefined ? undefined : BreadcrumbsLib.crumbIdentity(page);
  const phase = routePhase(matches);

  /**
   * The page the live region names. It changes only when another page has arrived
   * (`spokenPage`): a live region speaks every change of its text, so a rename, or the unnamed
   * crumb of a project still loading, would each be announced as a page of their own. Adjusted
   * while rendering, the way React documents state that follows a prop — not in an effect, which
   * would paint the wrong text first and speak it.
   */
  const [spoken, setSpoken] = useState(() => spokenPage(undefined, page, phase));
  const nextSpoken = spokenPage(spoken, page, phase);

  if (nextSpoken !== spoken) setSpoken(nextSpoken);

  const spokenName = crumbName(nextSpoken, t);
  /** The tab is not a live region: it follows a rename at once (`tabPage`). */
  const tabName = crumbName(tabPage(nextSpoken, page), t);

  useDocumentTitle(tabName === undefined ? PRODUCT_NAME : `${tabName} · ${PRODUCT_NAME}`);

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
  const announced = useRef(openingPage(pageKey, phase));

  /** The heading this component last put focus on. */
  const focused = useRef<HTMLElement | null>(null);

  // A real side effect with the outside world: moving focus is an imperative DOM call with no
  // declarative equivalent, and it is the only thing that tells a screen reader the page changed.
  // No cleanup: it neither subscribes nor allocates.
  useEffect(() => {
    const step = announcementStep(announced.current, pageKey, phase);
    const heading = step.focus ? document.getElementById(SharedUi.PAGE_TITLE_ID) : null;

    announced.current = step.announced;
    if (heading === null) return;

    focused.current = heading;
    heading.focus();
  }, [pageKey, phase]);

  /**
   * While the page is failed, the heading that took focus may be replaced under the reader.
   *
   * A reload of a failed route that fails again reaches the screen in two commits: the match goes
   * back to `error` over the old error screen — the moment this component hears of, and pays the
   * focus move it owed on *that* screen's heading — and a commit later the router's error boundary
   * catches the new failure and mounts a fresh screen, heading included. The heading that held
   * focus leaves the document and focus falls to `<body>`, and nothing this component renders from
   * has changed, so the effect above never hears of it. The DOM is the only witness, hence an
   * observer: when a heading of ours is gone and focus is on `<body>`, the heading that replaced it
   * takes focus. Only while failed, and a reader who moved elsewhere is not followed.
   *
   * A subscription to an external source with its cleanup (`rules/frontend-fsd.mdc` rule 11).
   */
  useEffect(() => {
    if (phase !== 'failed') return undefined;

    const observer = new MutationObserver(() => {
      const replaced =
        focused.current !== null &&
        !focused.current.isConnected &&
        document.activeElement === document.body;

      if (!replaced) return;

      // The observer runs once the commit's mutations are all in, so the successor is there. Were it
      // not, `null` simply ends the watch until the next move of ours.
      focused.current = document.getElementById(SharedUi.PAGE_TITLE_ID);
      focused.current?.focus();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
    };
  }, [phase]);

  return (
    <div
      aria-live="polite"
      className={classes['announcer']}
      data-testid="route-announcer"
      role="status"
    >
      {spokenName ?? null}
    </div>
  );
}

import { SharedUi } from '@shared';

import { IamLib } from '@units/iam';

/**
 * Turns the matched routes into the trail shown above the page title.
 *
 * A pure function over the shape the router gives, so the rule «the last crumb is not a link and it
 * equals the `h1`» is testable without mounting a router — and so the breadcrumbs and the document
 * title cannot disagree, because both are built from this.
 *
 * A route joins the trail by declaring `staticData.crumbKey`; a layout route that is only there to
 * hold a guard declares nothing and is skipped, which is why `_authenticated` never appears.
 *
 * **A page named by its data** — a project — keeps its key and is given a title beside it, by
 * route id (`CrumbTitles`). The key stays the route's, declared like every other; the title is what
 * the reader sees (STORY-014-06, acceptance 8: the tab and the trail say *which* project).
 */
export interface RouteCrumbSource {
  /** The router's id of the route — what a title is given by. Absent in pure cases. */
  readonly routeId?: string;
  readonly pathname: string;
  readonly staticData?: { readonly crumbKey?: string };
  /** The router's status of the match. Absent in pure cases, which then read as loaded. */
  readonly status?: string;
  /** What the match failed with, when `status` is `error`. */
  readonly error?: unknown;
}

export interface RouteCrumb {
  /** i18n key of the label. */
  readonly labelKey: string;
  /**
   * The page's own name, shown instead of the key — data, not a translation (a project's key and
   * name). Absent on a page named by its key, and on a page a stand-in screen replaced.
   */
  readonly title?: string;
  readonly pathname: string;
  /** The page you are on: rendered as text, never as a link to itself. */
  readonly isCurrent: boolean;
}

/**
 * The screen that replaced this match, if one did — named by that screen's own heading key.
 *
 * Three do, and all three render the page's `h1`: the not-found screen (`notFound()` from a guard,
 * the closed contour's refusal included), the 403 screen (`PermissionDeniedError`, routed there by
 * `app/ui/route-error.component.tsx` through the same predicate) and the error screen of any other
 * failure. The last one used to keep the route's name, on the reasoning that «Retry» brings the
 * same page back — but the error screen replaces the page's heading as surely as the other two, and
 * a page is named by the `h1` the reader lands on, not by the one a retry might bring. The trail
 * *above* the replaced match is kept in all three cases, so the way back is still on screen; the
 * retry is a button and needs no crumb.
 *
 * Without this the document title and the route announcement kept the route's static crumb —
 * «Project» — while focus sat on a heading saying «Nothing here»: three voices of one page, and the
 * screen reader announced a project that was not on screen.
 */
const standInKey = (match: RouteCrumbSource): string | undefined => {
  if (match.status === 'notFound') return SharedUi.NOT_FOUND_TITLE_KEY;
  if (match.status === 'error') {
    return IamLib.isPermissionDenied(match.error)
      ? SharedUi.FORBIDDEN_TITLE_KEY
      : SharedUi.PAGE_ERROR_TITLE_KEY;
  }

  return undefined;
};

/** Titles of the pages named by their data, by route id — built by `useRouteCrumbs`. */
export type CrumbTitles = Readonly<Record<string, string>>;

type CrumbLabel = Omit<RouteCrumb, 'isCurrent'>;

/** Labels in route order, stopping at the first match a stand-in screen replaced. */
const crumbLabels = (matches: readonly RouteCrumbSource[], titles: CrumbTitles) => {
  const labels: CrumbLabel[] = [];

  for (const match of matches) {
    const standIn = standInKey(match);

    // Nothing under a replaced match renders, so nothing under it names the page.
    if (standIn !== undefined) return [...labels, { labelKey: standIn, pathname: match.pathname }];

    const crumbKey = match.staticData?.crumbKey;

    if (crumbKey === undefined) continue;

    const title = match.routeId === undefined ? undefined : titles[match.routeId];

    labels.push({
      labelKey: crumbKey,
      ...(title === undefined ? {} : { title }),
      pathname: match.pathname,
    });
  }

  return labels;
};

export const routeCrumbs = (
  matches: readonly RouteCrumbSource[],
  titles: CrumbTitles = {},
): RouteCrumb[] => {
  const labels = crumbLabels(matches, titles);

  return labels.map((label, index) => ({ ...label, isCurrent: index === labels.length - 1 }));
};

/** The page itself — the last crumb, which is its `h1` — or nothing, on a route that declares none. */
export const currentCrumb = (
  matches: readonly RouteCrumbSource[],
  titles: CrumbTitles = {},
): RouteCrumb | undefined => routeCrumbs(matches, titles).at(-1);

/** The `h1` key of the page, which is the last crumb — or nothing, on a route that declares none. */
export const currentCrumbKey = (matches: readonly RouteCrumbSource[]): string | undefined =>
  currentCrumb(matches)?.labelKey;

/**
 * Which page this is, for the route announcer's «did the page change» (`rules/a11y.mdc` §21).
 *
 * A page named by its key is that key wherever it is — the same as before titles existed, so a
 * search parameter or a section tab never moves focus. A page named by its data is the key **and
 * the address**: another project is another page, and focus goes to its heading; the same project
 * renamed keeps its address and stays the same page, so saving a new name on the settings tab does
 * not throw focus out of the form. Keyed on the address rather than the title for that reason.
 */
export const crumbIdentity = (crumb: RouteCrumb): string =>
  crumb.title === undefined ? crumb.labelKey : `${crumb.labelKey}@${crumb.pathname}`;

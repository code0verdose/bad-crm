import { BreadcrumbsLib } from '@widgets/breadcrumbs';

import { type RoutePhase } from './announcement.util.js';

type RouteCrumb = BreadcrumbsLib.RouteCrumb;

/**
 * Which page the live region names — the page it last spoke about, until another page has arrived.
 *
 * The live region speaks every change of its text, so its text changes at the moments the page
 * changes and at no other (`rules/a11y.mdc` §21) — the same moments `announcementStep` moves focus:
 *
 * - **not while loading.** The crumb of a page on its way has no name yet — a project's is the
 *   route's key, «Project», until its card arrives — and saying it would announce a third page
 *   between the one left and the one arriving;
 * - **not on a rename.** A project renamed keeps its identity (`crumbIdentity`: key and address),
 *   and «BAD · New name» read out after «saved» would announce a navigation that did not happen.
 *
 * The crumb is kept, not its text: a key still follows a change of language, which is a change of
 * wording the reader asked for.
 */
const samePage = (a: RouteCrumb | undefined, b: RouteCrumb | undefined): boolean =>
  a === undefined || b === undefined
    ? a === b
    : BreadcrumbsLib.crumbIdentity(a) === BreadcrumbsLib.crumbIdentity(b);

export const spokenPage = (
  previous: RouteCrumb | undefined,
  current: RouteCrumb | undefined,
  phase: RoutePhase,
): RouteCrumb | undefined => {
  if (phase === 'loading') return previous;

  return samePage(previous, current) ? previous : current;
};

/**
 * Which page the tab names. The tab says what is open and is not a live region, so it follows a
 * rename of the page it names at once; while another page loads it keeps the page last spoken of
 * rather than the unnamed «Project» in between — the tab strip is where two projects are told apart.
 */
export const tabPage = (
  spoken: RouteCrumb | undefined,
  current: RouteCrumb | undefined,
): RouteCrumb | undefined => (samePage(spoken, current) ? current : spoken);

/** What a crumb reads as: its own title when it is named by its data, its translated key otherwise. */
export const crumbName = (
  crumb: RouteCrumb | undefined,
  translate: (key: string) => string,
): string | undefined =>
  crumb === undefined ? undefined : (crumb.title ?? translate(crumb.labelKey));

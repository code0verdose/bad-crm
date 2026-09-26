/** Where the matched routes stand, as far as a reader can tell. */
export type RoutePhase = 'loading' | 'failed' | 'settled';

/** The field of a router match this reads — structural, so the rule is testable without a router. */
export interface RouteStatusSource {
  readonly status: string;
}

/**
 * The phase of the page on screen. `failed` wins over `loading`: what the reader sees is the error
 * state of the failed match, whatever its neighbours are doing.
 *
 * Matches under a not-found one do not count: nothing renders them, so they never load and stay
 * `pending` for as long as the not-found screen is up. Counted, they kept the page «loading» for
 * good — and a focus move owed to the not-found screen was never paid.
 */
export const routePhase = (matches: readonly RouteStatusSource[]): RoutePhase => {
  const notFoundAt = matches.findIndex((match) => match.status === 'notFound');
  const rendered = notFoundAt === -1 ? matches : matches.slice(0, notFoundAt);

  if (matches.some((match) => match.status === 'error')) return 'failed';
  if (rendered.some((match) => match.status === 'pending')) return 'loading';

  return 'settled';
};

/** The page the announcer last spoke about, and what it still owes that page. */
export interface AnnouncedPage {
  readonly titleKey: string | undefined;
  /** The page was on its error screen. */
  readonly failed: boolean;
  /** A focus move this page is owed, held while it loads: its heading does not exist yet. */
  readonly owed: boolean;
  /** Nothing has had an answer since mount — this is the page the tab opened on. */
  readonly opening: boolean;
}

export interface AnnouncementStep {
  /** Move focus to the page heading now. */
  readonly focus: boolean;
  readonly announced: AnnouncedPage;
}

/** Where the announcer starts: the page on screen at mount, which is never a navigation. */
export const openingPage = (titleKey: string | undefined, phase: RoutePhase): AnnouncedPage => ({
  titleKey,
  failed: phase === 'failed',
  owed: false,
  opening: true,
});

/**
 * Whether this render is a moment to move focus to the page heading (`rules/a11y.mdc` §21).
 *
 * Two occasions, and only two:
 *
 * - **the page changed** — a new name. Keyed on the name rather than the pathname so that a
 *   search-parameter change (a filter, a page number) does not yank focus out of the control the
 *   user is operating. A route replaced by its error screen is a new name too
 *   (`widgets/breadcrumbs/lib/route-crumbs.util.ts`): the reader lands on «the page did not load»;
 * - **the failed page was reloaded** — «Retry». Whatever the answer, the button the reader pressed
 *   leaves with the error screen that held it (the router mounts its error boundary afresh on every
 *   load), and focus would drop to `<body>`.
 *
 * **Both are delivered only once the page has an answer.** While it loads, the heading that will
 * describe it does not exist: a move made then lands on the old page's heading — or, during a
 * retry, pulls focus off the busy «Retry», the one control that can tell the reader how the reload
 * ends. So a move that falls due while loading is *owed*, and paid when the page settles or fails.
 *
 * **The page the tab opened on is not a navigation**, however it resolves — a redirect to the login
 * screen, a not-found, a failure. Focus stays where the browser put it, so the skip link is the
 * first Tab (`rules/a11y.mdc` §19). A reload of that page after a failure is a navigation again.
 */
export const announcementStep = (
  previous: AnnouncedPage,
  titleKey: string | undefined,
  phase: RoutePhase,
): AnnouncementStep => {
  const changed = previous.titleKey !== titleKey;

  if (phase === 'loading') {
    const owed = previous.owed || changed || previous.failed;

    if (!changed && owed === previous.owed) return { focus: false, announced: previous };

    return { focus: false, announced: { ...previous, titleKey, owed } };
  }

  const failed = phase === 'failed';
  const due = changed || previous.owed || (previous.failed && !failed);

  return {
    focus: due && !previous.opening,
    announced: { titleKey, failed, owed: false, opening: false },
  };
};

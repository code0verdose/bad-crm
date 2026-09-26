/** Where the matched routes stand, as far as a reader can tell. */
export type RoutePhase = 'loading' | 'failed' | 'settled';

/** The field of a router match this reads — structural, so the rule is testable without a router. */
export interface RouteStatusSource {
  readonly status: string;
}

/**
 * The phase of the page on screen. `failed` wins over `loading`: what the reader sees is the error
 * state of the failed match, whatever its neighbours are doing.
 */
export const routePhase = (matches: readonly RouteStatusSource[]): RoutePhase => {
  if (matches.some((match) => match.status === 'error')) return 'failed';
  if (matches.some((match) => match.status === 'pending')) return 'loading';

  return 'settled';
};

/** The page the announcer last spoke about, and whether it was on its error state. */
export interface AnnouncedPage {
  readonly titleKey: string | undefined;
  readonly failed: boolean;
}

export interface AnnouncementStep {
  /** Move focus to the page heading now. */
  readonly focus: boolean;
  readonly announced: AnnouncedPage;
}

/**
 * Whether this render is a moment to move focus to the page heading (`rules/a11y.mdc` §21).
 *
 * Two occasions, and only two:
 *
 * - **the page changed** — a new crumb. Keyed on the crumb rather than the pathname so that a
 *   search-parameter change (a filter, a page number) does not yank focus out of the control the
 *   user is operating;
 * - **the failed page came back.** A route's error state and its content share the crumb, so the
 *   first occasion never fires on a successful retry — and the «Retry» button the reader pressed is
 *   unmounted with the error, which drops focus to `<body>`. Focus moves once the page *settles*,
 *   not while it reloads: the heading does not exist until the content does.
 *
 * A reload of a page that never failed is neither, and moves nothing.
 */
export const announcementStep = (
  previous: AnnouncedPage,
  titleKey: string | undefined,
  phase: RoutePhase,
): AnnouncementStep => {
  const failed = phase === 'failed';

  if (previous.titleKey !== titleKey) return { focus: true, announced: { titleKey, failed } };
  if (failed) return { focus: false, announced: { titleKey, failed: true } };
  if (previous.failed && phase === 'settled') {
    return { focus: true, announced: { titleKey, failed: false } };
  }

  return { focus: false, announced: previous };
};

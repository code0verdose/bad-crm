/**
 * Turns the matched routes into the trail shown above the page title.
 *
 * A pure function over the shape the router gives, so the rule «the last crumb is not a link and it
 * equals the `h1`» is testable without mounting a router — and so the breadcrumbs and the document
 * title cannot disagree, because both are built from this.
 *
 * A route joins the trail by declaring `staticData.crumbKey`; a layout route that is only there to
 * hold a guard declares nothing and is skipped, which is why `_authenticated` never appears.
 */
export interface RouteCrumbSource {
  readonly pathname: string;
  readonly staticData?: { readonly crumbKey?: string };
}

export interface RouteCrumb {
  /** i18n key of the label. */
  readonly labelKey: string;
  readonly pathname: string;
  /** The page you are on: rendered as text, never as a link to itself. */
  readonly isCurrent: boolean;
}

export const routeCrumbs = (matches: readonly RouteCrumbSource[]): RouteCrumb[] => {
  const labelled = matches.filter((match) => match.staticData?.crumbKey !== undefined);

  return labelled.map((match, index) => ({
    labelKey: match.staticData?.crumbKey as string,
    pathname: match.pathname,
    isCurrent: index === labelled.length - 1,
  }));
};

/** The `h1` of the page, which is the last crumb — or nothing, on a route that declares none. */
export const currentCrumbKey = (matches: readonly RouteCrumbSource[]): string | undefined =>
  routeCrumbs(matches).at(-1)?.labelKey;

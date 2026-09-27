import { type ProjectSection } from '@units/project/model/constants/project-sections.constant.js';

/** The slice of a router match this reads — narrow, so a unit never names the route tree's types. */
export interface ProjectLocationMatch {
  readonly routeId: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ProjectLocation {
  /** The project in the path, or `null` outside `/projects/$projectId/**`. */
  readonly projectId: string | null;
  /** Which section of the card is open, or `null` outside a project. */
  readonly section: ProjectSection | null;
}

/**
 * The router's id of the project layout — the route that holds the project in its path, and so the
 * one whose crumb a project's name is given to (`widgets/breadcrumbs`, `useRouteCrumbs`).
 */
export const PROJECT_LAYOUT_ROUTE_ID = '/_authenticated/projects/$projectId';

const LAYOUT = PROJECT_LAYOUT_ROUTE_ID;

const SECTION_OF_ROUTE: Readonly<Record<string, ProjectSection>> = {
  [`${LAYOUT}/`]: 'overview',
  [`${LAYOUT}/members`]: 'members',
  [`${LAYOUT}/settings`]: 'settings',
};

/**
 * Where the reader stands, read from the matched routes — the path is the only place the current
 * project lives (STORY-014-06, acceptance 1: no «selected project» in a store). A project layout
 * matched without a known section (a section that is still loading, a not-found child) is the
 * overview: it is where a switch from there should land.
 */
export const projectLocation = (matches: readonly ProjectLocationMatch[]): ProjectLocation => {
  const layout = matches.find((match) => match.routeId === LAYOUT);
  const projectId = layout?.params['projectId'];

  if (typeof projectId !== 'string') return { projectId: null, section: null };

  const section =
    matches.map((match) => SECTION_OF_ROUTE[match.routeId]).find((value) => value !== undefined) ??
    'overview';

  return { projectId, section };
};

/**
 * @vitest-environment node
 *
 * The convention STORY-004-05 asks for: **a route that loads data declares `pendingComponent` and
 * `errorComponent`.**
 *
 * It exists because the failure is invisible. A route with a loader and no boundaries does not
 * break the build, does not warn, and looks perfect on a fast connection with a healthy API — it
 * only shows itself as a blank rectangle to the one user whose request was slow, and as a blank
 * page to the one whose request failed. Nothing in the type system can see it: `pendingComponent`
 * is optional, and its absence is the default.
 *
 * `router.tsx` sets `defaultPendingComponent` and `defaultErrorComponent`, which every route
 * inherits, so today the tree cannot show a bare screen either way. This is the rule for the day a
 * route needs its own — a skeleton shaped like the table it replaces, an error that offers to retry
 * *this* loader — because that is when someone declares one of the two and forgets the other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROUTES = fileURLToPath(new URL('../../src/app/routes', import.meta.url));
const ROUTER_MODULE = fileURLToPath(new URL('../../src/app/router.tsx', import.meta.url));

const routeFiles = (directory: string = ROUTES): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return routeFiles(path);

    return entry.name.endsWith('.tsx') ? [path] : [];
  });

const relative = (path: string): string => path.slice(ROUTES.length + 1);

/**
 * Comments are stripped before anything is matched, and the reason is this very file: the prose
 * above names `errorComponent` several times, and a scanner that read comments would find the word
 * in the explanation of why it must be present.
 */
const codeOf = (source: string): string =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*$/gm, '');

/**
 * What makes a route «a route with data»: it declares a loader, or it primes the query cache.
 *
 * `loaderDeps` counts too — it exists only to feed a loader, so a file that has one and no visible
 * `loader:` is a file where the loader arrived through a helper.
 */
const DATA_ROUTE = /\b(?:loader|loaderDeps)\s*:|\bensureQueryData\s*\(/;

const REQUIRED_BOUNDARIES = ['pendingComponent', 'errorComponent'] as const;

/** The boundaries a data-bearing route is missing; `[]` for a route that loads nothing. */
const missingBoundaries = (source: string): string[] => {
  const code = codeOf(source);

  if (!DATA_ROUTE.test(code)) return [];

  return REQUIRED_BOUNDARIES.filter((boundary) => !new RegExp(`\\b${boundary}\\s*:`).test(code));
};

const ROUTE_WITHOUT_DATA = `
  export const Route = createFileRoute('/login')({
    component: LoginPage,
  });
`;

const ROUTE_WITH_BOTH_BOUNDARIES = `
  export const Route = createFileRoute('/tasks')({
    loader: ({ context }) => context.queryClient.ensureQueryData(taskListQuery()),
    component: TaskListPage,
    pendingComponent: TaskListSkeleton,
    errorComponent: TaskListError,
  });
`;

const ROUTE_WITHOUT_ERROR_BOUNDARY = `
  export const Route = createFileRoute('/tasks')({
    loader: ({ context }) => context.queryClient.ensureQueryData(taskListQuery()),
    component: TaskListPage,
    pendingComponent: TaskListSkeleton,
  });
`;

const ROUTE_WITHOUT_PENDING_BOUNDARY = `
  export const Route = createFileRoute('/tasks')({
    loader: ({ context }) => context.queryClient.ensureQueryData(taskListQuery()),
    component: TaskListPage,
    errorComponent: TaskListError,
  });
`;

const ROUTE_THAT_ONLY_TALKS_ABOUT_IT = `
  // This screen has no loader yet, so it needs no errorComponent of its own.
  export const Route = createFileRoute('/settings')({
    component: SettingsPage,
  });
`;

/**
 * The positive control, and the half of this file that actually proves something today: no route
 * in the tree loads data yet, so the sweep below would pass over an empty set and report nothing.
 * These fixtures are what say the sweep can fail at all.
 */
describe('the detector', () => {
  it('calls out a data route with no errorComponent', () => {
    expect(missingBoundaries(ROUTE_WITHOUT_ERROR_BOUNDARY)).toEqual(['errorComponent']);
  });

  it('calls out a data route with no pendingComponent', () => {
    expect(missingBoundaries(ROUTE_WITHOUT_PENDING_BOUNDARY)).toEqual(['pendingComponent']);
  });

  it('calls out both when a data route declares neither', () => {
    const source = ROUTE_WITH_BOTH_BOUNDARIES.replaceAll(/\s*(?:pending|error)Component:.*\n/g, '');

    expect(missingBoundaries(source)).toEqual(['pendingComponent', 'errorComponent']);
  });

  it('accepts a data route that declares both', () => {
    expect(missingBoundaries(ROUTE_WITH_BOTH_BOUNDARIES)).toEqual([]);
  });

  it('leaves a route without a loader alone — it inherits the router defaults', () => {
    expect(missingBoundaries(ROUTE_WITHOUT_DATA)).toEqual([]);
  });

  it('is not fooled by a comment that merely names the boundary', () => {
    expect(missingBoundaries(ROUTE_THAT_ONLY_TALKS_ABOUT_IT)).toEqual([]);
  });
});

describe('the routes that ship', () => {
  it('finds the route files, so the sweep below reads something', () => {
    expect(routeFiles().map(relative).sort()).toContain('_authenticated/dashboard.tsx');
  });

  it('declares both boundaries on every route that loads data', () => {
    const offenders = routeFiles().flatMap((path) => {
      const missing = missingBoundaries(readFileSync(path, 'utf8'));

      return missing.length === 0 ? [] : [`${relative(path)} → ${missing.join(', ')}`];
    });

    expect(
      offenders,
      'a route with a loader declares pendingComponent and errorComponent — STORY-004-05',
    ).toEqual([]);
  });

  /**
   * The safety net under the sweep. While no route declares boundaries of its own, «the user never
   * sees a bare screen» rests entirely on the router-wide defaults — so their absence would make
   * the sweep above a green light over an unguarded tree. The runtime identity of the two
   * components is asserted in `test/app/boundaries.test.tsx`; what is checked here is that
   * `createAppRouter` still passes them at all.
   */
  it('keeps the inherited defaults that cover every route declaring none', () => {
    const router = codeOf(readFileSync(ROUTER_MODULE, 'utf8'));

    expect(router).toMatch(/defaultPendingComponent\s*:/);
    expect(router).toMatch(/defaultErrorComponent\s*:/);
  });
});

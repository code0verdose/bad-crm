/**
 * @vitest-environment node
 *
 * The middle link of the call chain, asserted over the tree that actually ships.
 *
 * `rules/frontend-fsd.mdc` rule 4 fixes the chain as `ui → service/hooks → service/{queries,
 * mutations} → api`, and rule 6 makes the hook the unit's public API for `ui`. A widget that calls
 * `XxxMutations.useY()` itself skips the middle link, and a widget that then turns the `Error` into
 * a sentence key with `errorMessageKey` puts a second copy of «read the failure by its `code`»
 * (`rules/errors-and-toasts.mdc` §10) on a layer that has no business knowing the rule.
 *
 * **Nothing else catches either, and the reason is structural rather than an oversight in the
 * config.** The linter's model of this architecture is *direction*: `import/no-restricted-paths`
 * and `boundaries/element-types` know that `widgets` may import `units` and that `units` may not
 * import `widgets`. A widget calling `TeamMutations.useDeleteTeam()` travels in the **permitted
 * direction along a forbidden chain** — it is `widgets → units`, which is exactly what the rules
 * allow, and no rule about direction can express «through which segment of the unit». The chain
 * `ui → service/hooks → service/{queries,mutations}` is a statement about the *inside* of a layer,
 * so it needs a check that reads the tree. `no-restricted-imports` on `@tanstack/react-query` stops
 * a raw `useMutation` in a widget but not a call to a unit hook that wraps one, and
 * `import { TeamService } from '@units/team'` is clean in every directory concerned.
 * `test/architecture/data-layer-conventions.test.ts` walks the same tree but asserts other things:
 * hand-written query keys and Web Storage. Nine surfaces shipped this way — seven widgets and two pages — and a
 * gate found them, not the linter. Two of the nine were found only when the walk was widened from
 * `widgets/` to `pages/`, which is why it covers both.
 *
 * Both rules read the tree rather than a fixture: the file list and the set of unit data-segment
 * hooks are derived from `src/`, and each is asserted non-empty first, so a walk that finds nothing
 * cannot pass as a walk that finds nothing wrong.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../../src', import.meta.url));

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;

    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) return [];

    return [path];
  });

const relative = (path: string): string => path.slice(SRC.length + 1);

/**
 * Comments are stripped before either pattern is applied.
 *
 * Every hook this file is about is *named* in the prose that explains why a widget must not call it
 * — the dialogs carry a paragraph each — and a rule that cannot be explained without tripping over
 * itself is a rule nobody writes the explanation for.
 */
const codeOf = (path: string): string =>
  readFileSync(path, 'utf8')
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .replaceAll(/\/\/.*$/gm, '');

/**
 * Both layers above the units, not only `widgets`.
 *
 * A page is composition too, and that is exactly why the offence is easiest to excuse there — but
 * it is composition of *hooks*. `pages/employee-profile/page.tsx` called
 * `EmployeeMutations.useUpdateEmployeeProfile()` and built the request body in its JSX, and a gate
 * scoped to `widgets/` would have shipped saying the tree was clean.
 */
const composingFiles = (): string[] => [
  ...sourceFiles(`${SRC}/widgets`),
  ...sourceFiles(`${SRC}/pages`),
];

/**
 * The call, not the prop. `SharedUi.DataState` takes an `errorMessageKey="…"` attribute, which is a
 * constant key handed to a component and has nothing to do with reading an `Error` — six widgets
 * pass one. What is forbidden is the *function*, so the parenthesis is part of the pattern.
 */
const ERROR_KEY_CALL = /\berrorMessageKey\s*\(/;

/**
 * The hooks of a unit's **data segments** — `service/queries` and `service/mutations` — read off the
 * tree.
 *
 * By name rather than by import path, because the barrels differ: `units/team` re-exports its
 * segments as namespaces (`TeamService.TeamMutations.useDeleteTeam`) while `units/auth` re-exports
 * its segments flat (`AuthService.useDisableTotp`). A rule written against
 * `@units/*\/service/mutations` or against `Mutations.` would have caught three of the four dialogs
 * and let the flat one through — which is the shape of every gate that checks the spelling of an
 * offence instead of the offence.
 *
 * **Both suffixes, because the chain in `rules/frontend-fsd.mdc` rule 4 names both.** This file
 * first shipped reading `*.mutation.ts` alone, and the half it did not read was violated the whole
 * time: nine calls in seven files went straight from `ui` to `service/queries`. A read skipping the
 * middle link is the same defect as a write skipping it — the widget ends up holding the query
 * object (`status`, `refetch`, `data ?? []`) and deriving from it, which is what rule 6 puts in the
 * hook. It is *quieter* than the write, not milder: nothing about a read makes the screen fail
 * loudly, so it survives review.
 *
 * **The segment is the needle, not the word «query».** `useCan()` and `useTeamRoster()` are hooks
 * that wrap queries and mutations, and calling them from a widget is exactly what the rule asks
 * for. They live in `service/hooks`, which this walk does not read, so the distinction costs no
 * exception list: what is forbidden is reaching **past** `service/hooks`, and only the two data
 * segments are past it.
 */
const unitHooks = (): string[] =>
  sourceFiles(`${SRC}/units`)
    .filter((path) => path.endsWith('.mutation.ts') || path.endsWith('.query.ts'))
    .flatMap((path) => [...codeOf(path).matchAll(/export const (use\w+)/g)].map(([, name]) => name))
    .filter((name): name is string => name !== undefined);

const callsAny = (source: string, names: readonly string[]): boolean =>
  names.some((name) => new RegExp(`\\b${name}\\s*\\(`).test(source));

/**
 * There is no allow-list, and that is deliberate.
 *
 * This file first shipped with two entries in one — `invite-member` and `role-matrix`, left because
 * `units/iam` was owned by another change at the time — and the entries were closed before the gate
 * landed. A gate that carries real violations inside it documents a defect instead of preventing
 * one: it goes green on a tree that is broken, which is the whole failure mode this file was
 * written to catch. The empty expectation below is the assertion; a screen that needs an exception
 * needs a hook instead.
 */

describe('the widget call-chain detectors', () => {
  it.each([
    ['a bare call', 'const key = errorMessageKey(error);'],
    ['a namespaced call', 'const key = SharedApi.errorMessageKey(mutation.error);'],
  ])('rejects %s', (_case, source) => {
    expect(ERROR_KEY_CALL.test(source)).toBe(true);
  });

  it('accepts the `DataState` prop of the same name', () => {
    expect(ERROR_KEY_CALL.test('<DataState errorMessageKey="teams.list.failed" />')).toBe(false);
  });

  it.each([
    ['a namespaced mutation hook', 'const d = TeamService.TeamMutations.useDeleteTeam();'],
    ['a flat mutation hook', 'const d = AuthService.useDisableTotp();'],
    ['a namespaced query hook', 'const q = TeamService.TeamQueries.useTeamListQuery();'],
  ])('rejects %s', (_case, source) => {
    expect(callsAny(source, ['useDeleteTeam', 'useDisableTotp', 'useTeamListQuery'])).toBe(true);
  });

  it.each([
    ['one wrapping a mutation', 'const d = TeamService.TeamHooks.useTeamDeletion(teamId);'],
    ['one wrapping a query', 'const n = TeamService.TeamHooks.useTeamNames(teamIds);'],
    ['`useCan`, which is a hook and not a read', 'const { can } = IamService.IamHooks.useCan();'],
  ])('accepts a `service/hooks` hook: %s', (_case, source) => {
    expect(callsAny(source, ['useDeleteTeam', 'useDisableTotp', 'useTeamListQuery'])).toBe(false);
  });
});

describe('the widget and page tree', () => {
  it('has widgets and pages to check, so this file cannot pass over an empty tree', () => {
    const files = composingFiles().map(relative);

    expect(files.filter((path) => path.startsWith('widgets/')).length).toBeGreaterThan(0);
    expect(files.filter((path) => path.startsWith('pages/')).length).toBeGreaterThan(0);
  });

  it('has hooks of both data segments to look for, so the second rule cannot pass on an empty needle', () => {
    expect(unitHooks()).toContain('useDeleteTeam');
    expect(unitHooks()).toContain('useTeamListQuery');
    expect(unitHooks().length).toBeGreaterThan(1);
  });

  it('does not look for `service/hooks` hooks, which `ui` is meant to call', () => {
    expect(unitHooks()).not.toContain('useCan');
    expect(unitHooks()).not.toContain('useTeamRoster');
  });

  it('reads no failure itself — the sentence key arrives from the unit hook', () => {
    const offenders = composingFiles()
      .filter((path) => ERROR_KEY_CALL.test(codeOf(path)))
      .map(relative);

    expect(
      offenders,
      'let `service/hooks` hand `ui` a ready `failureKey` — rules/frontend-fsd.mdc rule 6',
    ).toEqual([]);
  });

  it('reaches past `service/hooks` for neither a read nor a write', () => {
    const hooks = unitHooks();
    const offenders = composingFiles()
      .filter((path) => callsAny(codeOf(path), hooks))
      .map(relative)
      .sort();

    expect(
      offenders,
      'go through `service/hooks`, not `service/{queries,mutations}` — rules/frontend-fsd.mdc rule 4',
    ).toEqual([]);
  });
});

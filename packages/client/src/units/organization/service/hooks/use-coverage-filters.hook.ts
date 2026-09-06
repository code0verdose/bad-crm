import { useDebouncedCallback } from '@mantine/hooks';
import { useCallback, useState } from 'react';

import { type MfaGate } from '@units/organization/api';
import { MFA_GATES, type OrganizationSettingsSearch } from '@units/organization/model';

/** The whitelist the URL is written through — one place, so a select cannot widen it. */
const isGate = (value: string): value is MfaGate =>
  (MFA_GATES as readonly string[]).includes(value);

/**
 * How long the screen waits before a keystroke becomes a URL.
 *
 * The same 300 ms the directory uses, and for the same reason: the address bar *is* the state, so
 * writing it per character would fill the history with the letters of a word.
 */
const TYPING_PAUSE_MS = 300;

/**
 * Writing to the address bar, in the shape the router gives a screen.
 *
 * Passed in rather than taken from `useNavigate()`, so this hook can be tested without a router and
 * so `units/` never reaches into the generated route tree, which lives two layers above it.
 */
export interface CoverageSearchNavigation {
  (input: {
    search: (previous: OrganizationSettingsSearch) => OrganizationSettingsSearch;
    replace: boolean;
  }): void;
}

export interface CoverageFilters {
  /** What is in the URL right now — including the phrase before the pause elapses. */
  readonly search: OrganizationSettingsSearch;
  /** What the input shows, which runs ahead of the URL while somebody is typing. */
  readonly typed: string;
  readonly setQuery: (value: string) => void;
  readonly setRoles: (values: readonly string[]) => void;
  /**
   * The verdict filter, taking whatever a select hands it.
   *
   * `readonly string[]` rather than `readonly MfaGate[]` on purpose: the caller is a `MultiSelect`,
   * whose `onChange` is typed `string[]`, and the alternative is a cast written in a component —
   * which is the same claim made in the place least able to check it. The whitelist is applied here,
   * so a value that is not a verdict never reaches the URL and never reaches the filter.
   */
  readonly setGates: (values: readonly string[]) => void;
  readonly reset: () => void;
  /** Whether anything is narrowing the report — what the «reset» affordance appears for. */
  readonly isFiltered: boolean;
}

/**
 * The coverage report's filter: the URL is the state, and this is the only place that writes it.
 *
 * Three properties, and they are the reason this is a hook of the unit rather than a handful of
 * handlers on the screen (`rules/lists-and-filters.mdc`):
 *
 *   * **every write is `replace`.** Six keystrokes must not become six entries in the history,
 *     because the back button would then walk the letters of a word instead of leaving the screen;
 *   * **typing is debounced in the handler, not in an effect.** An effect mirroring state into the
 *     URL is the derived-state effect `rules/frontend-fsd.mdc` rule 11 forbids, and it would fire on
 *     arrival too — rewriting the address of somebody who has just followed a link to it;
 *   * **the tab is not a filter.** Switching tabs keeps the narrowing, so coming back to «Security»
 *     shows the report as it was left rather than as it opens.
 *
 * There is no page here, and therefore no page reset: the report is unpaged by contract, because
 * «how many are not enrolled» must not become a second request that can disagree with the first.
 */
export const useCoverageFilters = (
  search: OrganizationSettingsSearch,
  navigate: CoverageSearchNavigation,
): CoverageFilters => {
  const [typed, setTyped] = useState(search.q);

  const apply = useCallback(
    (change: Partial<OrganizationSettingsSearch>): void => {
      navigate({ search: (previous) => ({ ...previous, ...change }), replace: true });
    },
    [navigate],
  );

  const publishQuery = useDebouncedCallback((value: string) => {
    apply({ q: value });
  }, TYPING_PAUSE_MS);

  const setQuery = useCallback(
    (value: string): void => {
      // The input is controlled from here so it answers instantly; the URL follows after the pause.
      setTyped(value);
      publishQuery(value);
    },
    [publishQuery],
  );

  const setRoles = useCallback(
    (values: readonly string[]): void => {
      apply({ role: [...values] });
    },
    [apply],
  );

  const setGates = useCallback(
    (values: readonly string[]): void => {
      apply({ gate: values.filter(isGate) });
    },
    [apply],
  );

  const reset = useCallback((): void => {
    setTyped('');
    apply({ q: '', role: [], gate: [] });
  }, [apply]);

  return {
    search,
    typed,
    setQuery,
    setRoles,
    setGates,
    reset,
    isFiltered: search.q !== '' || search.role.length > 0 || search.gate.length > 0,
  };
};

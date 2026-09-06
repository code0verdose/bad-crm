import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  organizationSettingsSearchSchema,
  type OrganizationSettingsSearch,
} from '@units/organization/model';

import { useCoverageFilters } from './use-coverage-filters.hook.js';

/**
 * The coverage filter, without a router.
 *
 * The hook takes `navigate` as an argument for exactly this: what it does is decide **what the next
 * URL is**, and that is testable as a function of the current one. Three properties carry it:
 *
 *   * every write replaces rather than pushes — five keystrokes must not become five entries in the
 *     history, or the back button walks the letters of a word;
 *   * typing reaches the URL once, after a pause, and the input answers immediately meanwhile;
 *   * a value that is not a verdict never reaches the URL. The selects that call this are typed
 *     `string[]` by the library, so the whitelist has to live somewhere that can be shown to work —
 *     a cast in a component is the same claim made where nothing checks it.
 */

const TYPING_PAUSE_MS = 300;

const searchWith = (
  overrides: Partial<OrganizationSettingsSearch> = {},
): OrganizationSettingsSearch => ({
  ...organizationSettingsSearchSchema.parse({}),
  ...overrides,
});

interface Recorded {
  readonly next: OrganizationSettingsSearch;
  readonly replace: boolean;
}

const recorder = () => {
  const calls: Recorded[] = [];
  let current = searchWith();

  return {
    calls,
    navigate: (input: {
      search: (previous: OrganizationSettingsSearch) => OrganizationSettingsSearch;
      replace: boolean;
    }): void => {
      calls.push({ next: input.search(current), replace: input.replace });
    },
    startFrom: (search: OrganizationSettingsSearch): void => {
      current = search;
    },
  };
};

let nav: ReturnType<typeof recorder>;

beforeEach(() => {
  vi.useFakeTimers();
  nav = recorder();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useCoverageFilters', () => {
  it('answers in the input immediately and in the URL once, after the pause', () => {
    const { result } = renderHook(() => useCoverageFilters(searchWith(), nav.navigate));

    act(() => {
      result.current.setQuery('bo');
    });
    act(() => {
      result.current.setQuery('bor');
    });

    // The field is controlled from here, so it is never a keystroke behind.
    expect(result.current.typed).toBe('bor');
    expect(nav.calls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(nav.calls).toHaveLength(1);
    expect(nav.calls[0]?.next.q).toBe('bor');
    expect(nav.calls[0]?.replace).toBe(true);
  });

  it('writes a chosen role straight away', () => {
    const { result } = renderHook(() => useCoverageFilters(searchWith(), nav.navigate));

    act(() => {
      result.current.setRoles(['admin', 'manager']);
    });

    expect(nav.calls[0]?.next.role).toEqual(['admin', 'manager']);
  });

  /**
   * The whitelist, shown working rather than asserted about.
   *
   * `MultiSelect` hands back `string[]`; a hand-edited option, a stale bundle or a future verdict
   * would otherwise reach the URL, survive the schema's `.catch` as a *dropped* array, and empty the
   * table with nothing on screen to explain it.
   */
  it('drops a value that is not a verdict', () => {
    const { result } = renderHook(() => useCoverageFilters(searchWith(), nav.navigate));

    act(() => {
      result.current.setGates(['grace', 'not-a-verdict']);
    });

    expect(nav.calls[0]?.next.gate).toEqual(['grace']);
  });

  it('clears every narrowing at once, the typed field included', () => {
    const search = searchWith({ q: 'boris', role: ['admin'], gate: ['grace'] });

    nav.startFrom(search);

    const { result } = renderHook(() => useCoverageFilters(search, nav.navigate));

    expect(result.current.isFiltered).toBe(true);
    expect(result.current.typed).toBe('boris');

    act(() => {
      result.current.reset();
    });

    expect(result.current.typed).toBe('');
    expect(nav.calls[0]?.next).toMatchObject({ q: '', role: [], gate: [] });
  });

  it.each([
    ['nothing narrows it', searchWith(), false],
    ['a phrase does', searchWith({ q: 'a' }), true],
    ['a role does', searchWith({ role: ['admin'] }), true],
    ['a verdict does', searchWith({ gate: ['grace'] }), true],
  ])('knows whether %s', (_case, search, expected) => {
    const { result } = renderHook(() => useCoverageFilters(search, nav.navigate));

    expect(result.current.isFiltered).toBe(expected);
  });
});

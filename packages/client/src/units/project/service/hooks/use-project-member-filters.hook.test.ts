import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  projectMembersSearchSchema,
  type ProjectMembersSearch,
} from '@units/project/model/validation/project-members-search.schema.js';

import {
  useProjectMemberFilters,
  type ProjectMembersSearchNavigation,
} from './use-project-member-filters.hook.js';

/**
 * The roster's filter, without a router (STORY-014-02, acceptance 10): what the next URL is, as a
 * function of the current one. Every write replaces; typing reaches the URL once, after the pause,
 * while the input answers at once.
 */

const TYPING_PAUSE_MS = 300;

const searchWith = (overrides: Partial<ProjectMembersSearch> = {}): ProjectMembersSearch => ({
  ...projectMembersSearchSchema.parse({}),
  ...overrides,
});

interface Recorded {
  readonly next: ProjectMembersSearch;
  readonly replace: boolean;
}

let calls: Recorded[];
let current: ProjectMembersSearch;

const navigate: ProjectMembersSearchNavigation = (input) => {
  calls.push({ next: input.search(current), replace: input.replace });
};

const mount = (search: ProjectMembersSearch) => {
  current = search;

  return renderHook(() => useProjectMemberFilters(search, navigate));
};

beforeEach(() => {
  vi.useFakeTimers();
  calls = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the roles', () => {
  it('writes the chosen roles, replacing the entry', () => {
    const { result } = mount(searchWith({ q: 'anna' }));

    act(() => {
      result.current.setRoles(['LEAD', 'MEMBER']);
    });

    expect(calls).toEqual([
      { next: searchWith({ q: 'anna', role: ['LEAD', 'MEMBER'] }), replace: true },
    ]);
  });

  it('drops a value that is not a project role before it reaches the URL', () => {
    const { result } = mount(searchWith());

    act(() => {
      result.current.setRoles(['LEAD', 'OWNER']);
    });

    expect(calls[0]?.next.role).toEqual(['LEAD']);
  });
});

describe('typing', () => {
  it('answers in the input at once and writes the URL once, after the pause', () => {
    const { result } = mount(searchWith());

    act(() => {
      result.current.setQuery('a');
      result.current.setQuery('an');
      result.current.setQuery('ann');
    });

    expect(result.current.typed).toBe('ann');
    expect(calls).toHaveLength(0);

    act(() => {
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(calls).toEqual([{ next: searchWith({ q: 'ann' }), replace: true }]);
  });

  it('takes the phrase out of the URL when the box is emptied', () => {
    const { result } = mount(searchWith({ q: 'ann' }));

    act(() => {
      result.current.setQuery('  ');
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(calls[0]?.next.q).toBeUndefined();
  });
});

describe('taking filters off', () => {
  it('removes one role by its chip, and nothing else', () => {
    const { result } = mount(searchWith({ q: 'ann', role: ['LEAD', 'OBSERVER'] }));

    act(() => {
      result.current.removeFilter('role:LEAD');
    });

    expect(calls[0]?.next).toEqual(searchWith({ q: 'ann', role: ['OBSERVER'] }));
  });

  it('removes the phrase by its chip, clearing the box too', () => {
    const { result } = mount(searchWith({ q: 'ann' }));

    act(() => {
      result.current.removeFilter('q');
    });

    expect(result.current.typed).toBe('');
    expect(calls[0]?.next.q).toBeUndefined();
  });

  it('writes nothing for an id it did not hand out', () => {
    const { result } = mount(searchWith({ role: ['LEAD'] }));

    act(() => {
      result.current.removeFilter('role:MEMBER');
      result.current.removeFilter('nonsense');
    });

    expect(calls).toHaveLength(0);
  });

  it('resets everything — and a keystroke still waiting does not bring the phrase back', () => {
    const { result } = mount(searchWith({ q: 'ann', role: ['LEAD'] }));

    act(() => {
      result.current.setQuery('anna');
      result.current.reset();
      vi.advanceTimersByTime(TYPING_PAUSE_MS);
    });

    expect(calls).toEqual([{ next: searchWith(), replace: true }]);
    expect(result.current.typed).toBe('');
  });
});

describe('what is narrowing', () => {
  it('lists a chip per filter, in the order the controls stand', () => {
    const { result } = mount(searchWith({ q: 'ann', role: ['LEAD', 'OBSERVER'] }));

    expect(result.current.active).toEqual([
      { id: 'q', labelKey: 'projects.members.filters.chip.query' },
      { id: 'role:LEAD', labelKey: 'projects.role.LEAD' },
      { id: 'role:OBSERVER', labelKey: 'projects.role.OBSERVER' },
    ]);
    expect(result.current.isFiltered).toBe(true);
  });

  it('says nothing is narrowing an unfiltered roster', () => {
    const { result } = mount(searchWith());

    expect(result.current.active).toEqual([]);
    expect(result.current.isFiltered).toBe(false);
  });
});

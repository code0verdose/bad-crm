import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { type RoleListEntry } from '@units/iam/api';

import { useRoleMatrixDraft } from './use-role-matrix-draft.hook.js';

/**
 * The draft: what the matrix screen holds between a click and a save.
 *
 * Everything here is about **not writing yet**. A cell toggles local state, twelve of them make one
 * request, and a cell toggled back leaves no trace — the last part matters more than it looks,
 * because a draft that remembers a change that undid itself sends a role its own composition and
 * invalidates everybody holding it for nothing.
 */

const roles: readonly RoleListEntry[] = [
  {
    id: 'role-1',
    key: 'tech_writer',
    name: 'Technical writer',
    description: null,
    isSystem: false,
    isDefault: false,
    holderCount: 2,
    permissions: ['task:read'],
  },
  {
    id: 'role-2',
    key: 'manager',
    name: 'Manager',
    description: null,
    isSystem: true,
    isDefault: false,
    holderCount: 5,
    permissions: ['task:read', 'task:update'],
  },
];

const draftOf = (): ReturnType<typeof renderHook<ReturnType<typeof useRoleMatrixDraft>, unknown>> =>
  renderHook(() => useRoleMatrixDraft(roles));

describe('holding a draft', () => {
  it('starts from what the roles grant', () => {
    const { result } = draftOf();

    expect(result.current.grants('role-1', 'task:read')).toBe(true);
    expect(result.current.grants('role-1', 'task:update')).toBe(false);
    expect(result.current.changeCount).toBe(0);
    expect(result.current.changes).toEqual([]);
  });

  it('toggles a cell without asking the server', () => {
    const { result } = draftOf();

    act(() => {
      result.current.toggle('role-1', 'task:update');
    });

    expect(result.current.grants('role-1', 'task:update')).toBe(true);
    expect(result.current.changeCount).toBe(1);
    // The whole composition, not a delta: the same shape the endpoint takes.
    expect(result.current.changes).toEqual([
      { roleId: 'role-1', permissions: ['task:read', 'task:update'] },
    ]);
  });

  it('forgets a change that undid itself', () => {
    // Otherwise the draft sends a role its own composition, and everybody holding it is invalidated
    // for a change that never happened.
    const { result } = draftOf();

    act(() => {
      result.current.toggle('role-1', 'task:update');
    });
    act(() => {
      result.current.toggle('role-1', 'task:update');
    });

    expect(result.current.changeCount).toBe(0);
    expect(result.current.changes).toEqual([]);
  });

  it('counts roles, not cells', () => {
    // «12 changes» on the bar would be twelve requests in the reader's head; what is saved is a
    // composition per role, and that is what the summary has to agree with.
    const { result } = draftOf();

    act(() => {
      result.current.toggle('role-1', 'task:update');
    });
    act(() => {
      result.current.toggle('role-1', 'doc:read');
    });

    expect(result.current.changeCount).toBe(1);
  });

  it('refuses to touch a system role', () => {
    // Its composition is code, re-applied on every upgrade; an edit here would look like it worked
    // and vanish on the next release. The screen greys the column out, and the draft agrees.
    const { result } = draftOf();

    act(() => {
      result.current.toggle('role-2', 'doc:read');
    });

    expect(result.current.grants('role-2', 'doc:read')).toBe(false);
    expect(result.current.changeCount).toBe(0);
  });

  it('ignores a click on a role that is no longer there', () => {
    // Deleted by somebody else while this draft was open: the column is about to disappear, and
    // inventing a composition for it would send the server a change to a role that is gone.
    const { result } = draftOf();

    act(() => {
      result.current.toggle('role-deleted-elsewhere', 'task:read');
    });

    expect(result.current.changeCount).toBe(0);
  });

  it('drops everything on reset', () => {
    const { result } = draftOf();

    act(() => {
      result.current.toggle('role-1', 'task:update');
    });
    act(() => {
      result.current.reset();
    });

    expect(result.current.changeCount).toBe(0);
    expect(result.current.grants('role-1', 'task:update')).toBe(false);
  });

  it('reads through to a role that arrived after the draft started', () => {
    // The list is refetched while somebody is editing: a role they never touched shows what the
    // server says, not what an empty draft would imply.
    const { result, rerender } = renderHook(
      ({ list }: { list: readonly RoleListEntry[] }) => useRoleMatrixDraft(list),
      { initialProps: { list: roles } },
    );

    act(() => {
      result.current.toggle('role-1', 'task:update');
    });

    rerender({
      list: [
        ...roles,
        {
          id: 'role-3',
          key: 'auditor',
          name: 'Auditor',
          description: null,
          isSystem: false,
          isDefault: false,
          holderCount: 0,
          permissions: ['doc:read'],
        },
      ],
    });

    expect(result.current.grants('role-3', 'doc:read')).toBe(true);
    // And the draft in progress survives the refetch.
    expect(result.current.grants('role-1', 'task:update')).toBe(true);
  });
});

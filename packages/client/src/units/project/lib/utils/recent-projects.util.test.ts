import { describe, expect, it } from 'vitest';

import {
  RECENT_PROJECTS_MAX,
  inRecencyOrder,
  mergeRecentProjects,
  sanitizeRecentProjectIds,
  withRecentProject,
  withoutRecentProject,
} from './recent-projects.util.js';

const id = (n: number): string => `018f4a3b-0000-7000-8000-${n.toString().padStart(12, '0')}`;

describe('recently visited projects', () => {
  it.each<[string, unknown, string[]]>([
    ['not an array', { ids: [id(1)] }, []],
    ['nothing stored', null, []],
    ['values that are not ids', [id(1), 'x', 42, null, `${id(2)} `], [id(1)]],
    ['duplicates', [id(1), id(1), id(2)], [id(1), id(2)]],
    ['more than the bound', [1, 2, 3, 4, 5, 6, 7].map(id), [1, 2, 3, 4, 5].map(id)],
  ])('keeps only what is safe to use: %s', (_case, stored, expected) => {
    expect(sanitizeRecentProjectIds(stored)).toEqual(expected);
  });

  it('moves a visited project to the front and drops the oldest past the bound', () => {
    const full = [1, 2, 3, 4, 5].map(id);

    expect(RECENT_PROJECTS_MAX).toBe(5);
    expect(withRecentProject(full, id(3))).toEqual([3, 1, 2, 4, 5].map(id));
    expect(withRecentProject(full, id(9))).toEqual([9, 1, 2, 3, 4].map(id));
    expect(withRecentProject([], id(1))).toEqual([id(1)]);
  });

  it('forgets one project and keeps the others in order', () => {
    expect(withoutRecentProject([1, 2, 3].map(id), id(2))).toEqual([1, 3].map(id));
    expect(withoutRecentProject([id(1)], id(9))).toEqual([id(1)]);
  });

  it('puts this tab’s visits before what the browser remembered, minus the forgotten', () => {
    expect(mergeRecentProjects([id(3), id(1)], [id(1), id(2), 'junk', id(4)], [id(2)])).toEqual([
      id(3),
      id(1),
      id(4),
    ]);
    expect(mergeRecentProjects([], { not: 'a list' }, [])).toEqual([]);
    expect(mergeRecentProjects([1, 2, 3].map(id), [4, 5, 6].map(id), [])).toEqual(
      [1, 2, 3, 4, 5].map(id),
    );
  });

  it('orders the server’s answer by the visit order, leaving out what it did not return', () => {
    const answered = [{ id: id(1) }, { id: id(2) }, { id: id(3) }];

    expect(inRecencyOrder(answered, [3, 9, 1].map(id))).toEqual([{ id: id(3) }, { id: id(1) }]);
  });
});

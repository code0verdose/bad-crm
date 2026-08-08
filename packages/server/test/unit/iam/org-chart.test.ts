import { describe, expect, it } from 'vitest';

import { closesManagerCycle, type ManagerLinks } from '@/domain/iam/org-chart.util.js';

/**
 * The org chart is a tree, and this is the one function that keeps it one.
 *
 * Everything that reads it — «кто мой руководитель», «покажи ветку», планирование загрузки —
 * assumes the walk upwards terminates. A single closed loop makes all of them non-terminating, and
 * the loop is created by an edit that looks perfectly ordinary from the form.
 */

const chain = (pairs: readonly [string, string][]): ManagerLinks => new Map(pairs);

describe('an edge that would close a loop', () => {
  it('refuses the two-person cycle', () => {
    // Ivan manages Pyotr; making Pyotr manage Ivan is the case the acceptance criterion names.
    expect(
      closesManagerCycle({ userId: 'ivan', managerId: 'pyotr' }, chain([['pyotr', 'ivan']])),
    ).toBe(true);
  });

  it('refuses somebody managing themselves', () => {
    expect(closesManagerCycle({ userId: 'ivan', managerId: 'ivan' }, chain([]))).toBe(true);
  });

  it('refuses a loop several links up', () => {
    // ivan → olga → pyotr, and pyotr is about to report to ivan.
    expect(
      closesManagerCycle(
        { userId: 'pyotr', managerId: 'ivan' },
        chain([
          ['ivan', 'olga'],
          ['olga', 'pyotr'],
        ]),
      ),
    ).toBe(true);
  });
});

describe('an edge that keeps it a tree', () => {
  it('allows a manager who reports to nobody', () => {
    expect(closesManagerCycle({ userId: 'ivan', managerId: 'olga' }, chain([]))).toBe(false);
  });

  it('allows two people reporting to the same person', () => {
    expect(
      closesManagerCycle({ userId: 'pyotr', managerId: 'olga' }, chain([['ivan', 'olga']])),
    ).toBe(false);
  });

  it('allows clearing the manager', () => {
    expect(closesManagerCycle({ userId: 'ivan', managerId: null }, chain([['ivan', 'olga']]))).toBe(
      false,
    );
  });

  it('allows a long chain that does not come back', () => {
    expect(
      closesManagerCycle(
        { userId: 'new', managerId: 'a' },
        chain([
          ['a', 'b'],
          ['b', 'c'],
          ['c', 'd'],
        ]),
      ),
    ).toBe(false);
  });
});

describe('links that already contain a loop', () => {
  it('terminates instead of walking for ever', () => {
    // Data written before this check existed, or by a repair that went wrong. The answer is about
    // the edge being proposed; the existing loop is somebody else's problem, and hanging here would
    // make it everybody's.
    expect(
      closesManagerCycle(
        { userId: 'new', managerId: 'a' },
        chain([
          ['a', 'b'],
          ['b', 'a'],
        ]),
      ),
    ).toBe(false);
  });
});

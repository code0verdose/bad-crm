import { describe, expect, it } from 'vitest';

import { nameOf } from './name-of.util.js';
import { projectRoster } from './project-roster.util.js';

/**
 * The roster of the overview: memberships (ids, roles, allocation) joined with the directory
 * (names), which is a different read behind a different permission.
 */

const lead = { userId: 'u-lead', projectRole: 'LEAD', allocationPct: 50 } as const;
const member = { userId: 'u-member', projectRole: 'MEMBER', allocationPct: 100 } as const;

const people = [
  { userId: 'u-lead', firstName: 'Anna', lastName: 'Ivanova', email: 'anna@example.test' },
  // A neighbour who is not on the project: the join must not drag them in.
  { userId: 'u-other', firstName: 'Oleg', lastName: 'Petrov', email: 'oleg@example.test' },
];

// The label rule itself — name, or the fallback — is `SharedLib.personLabel`'s and is tested
// there. What is pinned here is which fallback the project passes: the address, not the id.
const unnamed = { userId: 'u-unnamed', firstName: '', lastName: ' ', email: 'x@example.test' };

describe('nameOf', () => {
  it('is the name of the one account asked about, not of a neighbour', () => {
    expect(nameOf('u-lead', people)).toBe('Anna Ivanova');
    expect(nameOf('u-other', people)).toBe('Oleg Petrov');
  });

  it('is the address of somebody the directory knows but nobody has named', () => {
    expect(nameOf('u-unnamed', [unnamed])).toBe('x@example.test');
  });

  it('is the id when the reader may see nobody', () => {
    expect(nameOf('u-lead', [])).toBe('u-lead');
  });
});

describe('projectRoster', () => {
  it('names the people the directory knows, in the order of the roster', () => {
    expect(projectRoster([lead, member], people)).toEqual([
      { userId: 'u-lead', projectRole: 'LEAD', allocationPct: 50, label: 'Anna Ivanova' },
      { userId: 'u-member', projectRole: 'MEMBER', allocationPct: 100, label: 'u-member' },
    ]);
  });

  it('labels somebody unnamed by their address', () => {
    const joined = { userId: 'u-unnamed', projectRole: 'MEMBER', allocationPct: 10 } as const;

    expect(projectRoster([joined], [unnamed]).map((row) => row.label)).toEqual(['x@example.test']);
  });

  it('shows the id — not a gap — when the reader may not see the directory at all', () => {
    expect(projectRoster([lead], []).map((row) => row.label)).toEqual(['u-lead']);
  });

  it('puts the lead first whatever the joining order, so the card opens with who runs it', () => {
    expect(projectRoster([member, lead], people).map((row) => row.userId)).toEqual([
      'u-lead',
      'u-member',
    ]);
  });
});

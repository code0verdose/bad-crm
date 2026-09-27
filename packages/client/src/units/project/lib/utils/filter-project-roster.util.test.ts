import { describe, expect, it } from 'vitest';

import { filterProjectRoster } from './filter-project-roster.util.js';
import { type ProjectRosterRow } from './project-roster.util.js';

const row = (userId: string, label: string, projectRole: ProjectRosterRow['projectRole']) => ({
  userId,
  label,
  projectRole,
  allocationPct: 50,
});

const ROWS: readonly ProjectRosterRow[] = [
  row('u-1', 'Anna Ivanova', 'LEAD'),
  row('u-2', 'Oleg Petrov', 'MEMBER'),
  row('u-3', 'Ирина Смирнова', 'REVIEWER'),
  row('u-4', 'Boris Annenkov', 'OBSERVER'),
];

const labels = (rows: readonly ProjectRosterRow[]) => rows.map((r) => r.label);

describe('filterProjectRoster', () => {
  it('returns the roster as it is when nothing narrows it', () => {
    expect(filterProjectRoster(ROWS, { q: undefined, role: [] })).toEqual(ROWS);
  });

  it('matches the phrase anywhere in the name, whatever the case', () => {
    expect(labels(filterProjectRoster(ROWS, { q: 'ANN', role: [] }))).toEqual([
      'Anna Ivanova',
      'Boris Annenkov',
    ]);
  });

  it('matches a Cyrillic phrase in another case', () => {
    expect(labels(filterProjectRoster(ROWS, { q: 'смирн', role: [] }))).toEqual(['Ирина Смирнова']);
  });

  it('keeps only the roles asked for', () => {
    expect(labels(filterProjectRoster(ROWS, { q: undefined, role: ['LEAD', 'OBSERVER'] }))).toEqual(
      ['Anna Ivanova', 'Boris Annenkov'],
    );
  });

  it('applies both at once — a row has to satisfy each', () => {
    expect(labels(filterProjectRoster(ROWS, { q: 'ann', role: ['OBSERVER'] }))).toEqual([
      'Boris Annenkov',
    ]);
  });

  it('keeps the order it was given', () => {
    const reversed = [...ROWS].reverse();

    expect(labels(filterProjectRoster(reversed, { q: 'ann', role: [] }))).toEqual([
      'Boris Annenkov',
      'Anna Ivanova',
    ]);
  });
});

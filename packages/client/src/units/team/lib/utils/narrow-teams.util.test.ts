import { describe, expect, it } from 'vitest';

import { teamListSearchSchema } from '@units/team/model/validation/team-list-search.schema.js';
import { type TeamListEntry } from '@units/team/api';

import { narrowTeams, TEAMS_PER_PAGE } from './narrow-teams.util.js';

/**
 * Searching, ordering and paging the org structure — over the answer, because `GET /teams` takes no
 * parameters at all.
 *
 * That is the property worth stating once, here, rather than discovering it per screen: the endpoint
 * publishes every live team of the organization in one document, so there is nothing to send a
 * filter to. A hook that pretended otherwise would spend a request per keystroke and get the same
 * bytes back each time, and a query key carrying the filter would keep one cache entry per phrase
 * somebody typed.
 *
 * Which makes this a pure function, and lets the awkward cases be stated as data rather than as a
 * screen somebody has to drive: the phrase that matches a slug and not a name, the order that has to
 * be stable when two teams are the same size, and the page that stopped existing because the filter
 * that narrowed the list did not know which page the reader was on.
 */

const team = (name: string, slug: string, memberCount: number): TeamListEntry => ({
  id: `018f4a3b-2c1d-7a41-9f00-2b7c1d0e${slug.padEnd(4, '0').slice(0, 4)}`,
  name,
  slug,
  description: null,
  memberCount,
});

const BACKEND = team('Backend', 'backend', 7);
const FRONTEND = team('Frontend', 'web-client', 3);
const DESIGN = team('Design', 'design', 7);

const ALL = [BACKEND, FRONTEND, DESIGN] as const;

const search = (overrides: Record<string, unknown> = {}) => teamListSearchSchema.parse(overrides);

const namesOf = (input: readonly TeamListEntry[]): string[] => input.map((entry) => entry.name);

describe('narrowing by phrase', () => {
  it('keeps everything when nothing was typed', () => {
    expect(namesOf(narrowTeams(ALL, search()).items)).toEqual(['Backend', 'Design', 'Frontend']);
  });

  it('matches part of a name, whatever case it was typed in', () => {
    expect(namesOf(narrowTeams(ALL, search({ q: 'END' })).items)).toEqual(['Backend', 'Frontend']);
  });

  /**
   * The slug is searchable too, and it is not a duplicate of the name: a team called «Frontend»
   * whose address is `web-client` is exactly the case where somebody types what they saw in a URL.
   */
  it('matches the slug, which is not always a spelling of the name', () => {
    expect(namesOf(narrowTeams(ALL, search({ q: 'web' })).items)).toEqual(['Frontend']);
  });

  it('reports how many matched, not how many are on the page', () => {
    expect(narrowTeams(ALL, search({ q: 'end' })).total).toBe(2);
  });

  it('matches nothing rather than everything when the phrase is in neither field', () => {
    expect(narrowTeams(ALL, search({ q: 'legal' })).items).toEqual([]);
  });
});

describe('ordering', () => {
  it.each([
    ['name', ['Backend', 'Design', 'Frontend']],
    ['-name', ['Frontend', 'Design', 'Backend']],
  ])('by %s', (sort, expected) => {
    expect(namesOf(narrowTeams(ALL, search({ sort })).items)).toEqual(expected);
  });

  /**
   * Size first, name second — and the second half is the point. `Backend` and `Design` both have
   * seven people, and a comparator that returned zero would leave them in whatever order the server
   * happened to serialise: a table that reshuffles between two identical answers.
   */
  /**
   * Two teams that are equal on every key the order looks at.
   *
   * `slug` is unique and `name` is not, so «Backend» twice is a state the organization can really be
   * in. The comparator has to answer zero rather than pick one — anything else would be an order
   * that depends on which of the two was compared first, which is the wobble the tiebreaker exists
   * to remove, reintroduced one level down.
   */
  it('leaves two teams of the same name in the order they arrived', () => {
    const twins = [team('Backend', 'backend-old', 1), team('Backend', 'backend', 9)] as const;

    expect(narrowTeams(twins, search()).items.map((entry) => entry.slug)).toEqual([
      'backend-old',
      'backend',
    ]);
  });

  it('by size, breaking a tie by name so the order cannot wobble', () => {
    expect(namesOf(narrowTeams(ALL, search({ sort: '-members' })).items)).toEqual([
      'Backend',
      'Design',
      'Frontend',
    ]);
    expect(namesOf(narrowTeams(ALL, search({ sort: 'members' })).items)).toEqual([
      'Frontend',
      'Backend',
      'Design',
    ]);
  });
});

describe('paging', () => {
  const many = Array.from({ length: TEAMS_PER_PAGE + 3 }, (_, index) =>
    team(`Team ${String(index).padStart(2, '0')}`, `team-${String(index)}`, index),
  );

  it('cuts the first page to the size of a page', () => {
    expect(narrowTeams(many, search()).items).toHaveLength(TEAMS_PER_PAGE);
  });

  it('carries the rest onto the next one', () => {
    const rest = narrowTeams(many, search({ page: 2 }));

    expect(rest.items).toHaveLength(3);
    expect(rest.page).toBe(2);
  });

  /**
   * The page that stopped existing.
   *
   * A filter narrows the list without knowing where the reader was, so page three of «everybody» can
   * be past the end of «everybody called design». Answering with an empty table would look like «no
   * such teams» — the wrong sentence, about the wrong thing. The last page that does exist is the
   * honest answer, and it is what the pager then highlights.
   */
  it('falls back to the last page that exists rather than showing an empty one', () => {
    const beyond = narrowTeams(many, search({ page: 9 }));

    expect(beyond.page).toBe(2);
    expect(beyond.items).toHaveLength(3);
  });

  it('stays on page one when the filter matched nothing at all', () => {
    const nothing = narrowTeams(many, search({ page: 9, q: 'legal' }));

    expect(nothing.page).toBe(1);
    expect(nothing.total).toBe(0);
  });
});

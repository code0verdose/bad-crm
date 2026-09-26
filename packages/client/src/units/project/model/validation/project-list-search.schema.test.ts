import { SharedValidation } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { projectListSearchSchema } from './project-list-search.schema.js';

/**
 * The address bar of `/projects`, parsed (STORY-014-04, acceptance 1).
 *
 * Everything here arrives from a link somebody sent, a bookmark or a hand-edited URL, so the only
 * acceptable reaction to rubbish is the default — never a thrown error, which would replace the
 * screen with the error boundary and, with `replace: true`, keep the broken address in the bar.
 */

const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';

describe('projectListSearchSchema', () => {
  it('fills every field from nothing: first page, by name, as cards, no filter', () => {
    expect(projectListSearchSchema.parse({})).toEqual({
      page: 1,
      perPage: 25,
      sort: 'name',
      status: [],
      view: 'grid',
    });
  });

  it('keeps a well-formed address as it is', () => {
    expect(
      projectListSearchSchema.parse({
        q: ' bad ',
        status: ['ACTIVE', 'ON_HOLD'],
        lead: LEAD,
        member: 'me',
        sort: '-createdAt',
        page: '3',
        perPage: '50',
        view: 'table',
      }),
    ).toEqual({
      q: 'bad',
      status: ['ACTIVE', 'ON_HOLD'],
      lead: LEAD,
      member: 'me',
      sort: '-createdAt',
      page: 3,
      perPage: 50,
      view: 'table',
    });
  });

  it.each([
    ['a status that is not one', { status: ['ACTIVE', 'DELETED'] }, { status: [] }],
    ['a status that is not a list', { status: 'ACTIVE' }, { status: [] }],
    ['an order by a column nobody exposed', { sort: 'budget' }, { sort: 'name' }],
    ['a lead that is not an id', { lead: 'u1' }, { lead: undefined }],
    ['«member» naming somebody else', { member: LEAD }, { member: undefined }],
    ['a page that is a word', { page: 'abc' }, { page: 1 }],
    ['a page below one', { page: '0' }, { page: 1 }],
    ['a fractional page', { page: '1.5' }, { page: 1 }],
    ['a page the server refuses', { page: String(SharedValidation.MAX_PAGE + 1) }, { page: 1 }],
    ['a page size over the cap', { perPage: '101' }, { perPage: 25 }],
    ['a view that does not exist', { view: 'kanban' }, { view: 'grid' }],
    ['a search longer than the server accepts', { q: 'x'.repeat(65) }, { q: undefined }],
    ['a blank search', { q: '   ' }, { q: undefined }],
  ])('falls back to the default for %s', (_case, input, expected) => {
    expect(projectListSearchSchema.parse(input)).toMatchObject(expected);
  });

  it('accepts the last page the server serves', () => {
    expect(projectListSearchSchema.parse({ page: String(SharedValidation.MAX_PAGE) }).page).toBe(
      SharedValidation.MAX_PAGE,
    );
  });

  it('has no `client` filter: projects have no client until STORY-014-07', () => {
    // The server answers `?client=` with 422; a schema that kept it would forward it.
    expect(projectListSearchSchema.parse({ client: LEAD })).not.toHaveProperty('client');
  });
});

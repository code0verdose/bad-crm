import { describe, expect, it } from 'vitest';

import { projectMembersSearchSchema } from './project-members-search.schema.js';

/**
 * The address of `/projects/$projectId/members` is the roster's filter (STORY-014-02, acceptance 10).
 * A hand-edited or stale link must fall back field by field, never throw: a failed `validateSearch`
 * replaces the section with the error boundary, and every write here is `replace`, so the broken
 * address would stay in the bar.
 */
describe('projectMembersSearchSchema', () => {
  it('opens unfiltered when nothing is in the address', () => {
    expect(projectMembersSearchSchema.parse({})).toEqual({ q: undefined, role: [] });
  });

  it.each([
    ['a phrase longer than the field allows', { q: 'x'.repeat(65) }, { q: undefined }],
    ['a phrase that is not text', { q: 7 }, { q: undefined }],
    ['a blank phrase', { q: '   ' }, { q: undefined }],
    ['a role that is not a project role', { role: ['OWNER'] }, { role: [] }],
    ['a role that is not a list', { role: 'LEAD' }, { role: [] }],
    ['more roles than there are', { role: Array(5).fill('LEAD') }, { role: [] }],
  ])('falls back on %s', (_case, input, expected) => {
    expect(projectMembersSearchSchema.parse(input)).toMatchObject(expected);
  });

  it('keeps what it recognises, trimmed', () => {
    expect(projectMembersSearchSchema.parse({ q: ' anna ', role: ['LEAD', 'OBSERVER'] })).toEqual({
      q: 'anna',
      role: ['LEAD', 'OBSERVER'],
    });
  });
});

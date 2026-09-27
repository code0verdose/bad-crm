import { describe, expect, it } from 'vitest';

import {
  calendarDayOf,
  instantOfDay,
  newProjectValues,
  projectEditValuesOf,
  toProjectDraft,
  toProjectPatch,
} from './project-draft.util.js';

const LEAD = '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11';

describe('calendar days and instants', () => {
  it('reads the day of an instant in UTC, and «not set» as an empty field', () => {
    expect(calendarDayOf('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
    // Late in the UTC day is still that day — not the next one in a zone east of Greenwich.
    expect(calendarDayOf('2026-10-01T23:30:00.000Z')).toBe('2026-10-01');
    expect(calendarDayOf(null)).toBe('');
  });

  it('writes the start of the day, UTC, and an empty field as null', () => {
    expect(instantOfDay('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(instantOfDay('')).toBeNull();
  });

  it('round-trips a day', () => {
    expect(calendarDayOf(instantOfDay('2027-02-28'))).toBe('2027-02-28');
  });
});

describe('the form as the request body', () => {
  const edit = {
    name: '  Bad CRM ',
    description: '   ',
    leadId: LEAD,
    color: 'info',
    startedAt: '2026-10-01',
    dueAt: '',
  };

  it('trims, sends an empty description as null, and dates as instants', () => {
    expect(toProjectPatch(edit)).toEqual({
      name: 'Bad CRM',
      description: null,
      leadId: LEAD,
      color: 'info',
      startedAt: '2026-10-01T00:00:00.000Z',
      dueAt: null,
    });
  });

  it('keeps a written description', () => {
    expect(toProjectPatch({ ...edit, description: ' One tool. ' }).description).toBe('One tool.');
  });

  it('adds the key and the visibility for a create', () => {
    const draft = toProjectDraft({ ...edit, key: ' bad ', visibility: 'PRIVATE' });

    expect(draft.key).toBe('bad');
    expect(draft.visibility).toBe('PRIVATE');
    expect(draft.name).toBe('Bad CRM');
  });
});

describe('the stored project as the settings form', () => {
  it('turns nulls into empty fields and instants into days', () => {
    expect(
      projectEditValuesOf({
        name: 'Bad CRM',
        description: null,
        leadId: LEAD,
        color: 'brand',
        startedAt: '2026-09-01T00:00:00.000Z',
        dueAt: null,
      }),
    ).toEqual({
      name: 'Bad CRM',
      description: '',
      leadId: LEAD,
      color: 'brand',
      startedAt: '2026-09-01',
      dueAt: '',
    });
  });
});

describe('a new project', () => {
  it('is led by the reader until somebody picks otherwise, and is open to the organization', () => {
    expect(newProjectValues(LEAD)).toMatchObject({
      leadId: LEAD,
      visibility: 'PUBLIC_ORG',
      color: 'brand',
    });
  });

  it('has no lead when the reader is not known — the schema then asks for one', () => {
    expect(newProjectValues(undefined).leadId).toBe('');
  });
});

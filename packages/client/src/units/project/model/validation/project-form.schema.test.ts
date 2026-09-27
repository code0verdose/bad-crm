import { describe, expect, it } from 'vitest';

import {
  MAX_PROJECT_DESCRIPTION,
  MAX_PROJECT_NAME,
  projectEditFormSchema,
  projectFormSchema,
  type ProjectFormValues,
} from './project-form.schema.js';

const valid = (overrides: Partial<ProjectFormValues> = {}): ProjectFormValues => ({
  key: 'BAD',
  name: 'Bad CRM',
  description: '',
  visibility: 'PUBLIC_ORG',
  leadId: '018f4a3b-2c1d-7a41-9f00-2b7c1d0e5b11',
  color: 'brand',
  startedAt: '',
  dueAt: '',
  ...overrides,
});

const issueAt = (values: unknown, path: string): string | undefined =>
  projectFormSchema.safeParse(values).error?.issues.find((issue) => issue.path.join('.') === path)
    ?.message;

describe('projectFormSchema', () => {
  it('accepts a well-formed project', () => {
    expect(projectFormSchema.safeParse(valid()).success).toBe(true);
  });

  it('normalizes the key the way the server does — " bad " is BAD', () => {
    expect(projectFormSchema.parse(valid({ key: ' bad ' })).key).toBe('BAD');
  });

  it.each([
    ['one character', 'B'],
    ['a leading digit', '1BAD'],
    ['eleven characters', 'ABCDEFGHIJK'],
    ['a dash', 'BA-D'],
  ])('refuses a key with %s', (_case, key) => {
    expect(issueAt(valid({ key }), 'key')).toBe('projects.field.keyInvalid');
  });

  it('asks for a key, a name and a lead', () => {
    expect(issueAt(valid({ key: '  ' }), 'key')).toBe('validation.required');
    expect(issueAt(valid({ name: ' ' }), 'name')).toBe('validation.required');
    expect(issueAt(valid({ leadId: '' }), 'leadId')).toBe('projects.field.leadRequired');
  });

  it('holds the name and the description to the contract bounds, and not one character less', () => {
    expect(projectFormSchema.safeParse(valid({ name: 'x'.repeat(MAX_PROJECT_NAME) })).success).toBe(
      true,
    );
    expect(issueAt(valid({ name: 'x'.repeat(MAX_PROJECT_NAME + 1) }), 'name')).toBe(
      'validation.text.tooLong',
    );
    expect(
      issueAt(valid({ description: 'x'.repeat(MAX_PROJECT_DESCRIPTION + 1) }), 'description'),
    ).toBe('validation.text.tooLong');
  });

  it('refuses a colour that is not a palette name, and a visibility outside the enum', () => {
    expect(issueAt(valid({ color: '' }), 'color')).toBe('validation.choice.invalid');
    expect(issueAt({ ...valid(), visibility: 'SECRET' }, 'visibility')).toBe(
      'validation.choice.invalid',
    );
  });

  it('puts a deadline before the start on the deadline field', () => {
    expect(issueAt(valid({ startedAt: '2026-10-02', dueAt: '2026-10-01' }), 'dueAt')).toBe(
      'projects.field.dueBeforeStart',
    );
  });

  it('accepts the same day, an open start, an open deadline', () => {
    for (const dates of [
      { startedAt: '2026-10-01', dueAt: '2026-10-01' },
      { startedAt: '', dueAt: '2026-10-01' },
      { startedAt: '2026-10-01', dueAt: '' },
    ]) {
      expect(projectFormSchema.safeParse(valid(dates)).success).toBe(true);
    }
  });

  it('refuses a date that is not a calendar day', () => {
    expect(issueAt(valid({ startedAt: 'tomorrow' }), 'startedAt')).toBe(
      'projects.field.dateInvalid',
    );
  });
});

describe('projectEditFormSchema', () => {
  it('has no key and no visibility — neither is edited here', () => {
    const { key: _key, visibility: _visibility, ...editable } = valid();

    expect(projectEditFormSchema.safeParse(editable).success).toBe(true);
    expect(Object.keys(projectEditFormSchema.parse({ ...editable, key: 'X' }))).not.toContain(
      'key',
    );
  });

  it('keeps the date rule', () => {
    const {
      key: _key,
      visibility: _visibility,
      ...editable
    } = valid({
      startedAt: '2026-10-02',
      dueAt: '2026-10-01',
    });

    expect(projectEditFormSchema.safeParse(editable).error?.issues[0]?.path).toEqual(['dueAt']);
  });
});

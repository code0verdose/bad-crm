import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  PROJECT_KEY_PATTERN,
  isProjectKey,
  normalizeProjectKey,
} from '@/domain/project/project-key.value.js';

/**
 * The project key as a value — STORY-014-01, acceptance 2 and 4.
 *
 * Two facts are held here that nothing else can hold: that normalization is exactly `trim` +
 * upper-case (a key a person did not type is a key a person cannot find), and that the pattern the
 * value object refuses by is the pattern the migration refuses by, read out of the migration file
 * rather than remembered.
 */

const MIGRATION = fileURLToPath(
  new URL(
    '../../../../prisma/migrations/20260906135656_projects_and_project_members/migration.sql',
    import.meta.url,
  ),
);

describe('normalizeProjectKey', () => {
  it.each([
    [' bad ', 'BAD'],
    ['bad', 'BAD'],
    ['BAD', 'BAD'],
    ['\tcrm1\n', 'CRM1'],
  ])('normalizes %j to %j', (raw, expected) => {
    expect(normalizeProjectKey(raw)).toBe(expected);
  });

  it('does not squeeze inner whitespace: that is a refusal, not a repair', () => {
    expect(normalizeProjectKey('b a d')).toBe('B A D');
    expect(isProjectKey(normalizeProjectKey('b a d'))).toBe(false);
  });
});

describe('isProjectKey', () => {
  it.each(['BAD', 'CRM1', 'A1', 'ABCDEFGHIJ'])('accepts %j', (key) => {
    expect(isProjectKey(key)).toBe(true);
  });

  it.each(['bad', ' BAD', 'B', '1AB', 'ABCDEFGHIJK', 'BA-D', 'BA_D', ''])(
    'refuses %j — the database would too',
    (key) => {
      expect(isProjectKey(key)).toBe(false);
    },
  );

  it('refuses by the pattern the migration holds, character for character', () => {
    const migration = readFileSync(MIGRATION, 'utf8');
    const constraint = /CONSTRAINT "ck_projects_key_format" CHECK \("key" ~ '([^']+)'\)/.exec(
      migration,
    );

    expect(constraint?.[1]).toBe(PROJECT_KEY_PATTERN.source);
  });
});

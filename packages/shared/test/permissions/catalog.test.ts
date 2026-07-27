import { describe, expect, it } from 'vitest';

import {
  ACCESS_LEVELS,
  ACCESS_LEVEL_RANK,
  PERMISSIONS,
  PERMISSION_DOMAINS,
  PERMISSION_META,
  atLeast,
  isPermissionKey,
  requiredLevel,
} from '../../src/permissions/index.js';

/** `^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$` — the CI regex from docs/security/permission-model.md §1. */
const KEY_FORMAT = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

/** i18n key, not a ready-made sentence (rules/i18n.mdc). */
const DESCRIPTION_KEY_FORMAT = /^permission\.[a-z0-9_.]+$/;

describe('permission catalog', () => {
  it('is a non-empty, duplicate-free list', () => {
    expect(PERMISSIONS.length).toBeGreaterThan(0);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });

  it.each([...PERMISSIONS])('%s matches <resource>:<action>', (key) => {
    expect(key).toMatch(KEY_FORMAT);
  });

  it('describes every key, and describes nothing that is not a key', () => {
    expect(Object.keys(PERMISSION_META).sort()).toEqual([...PERMISSIONS].sort());
  });

  it('keeps resource and action in sync with the key itself', () => {
    const mismatched = PERMISSIONS.filter(
      (key) => `${PERMISSION_META[key].resource}:${PERMISSION_META[key].action}` !== key,
    );

    expect(mismatched).toEqual([]);
  });

  it('assigns every key a declared domain', () => {
    const unknownDomain = PERMISSIONS.filter(
      (key) => !PERMISSION_DOMAINS.includes(PERMISSION_META[key].domain),
    );

    expect(unknownDomain).toEqual([]);
  });

  it('gives every key a non-empty i18n description key', () => {
    const badDescription = PERMISSIONS.filter(
      (key) => !DESCRIPTION_KEY_FORMAT.test(PERMISSION_META[key].descriptionKey),
    );

    expect(badDescription).toEqual([]);
  });

  it('marks destructive keys as dangerous', () => {
    expect(PERMISSION_META['organization:delete'].dangerous).toBe(true);
    expect(PERMISSION_META['organization:read'].dangerous).toBe(false);
  });

  it('declares a required ACL level or an explicit null for every key', () => {
    const badLevel = PERMISSIONS.filter((key) => {
      const level = requiredLevel(key);
      return level !== null && !ACCESS_LEVELS.includes(level);
    });

    expect(badLevel).toEqual([]);
  });

  it('narrows an arbitrary string only when the catalog contains it', () => {
    expect(isPermissionKey('organization:read')).toBe(true);
    expect(isPermissionKey('organization:reed')).toBe(false);
    expect(isPermissionKey('organization.read')).toBe(false);
  });
});

describe('access levels', () => {
  it('orders the scale from NONE to MANAGER', () => {
    expect(ACCESS_LEVELS).toEqual(['NONE', 'VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER']);
    expect(ACCESS_LEVELS.map((level) => ACCESS_LEVEL_RANK[level])).toEqual([0, 1, 2, 3, 4]);
  });

  it.each([
    ['MANAGER', 'EDITOR', true],
    ['EDITOR', 'EDITOR', true],
    ['VIEWER', 'EDITOR', false],
    ['NONE', 'VIEWER', false],
  ] as const)('atLeast(%s, %s) is %s', (actual, required, expected) => {
    expect(atLeast(actual, required)).toBe(expected);
  });
});

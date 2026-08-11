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
  type PermissionKey,
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

  /**
   * `docs/security/permission-model.md` §3.19: the verbs `override`, `unlock` and `reopen` name a
   * bypass of the normal process, and the table states the rule as absolute — «всегда `dangerous`».
   * The case above only pins one key by name; a `dangerous: false` typed onto a *different* key whose
   * action starts with one of these verbs — `permission:override_read` lost exactly this flag once,
   * caught only because the matrix audit happened to look — passed the suite above untouched. This
   * block states the rule itself, over the whole catalogue, so the next key that makes the same
   * mistake fails here regardless of which key it is.
   */
  describe('a bypass verb is always dangerous (§3.19)', () => {
    const BYPASS_VERB = /^(override|unlock|reopen)/;

    /**
     * The one documented departure from the letter of §3.19. `board:override_wip_limit` matches the
     * verb by spelling, but `permission-model.md:546` marks it "нет" (`dangerous: false`) and this
     * catalogue agrees: a WIP limit is a team's own soft preference, not the kind of control the
     * flag exists to slow a grant of down for review, the way an exception on `permission:*` or
     * `time:*` is. Widening this list is a decision about the model — `permission-model.md` §3.19
     * and this catalogue together — not something to wave through in this test file; it exists so
     * that decision is visible and requires a reason, not so it disappears silently.
     */
    const DOCUMENTED_EXCEPTIONS: readonly PermissionKey[] = ['board:override_wip_limit'];

    const bypassKeys = PERMISSIONS.filter((key) => BYPASS_VERB.test(PERMISSION_META[key].action));

    // A rule with nothing to check is not a rule — if the catalogue ever stopped declaring any
    // bypass verb at all, the `it.each` below would silently run zero cases and this file would stay
    // green while proving nothing.
    it('has at least one bypass-verb key to hold the rule against', () => {
      expect(bypassKeys.length).toBeGreaterThan(0);
    });

    it.each(bypassKeys.filter((key) => !DOCUMENTED_EXCEPTIONS.includes(key)))(
      '%s bypasses the normal process, so it is dangerous',
      (key) => {
        expect(PERMISSION_META[key].dangerous).toBe(true);
      },
    );

    it('keeps the documented exceptions from growing without a listed reason', () => {
      const undangerous = bypassKeys.filter((key) => !PERMISSION_META[key].dangerous);

      expect(undangerous).toEqual(DOCUMENTED_EXCEPTIONS);
    });
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

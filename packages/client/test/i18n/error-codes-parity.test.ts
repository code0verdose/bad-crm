/**
 * @vitest-environment node
 *
 * Every code the server can answer with has a sentence in both languages — and the sentence is
 * reachable.
 *
 * `catalogue-parity.test.ts` proves that keys *used in the source* exist in both catalogues. It
 * cannot see these: a key assembled at runtime (`errors.${code}`) is not a literal anywhere, so a
 * catalogue missing every single code would pass it while the interface rendered `errors.task_forbidden`
 * at the user. That is precisely the failure ADR-0019 forbids composing keys to avoid, and this file
 * is the other half of the guarantee: the catalogue is checked against the **contract** rather than
 * against the source.
 *
 * Both halves of a problem document are covered. `code` says the request failed; `errors[].code`
 * says which field and why, and it is translated the same way — a story that filled in one and left
 * the other would ship a form that marks a field invalid without saying anything.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SharedErrors } from '@bad-crm/shared';

import { ERROR_MESSAGE_KEY, VALIDATION_ISSUE_MESSAGE_KEY } from '@shared/api';

const LOCALES = fileURLToPath(new URL('../../src/shared/i18n/locales', import.meta.url));

const catalogue = (language: string): Record<string, unknown> =>
  JSON.parse(readFileSync(`${LOCALES}/${language}/errors.json`, 'utf8')) as Record<string, unknown>;

/** `errors.code.task_forbidden` → the value at `code.task_forbidden` in `errors.json`. */
const messageAt = (language: string, key: string): unknown =>
  key
    .split('.')
    .slice(1)
    .reduce<unknown>(
      (node, step) =>
        typeof node === 'object' && node !== null
          ? (node as Record<string, unknown>)[step]
          : undefined,
      catalogue(language),
    );

describe.each(['en', 'ru'])('the %s error catalogue', (language) => {
  it.each(SharedErrors.ERROR_CODES)('says something for %s', (code) => {
    const message = messageAt(language, ERROR_MESSAGE_KEY[code]);

    expect(typeof message).toBe('string');
    expect(message).not.toBe('');
  });

  it.each(SharedErrors.VALIDATION_ISSUE_CODES)('says something for a %s field', (code) => {
    const message = messageAt(language, VALIDATION_ISSUE_MESSAGE_KEY[code]);

    expect(typeof message).toBe('string');
    expect(message).not.toBe('');
  });

  /**
   * CONTROL: the reader above returns `undefined` for a key that is not there. Without this, a
   * mistake in the traversal would answer `undefined` for everything and every case above would
   * fail — or, worse, answer the whole subtree and pass for everything.
   */
  it('CONTROL: finds nothing for a code that does not exist', () => {
    expect(messageAt(language, 'errors.code.no_such_code')).toBeUndefined();
  });
});

/**
 * The two maps are `Record<ErrorCode, string>` and `Record<ValidationIssueCode, string>`, so a code
 * added on the server fails to compile here before it can fail to translate at a user. Asserted as
 * well as typed, because a `Record` proves the keys are present and says nothing about them being
 * *distinct*: a copy-paste that pointed two codes at one sentence would type-check perfectly.
 */
describe('the key maps', () => {
  it('covers every code exactly once, with no key left over', () => {
    expect(Object.keys(ERROR_MESSAGE_KEY).sort()).toEqual([...SharedErrors.ERROR_CODES].sort());
    expect(new Set(Object.values(ERROR_MESSAGE_KEY)).size).toBe(SharedErrors.ERROR_CODES.length);
  });

  it('covers every validation issue exactly once', () => {
    expect(Object.keys(VALIDATION_ISSUE_MESSAGE_KEY).sort()).toEqual(
      [...SharedErrors.VALIDATION_ISSUE_CODES].sort(),
    );
    expect(new Set(Object.values(VALIDATION_ISSUE_MESSAGE_KEY)).size).toBe(
      SharedErrors.VALIDATION_ISSUE_CODES.length,
    );
  });
});

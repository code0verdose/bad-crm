import { describe, expect, it } from 'vitest';

import {
  isWellFormedRecoveryCode,
  normalizeRecoveryCode,
  RECOVERY_CODE_ALPHABET,
  RECOVERY_CODE_LENGTH,
} from '@/domain/identity/recovery-code.value.js';

describe('RECOVERY_CODE_ALPHABET', () => {
  it('excludes the confusable characters STORY-013-02 names by name', () => {
    for (const confusable of ['0', 'O', '1', 'I', 'L']) {
      expect(RECOVERY_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('has no duplicate characters', () => {
    expect(new Set(RECOVERY_CODE_ALPHABET.split('')).size).toBe(RECOVERY_CODE_ALPHABET.length);
  });
});

describe('normalizeRecoveryCode', () => {
  it('upper-cases lower-case input', () => {
    expect(normalizeRecoveryCode('abcde23456')).toBe('ABCDE23456');
  });

  it('strips dashes a person might type between groups', () => {
    expect(normalizeRecoveryCode('ABCDE-23456')).toBe('ABCDE23456');
  });

  it('strips spaces and surrounding whitespace, including a trailing newline from a .txt file', () => {
    expect(normalizeRecoveryCode('  ABCDE 23456\n')).toBe('ABCDE23456');
  });

  it('is idempotent: normalizing an already-normalized code changes nothing', () => {
    const once = normalizeRecoveryCode('ABCDE-23456');

    expect(normalizeRecoveryCode(once)).toBe(once);
  });

  /**
   * The docstring's claim, made literal: "strips everything that is not part of the alphabet" — not
   * only the two characters (`-`, ` `) an earlier version of this function actually removed. A stray
   * character from a copy-paste (an underscore, a punctuation mark the download added) has to come
   * out the same way a dash does, or the claim above is fiction and `isWellFormedRecoveryCode` would
   * be the only thing standing between a caller and ten Argon2id verifications over garbage input.
   */
  it('strips a character that is neither a dash nor a space and not in the alphabet', () => {
    expect(normalizeRecoveryCode('ABCDE!23456')).toBe('ABCDE23456');
    expect(normalizeRecoveryCode('ABCDE_23456')).toBe('ABCDE23456');
  });
});

describe('isWellFormedRecoveryCode', () => {
  it('accepts a code of the right length drawn entirely from the alphabet', () => {
    expect(isWellFormedRecoveryCode('ABCDE23456')).toBe(true);
  });

  it('accepts one with dashes and mixed case, after normalization', () => {
    expect(isWellFormedRecoveryCode('abcde-23456')).toBe(true);
  });

  it.each(['0', 'O', '1', 'l', 'I', 'L'])(
    'rejects a code containing the confusable "%s"',
    (char) => {
      expect(isWellFormedRecoveryCode(`ABCDE2345${char}`)).toBe(false);
    },
  );

  it('rejects a code that is too short', () => {
    expect(isWellFormedRecoveryCode('ABCDE234')).toBe(false);
  });

  it('rejects a code that is too long', () => {
    expect(isWellFormedRecoveryCode('ABCDE23456789')).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(isWellFormedRecoveryCode('')).toBe(false);
  });
});

describe('RECOVERY_CODE_LENGTH', () => {
  it('is ten characters, per STORY-013-02 acceptance 1', () => {
    expect(RECOVERY_CODE_LENGTH).toBe(10);
  });
});

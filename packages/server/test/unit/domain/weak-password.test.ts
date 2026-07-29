import { describe, expect, it } from 'vitest';

import { isWeakPassword } from '@/domain/identity/weak-password.util.js';

describe('the weak-password check', () => {
  it.each([
    ['a keyboard walk padded to length', 'qwertyuiop12'],
    ['a dictionary word with leetspeak', 'P@ssw0rd1234'],
    ['the product name', 'badcrm123456'],
    ['one character repeated', 'aaaaaaaaaaaa'],
    ['an ascending run', 'abcdefghijkl'],
    ['a descending run', 'lkjihgfedcba'],
    ['a digit run', '0123456789'],
    ['digits only', '198403121985'],
    ['nothing at all', '   '],
  ])('refuses %s', (_case, password) => {
    expect(isWeakPassword(password)).toBe(true);
  });

  it.each([
    ['a passphrase', 'correct-horse-battery-staple'],
    ['generated noise', 'x7Qv-2mB!kR9tLpZ'],
    ['a walk buried in the middle', 'my-cat-qwerty-hat'],
    ['a word that merely contains one', 'brassword-mixer-92'],
  ])('accepts %s', (_case, password) => {
    expect(isWeakPassword(password)).toBe(false);
  });

  /**
   * The refusal is about the *start* of the password: a manager-generated string that happens to
   * contain `admin` is not guessable, and rejecting it would push people back to what they can type.
   */
  it('separates a password that starts with a walk from one that contains it', () => {
    expect(isWeakPassword('administrator1')).toBe(true);
    expect(isWeakPassword('zR4-administrator')).toBe(false);
  });

  it('treats a two-character alternation as neither run nor repetition', () => {
    expect(isWeakPassword('ababababababa')).toBe(false);
  });

  /** One character is a repetition of itself; two are a run only if they are adjacent. */
  it.each(['a', 'ab', 'ba'])(
    'refuses %s, which is one character or an adjacent pair',
    (password) => {
      expect(isWeakPassword(password)).toBe(true);
    },
  );

  it('accepts a two-character password that is neither', () => {
    expect(isWeakPassword('az')).toBe(false);
  });
});

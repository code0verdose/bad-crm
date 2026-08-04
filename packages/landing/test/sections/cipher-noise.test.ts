import { describe, expect, it } from 'vitest';

import { cipherNoise } from '@/sections/e2ee/cipher-noise.util.js';

/**
 * The section claims two things about what the server would store, and both are properties of this
 * function rather than of the copy: the output says nothing about the input, and it is longer than
 * the input by a fixed envelope.
 */
describe('the ciphertext stand-in behaves like ciphertext', () => {
  it('is empty for empty input — nothing typed, nothing stored', () => {
    expect(cipherNoise('')).toBe('');
  });

  it('never contains the plaintext', () => {
    expect(cipherNoise('hunter2')).not.toContain('hunter2');
  });

  it('changes completely when one character changes', () => {
    const before = cipherNoise('correct horse');
    const after = cipherNoise('correct horsf');

    const shared = [...before].filter((character, index) => after[index] === character).length;

    expect(before).not.toBe(after);
    // Two independent streams over a 64-character alphabet agree on about 1 in 64 positions;
    // a quarter is far above that and far below the "one character differs" of a broken avalanche.
    expect(shared).toBeLessThan(before.length / 4);
  });

  it('grows with the plaintext by exactly one character each', () => {
    expect(cipherNoise('bb').length - cipherNoise('a').length).toBe(1);
  });

  it('is stable for the same input', () => {
    expect(cipherNoise('same')).toBe(cipherNoise('same'));
  });

  it('counts code points, so an emoji is one unit and not two', () => {
    expect(cipherNoise('🔑').length).toBe(cipherNoise('x').length);
  });
});

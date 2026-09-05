import { describe, expect, it } from 'vitest';

import { AuthLib } from '@units/auth';

/**
 * The advisory meter behind the new-password field.
 *
 * It is asserted here rather than through the screen because what it is, is arithmetic: four inputs
 * and four answers, and the screen can only ever show two of them without a case per level. What the
 * screen suite states instead is the property no unit test can — that the answer reaches a person as
 * a sentence rather than as a colour.
 *
 * The cases below are chosen to pin the **judgement**, not the formula: each one is a password
 * somebody would actually type, and each is here because getting it the other way round would be a
 * defect worth catching.
 */
describe('how a password reads', () => {
  /**
   * Below the policy it does not matter what else is true: the form refuses it anyway, and a meter
   * that said «good» about a password the submit button will reject would be the screen arguing with
   * itself.
   */
  it.each([
    ['empty', ''],
    ['short, and varied in every way it can be', 'A1b!C2d'],
    ['one character below the minimum', 'Tr0ubadour-'],
  ])('calls a password %s weak', (_case, value) => {
    expect(AuthLib.passwordStrength(value)).toBe('weak');
  });

  /**
   * Length made of one repeated character is not length.
   *
   * Twelve `a` passes the policy — the server would accept it — and every length-based rule would
   * rate it as comfortably as a real password of the same size. It is the first thing a dictionary
   * tries.
   */
  it('calls a long password of almost no distinct characters weak', () => {
    expect(AuthLib.passwordStrength('aaaaaaaaaaaa')).toBe('weak');
    expect(AuthLib.passwordStrength('abababababababab')).toBe('weak');
  });

  /** Exactly the policy, one class, nothing else to say for it. */
  it('calls a bare twelve-character word fair', () => {
    expect(AuthLib.passwordStrength('lighthouses')).toBe('weak');
    expect(AuthLib.passwordStrength('lighthousess')).toBe('fair');
  });

  it('calls a middling password good', () => {
    expect(AuthLib.passwordStrength('Lighthouses1')).toBe('good');
  });

  /**
   * A lowercase passphrase rates above a short password with punctuation in it, and that is the
   * whole point of the arithmetic.
   *
   * The other way round is what composition rules produce — `Passw0rd!` scoring well — and it is why
   * this meter counts length twice and variety once.
   */
  it('rates a plain passphrase above a decorated short password', () => {
    expect(AuthLib.passwordStrength('correct horse battery')).toBe('strong');
    expect(AuthLib.passwordStrength('Passw0rd!23!')).toBe('good');
  });

  it('calls a long, varied password strong', () => {
    expect(AuthLib.passwordStrength('Tr0ubadour-Weaving-Lantern')).toBe('strong');
  });

  /**
   * CONTROL: the four levels are all reachable. A function that answered `weak` for everything would
   * satisfy several of the cases above on its own.
   */
  it('CONTROL: reaches every level it declares', () => {
    const reached = new Set(
      ['', 'lighthousess', 'Lighthouses1', 'Tr0ubadour-Weaving-Lantern'].map(
        AuthLib.passwordStrength,
      ),
    );

    expect([...reached].sort()).toEqual(['fair', 'good', 'strong', 'weak']);
  });
});

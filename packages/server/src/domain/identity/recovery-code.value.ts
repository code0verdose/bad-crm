/**
 * The shape of one recovery code, and the alphabet it is drawn from.
 *
 * Pure by construction — no CSPRNG here, no argon2id, no I/O of any kind (`rules/hexagonal-backend.mdc`,
 * rule 2). Drawing the characters is infrastructure's job (`infrastructure/crypto/csprng-recovery-code-generator.adapter.ts`)
 * precisely because it needs a real source of randomness; what belongs in `domain` is the *shape* a
 * code has to have, which is a fact about the format and not about any particular value.
 *
 * **The alphabet excludes the five characters people confuse when copying a code by hand**: `0`/`O`,
 * `1`/`I`/`L` — the pair STORY-013-02 names explicitly, widened to the full set every character of a
 * generated code could be mistaken for once it is normalized to upper case
 * (`normalizeRecoveryCode` below). `L` is excluded alongside `I` for the identical reason: a person
 * copying a code by hand types the digit `1` for either, and — unlike `l` and `1`, which are already
 * distinct the moment the input is upper-cased — `L` and `1` stay visually close in many monospace
 * fonts even in upper case. The result is 31 symbols, comfortably above the 26 a base32-style alphabet
 * would give and nowhere near needing the full 36 of alphanumeric — losing five characters does not
 * meaningfully weaken ten-character codes drawn from a CSPRNG (see `RECOVERY_CODE_ENTROPY_BITS` below).
 */
export const RECOVERY_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Characters per code. Ten, per STORY-013-02, acceptance 1 — long enough to resist guessing under
 *  the rate limit that guards `POST /auth/2fa/verify` (STORY-013-03), short enough to type from a
 *  printed sheet without a typo on every third attempt. */
export const RECOVERY_CODE_LENGTH = 10;

/** How many codes one enrolment or regeneration issues. */
export const RECOVERY_CODE_COUNT = 10;

/**
 * log2(31^10) ≈ 49.4 bits per code — the number that justifies "long enough": at the rate limit of
 * five attempts per fifteen minutes (`rate-limit-policy.constant.ts`, `mfa_recovery_consume_attempt`),
 * exhausting the space by guessing is not a threat this century. It is *not* meant to be compared
 * against a TOTP secret's entropy — the two protect different failure modes, and a recovery code is
 * shown once and stored hashed, never transmitted again.
 */
export const RECOVERY_CODE_ENTROPY_BITS = Math.log2(
  RECOVERY_CODE_ALPHABET.length ** RECOVERY_CODE_LENGTH,
);

const RECOVERY_CODE_ALPHABET_SET: ReadonlySet<string> = new Set(RECOVERY_CODE_ALPHABET.split(''));

/**
 * Upper-cases and strips everything that is not part of the alphabet — dashes, spaces, the copy of a
 * code that came back from a `.txt` download with a trailing newline.
 *
 * Deliberately does **not** attempt to correct a confusable character (map a typed `0` to `O`, a
 * typed `1` to `L`): those characters do not appear in a genuine code by construction, so a value
 * containing one is either mistyped in a way normalization cannot safely guess, or is not one of this
 * account's codes at all — and guessing wrong would turn a wrong code into a *different* wrong code
 * silently. The person is asked to retype it instead.
 */
export const normalizeRecoveryCode = (input: string): string =>
  input
    .trim()
    .toUpperCase()
    .split('')
    .filter((char) => RECOVERY_CODE_ALPHABET_SET.has(char))
    .join('');

/** Whether `input`, once normalized, has the shape a code this system issued would have. */
export const isWellFormedRecoveryCode = (input: string): boolean => {
  const normalized = normalizeRecoveryCode(input);

  return (
    normalized.length === RECOVERY_CODE_LENGTH &&
    [...normalized].every((char) => RECOVERY_CODE_ALPHABET_SET.has(char))
  );
};

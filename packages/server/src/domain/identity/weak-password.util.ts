/**
 * The half of the password policy a length check cannot express.
 *
 * `packages/shared/src/validation/password.schema.ts` states the bounds — twelve characters to a
 * hundred and twenty-eight — and says in its own comment that strength scoring belongs next to the
 * use-case, because that is where it can also be rate-limited. This is that half, kept deliberately
 * small: a full `zxcvbn` and a top-100k list are a dependency and a data file, and both belong to
 * the same decision an operator makes about password policy rather than to the sign-up path of M1.
 *
 * What is refused here is what twelve characters still lets through: a keyboard walk lengthened
 * until it fits, one character repeated, and a plain ascending run. Every rule below is a *shape*,
 * not a dictionary entry, so the check stays a pure function over the input with nothing to load.
 */

/**
 * The seeds of the walks people actually lengthen. Matched as a prefix after folding case and
 * stripping the digits and punctuation that get appended to reach a length limit — `Passw0rd!!!!!`
 * and `qwertyuiop123` are the same choice as `password` and `qwerty`.
 */
const KEYBOARD_WALKS = [
  'qwerty',
  'qwertz',
  'azerty',
  'asdfgh',
  'zxcvbn',
  'password',
  'passwort',
  'letmein',
  'welcome',
  'iloveyou',
  'admin',
  'administrator',
  'changeme',
  'secret',
  'monkey',
  'dragon',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'trustno',
  'starwars',
  'whatever',
  'freedom',
  'abcdef',
  'badcrm',
] as const;

/** `p@ssw0rd` → `password`: the substitutions that are decoration rather than entropy. */
const LEETSPEAK: Readonly<Record<string, string>> = Object.freeze({
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
  '!': 'i',
});

const fold = (password: string): string =>
  password
    .toLowerCase()
    .split('')
    .map((character) => LEETSPEAK[character] ?? character)
    .join('');

/** Every character the same — `aaaaaaaaaaaa` passes a length check and nothing else. */
const isSingleCharacter = (password: string): boolean =>
  password.length > 0 && new Set(password).size === 1;

/** `abcdefghijkl`, `123456789012`, and the same runs backwards. */
const isSequentialRun = (password: string): boolean => {
  const codes = [...password.toLowerCase()].map((character) => character.charCodeAt(0));
  const step = (codes[1] ?? 0) - (codes[0] ?? 0);

  if (step !== 1 && step !== -1) return false;

  return codes.every((code, index) => index === 0 || code - (codes[index - 1] ?? 0) === step);
};

/**
 * Whether the password is one of the shapes above.
 *
 * The caller reports it as `422 validation_failed` on the `password` field — the same answer as a
 * password that is too short, because from the person's point of view it is the same problem and a
 * distinct code would tell an attacker which of their guesses was "nearly" acceptable.
 */
export const isWeakPassword = (password: string): boolean => {
  const trimmed = password.trim();

  if (trimmed === '') return true;

  // Repetition and runs are judged on the characters as typed, *before* the leetspeak fold: the
  // fold rewrites digits into letters, which is exactly what turns `123456789012` — a run — into a
  // string that is no longer one. The fold exists to see through decoration in a word, and a digit
  // run is not decorated.
  if (isSingleCharacter(trimmed)) return true;
  if (isSequentialRun(trimmed)) return true;

  // Digits only. Twelve characters of them is a search space of 10^12, which is hours on one GPU
  // against argon2id at these parameters and minutes against a leaked list — and it is also the
  // shape a date of birth, a phone number and `123456789012` all have.
  if (/^\d+$/.test(trimmed)) return true;

  // The walk has to *start* the password. A walk buried in the middle of a longer phrase does not
  // make the phrase guessable, and refusing it would reject passwords a manager generated.
  const stripped = fold(trimmed).replace(/[^a-z]+$/, '');

  return KEYBOARD_WALKS.some((walk) => stripped.startsWith(walk));
};

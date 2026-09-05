import { SharedValidation } from '@bad-crm/shared';

import { type PasswordStrength } from '@units/auth/model';

/**
 * The four character classes, in the order nobody should read anything into: what is counted is how
 * many of them appear, never which.
 *
 * A rule that demanded, say, a digit is the rule that produces `Password1!` — the shape every
 * cracking dictionary starts with — and it is precisely the rule this product does not have on the
 * server. Variety is one input among three here, and the smallest.
 */
const CHARACTER_CLASSES = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^\p{L}\p{N}]/u] as const;

/** Below this many distinct characters, length is padding: `aaaaaaaaaaaa` is twelve of nothing. */
const MIN_DISTINCT_CHARACTERS = 5;

/** Where length starts to matter more than anything else a meter can see without a dictionary. */
const COMFORTABLE_LENGTH = 16;
const GENEROUS_LENGTH = 20;

/**
 * How a password reads, for the advisory meter beside the field.
 *
 * **What this deliberately is not.** It is not `zxcvbn`: that is a 400 kB dictionary, it would be
 * downloaded by every visitor to reach one field, and — the deciding half — the server would not
 * agree with it. `packages/shared/src/validation/password.schema.ts` says strength scoring «belongs
 * to the auth epic and lives next to the use-case that can also rate-limit it»; no such use-case
 * exists, so a client that scored strictly would refuse passwords the server accepts, on the one
 * screen somebody visits *because* they are worried about their account.
 *
 * So the arithmetic is deliberately coarse and honest about what it can see — length, spread of
 * characters, and whether the length is real:
 *
 *   * shorter than the policy is `weak`, because the form will refuse it anyway;
 *   * fewer than five distinct characters is `weak` however long it is;
 *   * otherwise a point each for sixteen characters, for twenty, for two character classes and for
 *     three — which is what makes a lowercase passphrase rate well and `Passw0rd!23!` rate badly,
 *     the right way round.
 *
 * Pure and total: every string has an answer, including the empty one, and the component decides
 * whether to show it.
 */
export const passwordStrength = (value: string): PasswordStrength => {
  if (value.length < SharedValidation.PASSWORD_MIN_LENGTH) return 'weak';
  if (new Set(value).size < MIN_DISTINCT_CHARACTERS) return 'weak';

  const variety = CHARACTER_CLASSES.filter((pattern) => pattern.test(value)).length;
  const points =
    (value.length >= COMFORTABLE_LENGTH ? 1 : 0) +
    (value.length >= GENEROUS_LENGTH ? 1 : 0) +
    (variety >= 2 ? 1 : 0) +
    (variety >= 3 ? 1 : 0);

  if (points >= 3) return 'strong';
  if (points === 2) return 'good';

  return 'fair';
};

import { type SharedValidation } from '@bad-crm/shared';

import { numberFormatter } from './intl-cache.util.js';

const MICROS_PER_UNIT = 1_000_000n;
const MICRO_DIGITS = 6;

/**
 * `123_450_000n` → `"123.450000"`, exactly.
 *
 * Deliberately **not** `moneyToMajorUnits`, which divides through `Number` and says so in its own
 * comment: it is a presentation helper that goes lossy on large amounts, and this is the one place
 * where the amount is about to be shown to somebody who will add it up. The string keeps every
 * micro; `Intl.NumberFormat` accepts a numeric string and rounds it to the currency's own digits, so
 * nothing here has to know that JPY has none and USD has two.
 */
const toDecimalString = (amountMicros: bigint): `${number}` => {
  const negative = amountMicros < 0n;
  const magnitude = negative ? -amountMicros : amountMicros;
  const units = magnitude / MICROS_PER_UNIT;
  const fraction = (magnitude % MICROS_PER_UNIT).toString().padStart(MICRO_DIGITS, '0');

  // Asserted, and sound by construction: an optional minus, digits from a `bigint`, one dot, and
  // six digits of padded remainder. `Intl.NumberFormat.format` types its string overload as
  // `` `${number}` `` (ES2023), and TypeScript cannot infer that shape through a template.
  return `${negative ? '-' : ''}${units.toString()}.${fraction}` as `${number}`;
};

/**
 * An amount in the reader's locale, in **its own** currency.
 *
 * The currency comes from the data — a contract, an invoice, a rate — and never from the language
 * (`rules/i18n.mdc` §12): a Russian interface showing an American contract shows dollars, and a
 * formatter that inferred the currency from the locale would quietly restate the amount.
 */
export const formatMoney = (money: SharedValidation.Money, locale: string): string =>
  numberFormatter(locale, { style: 'currency', currency: money.currency }).format(
    toDecimalString(money.amountMicros),
  );

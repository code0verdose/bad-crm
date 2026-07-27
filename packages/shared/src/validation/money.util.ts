import { MICROS_PER_UNIT, currencyCodeSchema, type Money } from './money.schema.js';

/** Largest rounding error still attributable to IEEE-754, rather than to a real sub-micro amount. */
const FLOAT_TOLERANCE = 1e-6;

/**
 * Builds a `Money` from an amount in major units (`19.99 EUR`).
 *
 * Rejects anything that is not representable in whole micro-units instead of rounding it: silent
 * rounding of money is how a ledger stops adding up, and the caller always has a better answer
 * than "close enough".
 */
export const moneyFromMajorUnits = (amount: number, currency: string): Money => {
  if (!Number.isFinite(amount)) {
    throw new RangeError(`Money amount must be finite, received ${String(amount)}`);
  }

  const scaled = amount * Number(MICROS_PER_UNIT);
  const rounded = Math.round(scaled);

  if (Math.abs(scaled - rounded) > FLOAT_TOLERANCE) {
    throw new RangeError(
      `Money amount ${amount} is not representable in whole micro-units (1 unit = 1_000_000 micros)`,
    );
  }

  return { amountMicros: BigInt(rounded), currency: currencyCodeSchema.parse(currency) };
};

/**
 * Converts back to major units for display. Lossy for astronomically large amounts, which is why
 * it is a presentation helper and never the storage format.
 */
export const moneyToMajorUnits = (money: Money): number =>
  Number(money.amountMicros) / Number(MICROS_PER_UNIT);

/**
 * Adds two amounts of the same currency. Mixing currencies throws rather than picking one: an
 * implicit conversion would need an FX rate, and the rate has to be pinned to a date by the
 * invoice that uses it (data-model.md, «Деньги»).
 */
export const addMoney = (left: Money, right: Money): Money => {
  if (left.currency !== right.currency) {
    throw new TypeError(`Cannot add different currencies: ${left.currency} and ${right.currency}`);
  }

  return { amountMicros: left.amountMicros + right.amountMicros, currency: left.currency };
};

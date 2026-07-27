import { z } from 'zod';

/** `1 USD = 1_000_000` micro-units (data-model.md, «Деньги»). */
export const MICROS_PER_UNIT = 1_000_000n;

/** ISO-4217 alphabetic code. Normalised to upper case before it is checked. */
export const currencyCodeSchema = z
  .string({ error: 'validation.currency.invalid' })
  .trim()
  .toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, { error: 'validation.currency.invalid' }));

export type CurrencyCode = z.infer<typeof currencyCodeSchema>;

/**
 * A monetary amount: integer micro-units plus a currency, and never one without the other.
 *
 * `bigint` is the type, not `number`: it cannot hold a fraction at all, so "0.1 + 0.2" style
 * rounding drift is impossible by construction rather than by convention. An amount without a
 * currency is a modelling error, which is why `currency` is required rather than defaulted.
 */
export const moneySchema = z.object({
  amountMicros: z.bigint({ error: 'validation.money.invalid_amount' }),
  currency: currencyCodeSchema,
});

export type Money = z.infer<typeof moneySchema>;

/**
 * Wire form of the same value: JSON has no `bigint`, so micro-units travel as a decimal string.
 * The regex rejects `"19.99"` — a fraction here means the producer used major units and the amount
 * would be off by six orders of magnitude.
 */
export const moneyWireSchema = z.object({
  amountMicros: z
    .string({ error: 'validation.money.invalid_amount' })
    .regex(/^-?\d+$/, { error: 'validation.money.invalid_amount' })
    .transform((value) => BigInt(value)),
  currency: currencyCodeSchema,
});

export type MoneyWire = z.input<typeof moneyWireSchema>;

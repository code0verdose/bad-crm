import { describe, expect, it } from 'vitest';

import {
  cursorPageSchema,
  emailSchema,
  isoDateSchema,
  isoDateTimeSchema,
  localeSchema,
  moneySchema,
  moneyWireSchema,
  offsetPageSchema,
  passwordSchema,
  slugSchema,
  sortOrderSchema,
  sortSchema,
  timeZoneSchema,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  MICROS_PER_UNIT,
  moneyFromMajorUnits,
  moneyToMajorUnits,
  addMoney,
} from '../../src/validation/index.js';

describe('emailSchema', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(emailSchema.parse('  User@Example.COM ')).toBe('user@example.com');
  });

  it.each(['plain', 'no@tld', '@example.com', 'a b@example.com', ''])('rejects %o', (value) => {
    expect(emailSchema.safeParse(value).success).toBe(false);
  });

  it('reports an i18n key rather than a ready-made sentence', () => {
    const result = emailSchema.safeParse('nope');

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toMatch(/^validation\./);
  });
});

describe('passwordSchema', () => {
  it('accepts a password at the documented minimum length', () => {
    expect(passwordSchema.safeParse('a'.repeat(12)).success).toBe(true);
  });

  it.each([
    ['too short', 'a'.repeat(11)],
    ['too long', 'a'.repeat(129)],
    ['empty', ''],
  ])('rejects a %s password', (_case, value) => {
    expect(passwordSchema.safeParse(value).success).toBe(false);
  });

  it('does not trim: a password is a byte sequence, not a display string', () => {
    expect(passwordSchema.parse('  spaced pass  ')).toBe('  spaced pass  ');
  });
});

describe('slugSchema', () => {
  it.each(['bad-crm', 'a', 'team-42', 'a-b-c'])('accepts %o', (value) => {
    expect(slugSchema.safeParse(value).success).toBe(true);
  });

  it.each(['-leading', 'trailing-', 'double--dash', 'with space', 'спец', 'under_score', ''])(
    'rejects %o',
    (value) => {
      expect(slugSchema.safeParse(value).success).toBe(false);
    },
  );

  it('lower-cases and trims before validating: case is not a different slug', () => {
    expect(slugSchema.parse(' Bad-CRM ')).toBe('bad-crm');
  });
});

describe('pagination', () => {
  it('defaults the offset page to page 1 and the documented page size', () => {
    expect(offsetPageSchema.parse({})).toEqual({ page: 1, perPage: DEFAULT_PAGE_SIZE });
  });

  it('coerces query-string values, because a URL carries only strings', () => {
    expect(offsetPageSchema.parse({ page: '3', perPage: '25' })).toEqual({ page: 3, perPage: 25 });
  });

  it.each([
    ['page below one', { page: '0' }],
    ['fractional page', { page: '1.5' }],
    ['page size above the cap', { perPage: String(MAX_PAGE_SIZE + 1) }],
    ['non-numeric page', { page: 'first' }],
  ])('rejects a %s', (_case, value) => {
    expect(offsetPageSchema.safeParse(value).success).toBe(false);
  });

  it('defaults the cursor page to no cursor and the documented limit', () => {
    expect(cursorPageSchema.parse({})).toEqual({ cursor: undefined, limit: DEFAULT_PAGE_SIZE });
  });

  it('keeps the cursor opaque: any non-empty string is accepted as-is', () => {
    expect(cursorPageSchema.parse({ cursor: 'eyJpZCI6MX0', limit: '10' })).toEqual({
      cursor: 'eyJpZCI6MX0',
      limit: 10,
    });
  });

  it('rejects an empty cursor, which would silently mean "from the start"', () => {
    expect(cursorPageSchema.safeParse({ cursor: '' }).success).toBe(false);
  });
});

describe('sorting', () => {
  it('defaults to ascending order', () => {
    expect(sortOrderSchema.parse(undefined)).toBe('asc');
  });

  it.each(['asc', 'desc'])('accepts %o', (value) => {
    expect(sortOrderSchema.safeParse(value).success).toBe(true);
  });

  it('rejects an order outside the whitelist', () => {
    expect(sortOrderSchema.safeParse('ASC').success).toBe(false);
  });

  it('builds a sort schema closed over the sortable fields of one list', () => {
    const schema = sortSchema(['createdAt', 'title']);

    expect(schema.parse({ sortBy: 'title', sortOrder: 'desc' })).toEqual({
      sortBy: 'title',
      sortOrder: 'desc',
    });
    expect(schema.safeParse({ sortBy: 'passwordHash' }).success).toBe(false);
  });
});

describe('dates', () => {
  it('accepts a calendar date and an instant', () => {
    expect(isoDateSchema.parse('2026-07-27')).toBe('2026-07-27');
    expect(isoDateTimeSchema.parse('2026-07-27T10:15:30.000Z')).toBe('2026-07-27T10:15:30.000Z');
  });

  it.each(['27.07.2026', '2026-13-01', '2026-07-27T10:15:30.000Z'])(
    'rejects %o as a calendar date',
    (value) => {
      expect(isoDateSchema.safeParse(value).success).toBe(false);
    },
  );

  it('rejects a timestamp without a timezone: an instant must be unambiguous', () => {
    expect(isoDateTimeSchema.safeParse('2026-07-27T10:15:30').success).toBe(false);
  });
});

describe('money', () => {
  it('stores integer micro-units next to a currency (data-model.md, «Деньги»)', () => {
    expect(MICROS_PER_UNIT).toBe(1_000_000n);
    expect(moneySchema.parse({ amountMicros: 1_500_000n, currency: 'usd' })).toEqual({
      amountMicros: 1_500_000n,
      currency: 'USD',
    });
  });

  it('rejects a fractional amount: money is never a float', () => {
    expect(moneySchema.safeParse({ amountMicros: 1.5, currency: 'USD' }).success).toBe(false);
    expect(() => moneyFromMajorUnits(1.000_000_5, 'USD')).toThrow(/micro/i);
  });

  /**
   * `NaN * 1_000_000` is `NaN`, and `Math.round(NaN)` is `NaN`, so `Math.abs(NaN - NaN) > 1e-6` is
   * `false` — without the finiteness guard the function would fall through to `BigInt(NaN)` and
   * throw a `RangeError` naming neither the amount nor the currency. `Infinity` reaches the same
   * dead end. The guard exists so the failure names the input; this test is what keeps it.
   */
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite amount %o with a message that names it',
    (amount) => {
      expect(() => moneyFromMajorUnits(amount, 'USD')).toThrow(RangeError);
      expect(() => moneyFromMajorUnits(amount, 'USD')).toThrow(/finite/i);
    },
  );

  it('rejects an amount without a currency and an invalid currency code', () => {
    expect(moneySchema.safeParse({ amountMicros: 1n }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMicros: 1n, currency: 'DOLLAR' }).success).toBe(false);
    expect(moneySchema.safeParse({ amountMicros: 1n, currency: '12' }).success).toBe(false);
  });

  it('converts between major units and micro-units without losing precision', () => {
    expect(moneyFromMajorUnits(19.99, 'EUR')).toEqual({
      amountMicros: 19_990_000n,
      currency: 'EUR',
    });
    expect(moneyToMajorUnits({ amountMicros: 19_990_000n, currency: 'EUR' })).toBe(19.99);
  });

  it('refuses to add amounts in different currencies', () => {
    const usd = moneyFromMajorUnits(1, 'USD');

    expect(addMoney(usd, usd)).toEqual({ amountMicros: 2_000_000n, currency: 'USD' });
    expect(() => addMoney(usd, moneyFromMajorUnits(1, 'EUR'))).toThrow(/currenc/i);
  });

  it('parses the wire form, where micro-units travel as a decimal string', () => {
    expect(moneyWireSchema.parse({ amountMicros: '19990000', currency: 'EUR' })).toEqual({
      amountMicros: 19_990_000n,
      currency: 'EUR',
    });
    expect(moneyWireSchema.safeParse({ amountMicros: '19.99', currency: 'EUR' }).success).toBe(
      false,
    );
  });
});

describe('locale and timezone', () => {
  it.each(['en', 'ru'])('accepts the supported locale %o', (value) => {
    expect(localeSchema.safeParse(value).success).toBe(true);
  });

  it('rejects an unsupported locale', () => {
    expect(localeSchema.safeParse('de').success).toBe(false);
  });

  it.each(['UTC', 'Europe/Belgrade', 'America/New_York'])('accepts the IANA zone %o', (value) => {
    expect(timeZoneSchema.safeParse(value).success).toBe(true);
  });

  it.each(['Mars/Olympus', 'GMT+3', '', 'europe/belgrade '])('rejects %o', (value) => {
    expect(timeZoneSchema.safeParse(value).success).toBe(false);
  });
});

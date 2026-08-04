/**
 * Everything the interface shows as a date, an amount, a count or a length of time.
 *
 * Each case asserts **both** languages, because a formatter that is right in one is not a formatter
 * that works — it is the English one with a Russian label. The differences are the assertions: the
 * decimal comma, the currency after the number rather than before it, «и» instead of a serial
 * comma, a first day of week that is not Sunday.
 *
 * The exact strings are pinned deliberately, ICU data and all. They are what a person reads, and a
 * test asserting «contains a 7» would pass on `7/26/2026` rendered to a Russian reader.
 */
import { describe, expect, it, vi } from 'vitest';

import { SharedValidation } from '@bad-crm/shared';

import { SharedLib } from '@shared';

const MOMENT = '2026-07-26T10:00:00Z';

describe('dates', () => {
  it.each([
    ['en', 'Jul 26, 2026'],
    ['ru', '26 июл. 2026 г.'],
  ])('formats a date for %s', (locale, expected) => {
    expect(SharedLib.formatDate(MOMENT, locale, 'UTC')).toBe(expected);
  });

  /**
   * The half of «store in UTC, show in the reader's zone» that can actually be wrong. Moscow is
   * three hours ahead, so 10:00 UTC is 13:00 there — and a deadline shown in the wrong zone is a
   * deadline missed by exactly that many hours.
   */
  it('renders the same instant in the zone it is asked for', () => {
    expect(SharedLib.formatDateTime(MOMENT, 'ru', 'UTC')).toContain('10:00');
    expect(SharedLib.formatDateTime(MOMENT, 'ru', 'Europe/Moscow')).toContain('13:00');
  });

  /** Anything two people in different places have to agree on says which clock it means. */
  it('spells out the zone when the context is cross-timezone', () => {
    const withZone = SharedLib.formatDateTimeWithZone(MOMENT, 'en', 'Europe/Moscow');

    expect(withZone).toContain('01:00 PM');
    expect(withZone).toMatch(/GMT\+3/);
  });
});

describe('the reader’s time zone', () => {
  it('prefers the profile setting over the browser', () => {
    expect(SharedLib.resolveTimeZone('Asia/Yekaterinburg')).toBe('Asia/Yekaterinburg');
  });

  it.each([
    ['no profile', undefined],
    ['an empty profile value', ''],
  ])('falls back to the browser when there is %s', (_case, profile) => {
    expect(SharedLib.resolveTimeZone(profile)).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
  });

  /**
   * The last resort, and the reason it is not a throw: `resolvedOptions().timeZone` is *typed* as a
   * string and is required to be one, but a runtime built without full ICU answers with nothing.
   * Rendering a deadline in UTC and saying so beats rendering an exception. Simulated here, because
   * a branch nobody can reach is a branch nobody can trust.
   */
  it('falls back to UTC on a runtime that cannot name a zone', () => {
    const real = Intl.DateTimeFormat;
    vi.stubGlobal(
      'Intl',
      Object.assign(Object.create(Intl), {
        DateTimeFormat: () => ({ resolvedOptions: () => ({ timeZone: undefined }) }),
      }),
    );

    try {
      expect(SharedLib.resolveTimeZone()).toBe('UTC');
    } finally {
      vi.unstubAllGlobals();
      expect(Intl.DateTimeFormat).toBe(real);
    }
  });

  /**
   * Read from a table rather than from `Intl.Locale.prototype.getWeekInfo`, which this runtime does
   * not have — measured, not assumed. A timesheet built on the missing method would lay out
   * correctly in a browser and throw here.
   */
  it('starts the week on Monday in Russian and on Sunday in English', () => {
    expect(SharedLib.FIRST_DAY_OF_WEEK).toEqual({ en: 7, ru: 1 });
  });
});

describe('money', () => {
  const usd = SharedValidation.moneyFromMajorUnits(123.45, 'USD');

  it.each([
    ['en', '$123.45'],
    ['ru', '123,45 $'],
  ])('formats an amount for %s', (locale, expected) => {
    // Normalised: Russian puts a no-break space before the symbol, and an assertion written with a
    // plain space fails on a character nobody can see in the diff.
    expect(SharedLib.formatMoney(usd, locale).replaceAll('\u00a0', ' ')).toBe(expected);
  });

  /**
   * The currency belongs to the contract, not to the reader. A Russian interface showing an American
   * invoice shows dollars; a formatter that took the currency from the locale would restate the
   * amount as a different sum of money.
   */
  it('keeps the currency of the data, whatever the language is', () => {
    const rub = SharedValidation.moneyFromMajorUnits(1000, 'RUB');

    expect(SharedLib.formatMoney(rub, 'en')).toContain('RUB');
    expect(SharedLib.formatMoney(rub, 'ru')).toContain('₽');
  });

  /** A currency with no minor unit at all: the formatter must not invent two decimals for it. */
  it('respects a currency that has no fractional part', () => {
    expect(SharedLib.formatMoney(SharedValidation.moneyFromMajorUnits(1234, 'JPY'), 'en')).toBe(
      '¥1,234',
    );
  });

  it('formats a negative amount', () => {
    expect(SharedLib.formatMoney(SharedValidation.moneyFromMajorUnits(-42.5, 'USD'), 'en')).toBe(
      '-$42.50',
    );
  });

  /**
   * The reason the amount travels to `Intl` as a string. `Number(9_007_199_254_740_993_550_000n)`
   * is already past the safe integer range; dividing it by a million gives an amount that is wrong
   * before it is ever formatted.
   */
  it('formats an amount larger than a double can hold, exactly', () => {
    expect(
      SharedLib.formatMoney(
        { amountMicros: 9_007_199_254_740_993_550_000n, currency: 'USD' },
        'en',
      ),
    ).toBe('$9,007,199,254,740,993.55');
  });
});

describe('numbers', () => {
  it.each([
    ['en', '1,234,567'],
    ['ru', '1 234 567'],
  ])('groups thousands the way %s does', (locale, expected) => {
    // Russian uses a narrow no-break space; comparing to a plain space would fail for the right
    // reason and read as a bug in the formatter.
    expect(SharedLib.formatNumber(1_234_567, locale).replaceAll(' ', ' ')).toBe(expected);
  });
});

describe('lists', () => {
  it.each([
    ['en', 'Ada, Boris, and Vera'],
    ['ru', 'Ada, Boris и Vera'],
  ])('joins names the way %s does', (locale, expected) => {
    expect(SharedLib.formatList(['Ada', 'Boris', 'Vera'], locale)).toBe(expected);
  });

  it('CONTROL: says a single name without any conjunction', () => {
    expect(SharedLib.formatList(['Ada'], 'ru')).toBe('Ada');
  });
});

describe('durations', () => {
  it.each([
    [450, '7:30'],
    [60, '1:00'],
    [5, '0:05'],
    [0, '0:00'],
  ])('renders %i minutes as %s', (minutes, expected) => {
    expect(SharedLib.formatDurationClock(minutes)).toBe(expected);
  });

  it('splits the number so the words around it come from the catalogue', () => {
    expect(SharedLib.durationParts(450)).toEqual({ hours: 7, minutes: 30 });
  });
});

describe('relative time', () => {
  const now = new Date('2026-07-26T10:00:00Z');

  it.each([
    ['en', '5 minutes ago'],
    ['ru', '5 минут назад'],
  ])('says how long ago in %s', (locale, expected) => {
    expect(SharedLib.formatRelativeTime('2026-07-26T09:55:00Z', now, locale)).toBe(expected);
  });

  /** `numeric: 'auto'` is the whole reason to use this API rather than subtracting two dates. */
  it('says «yesterday» rather than «1 day ago»', () => {
    expect(SharedLib.formatRelativeTime('2026-07-25T10:00:00Z', now, 'ru')).toBe('вчера');
  });

  it('handles the future as well as the past', () => {
    expect(SharedLib.formatRelativeTime('2026-07-26T12:00:00Z', now, 'en')).toBe('in 2 hours');
  });

  it.each([
    ['a year', '2025-07-26T10:00:00Z', 'last year'],
    ['a month', '2026-06-20T10:00:00Z', 'last month'],
    ['a week', '2026-07-18T10:00:00Z', 'last week'],
  ])('picks the coarsest unit that still describes %s', (_case, iso, expected) => {
    expect(SharedLib.formatRelativeTime(iso, now, 'en')).toBe(expected);
  });

  /** Below a minute the coarse units all miss, and the fallback is what answers. */
  it('falls back to seconds for a distance smaller than a minute', () => {
    expect(SharedLib.formatRelativeTime('2026-07-26T09:59:30Z', now, 'en')).toBe('30 seconds ago');
  });

  /**
   * Under a second every threshold misses, including the last one, and the `??` is what stops the
   * destructuring from throwing on `undefined`. Reachable — a timestamp written a moment ago is
   * exactly this case — so it is asserted rather than assumed.
   */
  it('says «now» for a distance smaller than a second', () => {
    expect(SharedLib.formatRelativeTime('2026-07-26T09:59:59.800Z', now, 'en')).toBe('now');
  });
});

/**
 * The cache is an optimisation, and an optimisation that changes an answer is a bug. Two calls with
 * the same arguments must agree, and a different argument must not be served the previous formatter.
 */
describe('the formatter cache', () => {
  it('gives the same answer twice', () => {
    expect(SharedLib.formatDate(MOMENT, 'ru', 'UTC')).toBe(
      SharedLib.formatDate(MOMENT, 'ru', 'UTC'),
    );
  });

  it('does not serve one locale the formatter of another', () => {
    expect(SharedLib.formatDate(MOMENT, 'en', 'UTC')).not.toBe(
      SharedLib.formatDate(MOMENT, 'ru', 'UTC'),
    );
  });
});

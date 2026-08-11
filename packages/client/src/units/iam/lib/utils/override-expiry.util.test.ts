import { describe, expect, it } from 'vitest';

import { calendarDayIn, calendarDayOf, expiryInstantOf } from './override-expiry.util.js';

/**
 * The two conversions between the day somebody picks and the instant the contract stores.
 *
 * Both are one line, and both are the kind of one line that is wrong on one day of the month: a
 * hand-built `${year}-${month}-${day}` is off by one on the month and unpadded on the ninth, and
 * `new Date('2027-01-01T00:00:00')` is *local* where `new Date('2027-01-01')` is UTC. The cases
 * below are the boundaries where those mistakes show.
 */
describe('the expiry of an exception', () => {
  it('reads a day off an instant, zero-padded', () => {
    // The ninth of a single-digit month — where an unpadded template produces `2026-9-9`.
    expect(calendarDayOf(new Date('2026-09-09T15:04:05.000Z'))).toBe('2026-09-09');
  });

  it('takes the day in UTC, not in whatever zone the reader is in', () => {
    // Late enough that a reader west of Greenwich is still on the previous day.
    expect(calendarDayOf(new Date('2026-09-09T23:30:00.000Z'))).toBe('2026-09-09');
  });

  it('offers thirty days out as the default of an ALLOW', () => {
    expect(calendarDayIn(30, new Date('2026-08-10T09:00:00.000Z'))).toBe('2026-09-09');
  });

  it('crosses a month and a leap day without arithmetic of its own', () => {
    expect(calendarDayIn(30, new Date('2028-02-01T00:00:00.000Z'))).toBe('2028-03-02');
  });

  it('turns the day into the start of that day, UTC, with the zone spelled out', () => {
    // The assertion that would fail if the `Z` were dropped: without it the string is parsed as
    // local time and the instant moves by the reader's offset.
    expect(expiryInstantOf('2027-01-01')).toBe('2027-01-01T00:00:00.000Z');
  });

  it('round-trips: the day picked is the day stored', () => {
    expect(calendarDayOf(new Date(expiryInstantOf('2026-12-31')))).toBe('2026-12-31');
  });
});

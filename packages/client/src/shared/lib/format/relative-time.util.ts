import { relativeTimeFormatter } from './intl-cache.util.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Largest unit that still describes the distance, from the coarsest down.
 *
 * Ordered coarsest-first so the first match wins: three months ago is «3 months ago», not «13 weeks
 * ago» and certainly not «7 862 400 seconds ago». The thresholds are approximations by design —
 * `Intl.RelativeTimeFormat` phrases a number of units, and «about» is what a relative time means.
 */
const UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', YEAR],
  ['month', MONTH],
  ['week', WEEK],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
  ['second', SECOND],
];

/**
 * `2026-07-26T09:55:00Z` an hour later → «5 минут назад» / «5 minutes ago».
 *
 * `numeric: 'auto'` so that yesterday is «вчера» rather than «1 день назад» — the whole reason to
 * reach for this API instead of subtracting two dates.
 *
 * `now` is a parameter rather than `Date.now()` inside, because a formatter that reads the clock
 * cannot be tested for the boundary between «59 seconds» and «a minute», which is the only part of
 * it that can be wrong.
 */
export const formatRelativeTime = (iso: string, now: Date, locale: string): string => {
  const difference = new Date(iso).getTime() - now.getTime();
  const magnitude = Math.abs(difference);

  const [unit, span] = UNITS.find(([, size]) => magnitude >= size) ?? (['second', SECOND] as const);

  return relativeTimeFormatter(locale, { numeric: 'auto' }).format(
    Math.round(difference / span),
    unit,
  );
};

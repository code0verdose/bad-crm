import { z } from 'zod';

/**
 * `UTC`, or an IANA `Area/Location` name. Fixed-offset spellings (`GMT+3`, `UTC+03:00`) are
 * rejected on purpose: an offset is not a timezone — it does not know about daylight saving, so a
 * timesheet stored against one silently shifts by an hour twice a year.
 */
const IANA_NAME = /^(UTC|[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * Second gate: ask the runtime whether it actually knows the zone. Both runtimes ship `Intl`, so
 * this stays isomorphic, and it is the only check that keeps the whitelist from going stale as the
 * IANA database changes.
 */
const isKnownTimeZone = (value: string): boolean => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

export const timeZoneSchema = z
  .string({ error: 'validation.timezone.invalid' })
  .regex(IANA_NAME, { error: 'validation.timezone.invalid' })
  .refine(isKnownTimeZone, { error: 'validation.timezone.invalid' });

export type TimeZone = z.infer<typeof timeZoneSchema>;

/** Fallback for a subject with no timezone: UTC is wrong for everybody and surprising to nobody. */
export const DEFAULT_TIME_ZONE: TimeZone = 'UTC';

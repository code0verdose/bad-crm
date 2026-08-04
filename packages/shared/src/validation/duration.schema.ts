import { z } from 'zod';

/** A working day nobody types by accident; anything longer is a typo or a stuck timer. */
export const DURATION_MAX_MINUTES = 24 * 60;

/**
 * The three ways a person writes a length of time, and the one way the system stores it.
 *
 * Storage is **whole minutes** — `TimeEntry.durationMinutes` in `data-model.md`. Input is whatever
 * somebody types into a timesheet cell, and there are exactly three habits worth accepting:
 *
 * - `7:30` — a clock reading, the habit of anybody who has used a timesheet before;
 * - `7.5` — a decimal of hours, the habit of anybody who has used a spreadsheet;
 * - `450m` / `7h` / `7h30m` — an explicit unit, the habit of anybody who has used a CLI.
 *
 * Rejecting two of the three is how a field acquires a reputation for «not taking what I typed»,
 * and the cost of accepting them is one regular expression.
 *
 * A bare number is deliberately **hours**, not minutes: `8` in a timesheet means a day, and the
 * reading that makes `8` mean eight minutes would make the common case the surprising one.
 */
const CLOCK = /^(\d{1,2}):([0-5]\d)$/;
const DECIMAL_HOURS = /^(\d{1,2})(?:[.,](\d{1,2}))?$/;
const UNITS = /^(?:(\d{1,3})\s*h)?\s*(?:(\d{1,4})\s*m)?$/i;

/** `undefined` for anything the three habits above do not cover. */
export const parseDurationMinutes = (input: string): number | undefined => {
  const value = input.trim().toLowerCase();

  if (value === '') return undefined;

  const clock = CLOCK.exec(value);
  if (clock?.[1] !== undefined && clock[2] !== undefined) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }

  const decimal = DECIMAL_HOURS.exec(value);
  if (decimal?.[1] !== undefined) {
    const fraction = decimal[2] ?? '';
    const hours = Number(`${decimal[1]}.${fraction === '' ? '0' : fraction}`);

    // Rounded rather than truncated: `7.51` hours is 450.6 minutes, and a timesheet that silently
    // drops the remainder loses time every single day it is filled in.
    return Math.round(hours * 60);
  }

  const units = UNITS.exec(value);
  if (units !== null && (units[1] !== undefined || units[2] !== undefined)) {
    return Number(units[1] ?? 0) * 60 + Number(units[2] ?? 0);
  }

  return undefined;
};

/**
 * The schema a form uses. Refusal and the reason are separate: `invalid_format` for something that
 * is not a duration at all, `too_big` for one that is.
 */
export const durationMinutesSchema = z
  .string()
  .transform((input, ctx) => {
    const minutes = parseDurationMinutes(input);

    if (minutes === undefined) {
      // `message`, not `error`: `addIssue` takes a raw issue, where the field is `message`.
      // The `{ error }` shorthand belongs to the checks (`.min`, `.max`), and passing it here
      // silently produced Zod's own «Invalid input» — caught by the test that names the key.
      ctx.addIssue({ code: 'custom', message: 'validation.duration.invalid' });
      return z.NEVER;
    }

    return minutes;
  })
  .refine((minutes) => minutes > 0, { error: 'validation.duration.zero' })
  .refine((minutes) => minutes <= DURATION_MAX_MINUTES, { error: 'validation.duration.tooLong' });

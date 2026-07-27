import { z } from 'zod';

/**
 * Calendar date without a time — `2026-07-27`. Used where a day is the unit itself (a timesheet
 * day, an invoice date), and where attaching a time would silently make the value depend on the
 * reader's timezone.
 */
export const isoDateSchema = z.iso.date({ error: 'validation.date.invalid' });
export type IsoDate = z.infer<typeof isoDateSchema>;

/**
 * Instant in time — `2026-07-27T10:15:30.000Z`.
 *
 * A timezone is required: a timestamp without one is not an instant, it is a wish. The database
 * side of the same rule is `timestamptz` everywhere (data-model.md, «Принципы»).
 */
export const isoDateTimeSchema = z.iso.datetime({ error: 'validation.datetime.invalid' });
export type IsoDateTime = z.infer<typeof isoDateTimeSchema>;

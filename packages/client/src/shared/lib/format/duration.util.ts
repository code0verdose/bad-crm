const MINUTES_PER_HOUR = 60;

export interface DurationParts {
  readonly hours: number;
  readonly minutes: number;
}

/** `450` → `{ hours: 7, minutes: 30 }`, so the words around the numbers come from the catalogue. */
export const durationParts = (totalMinutes: number): DurationParts => ({
  hours: Math.floor(totalMinutes / MINUTES_PER_HOUR),
  minutes: totalMinutes % MINUTES_PER_HOUR,
});

/**
 * `450` → `7:30`. The compact form, for a table column where a row is one entry.
 *
 * Not built through `Intl`: there is no locale in which a timesheet cell reads «7 hours 30 minutes»,
 * and `Intl.DurationFormat` is newer than the runtime this repository pins. The colon form is the
 * same in both languages, which is why this one function has no locale parameter — the *worded*
 * form does, and it lives in the catalogue as `common.duration.hoursMinutes`.
 */
export const formatDurationClock = (totalMinutes: number): string => {
  const { hours, minutes } = durationParts(totalMinutes);

  return `${hours.toString()}:${minutes.toString().padStart(2, '0')}`;
};

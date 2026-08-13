const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;

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

/**
 * `247` → `4:07`. The same compact form one unit down, for a countdown rather than a timesheet.
 *
 * Built rather than translated, for the reason above: `4:07` is `4:07` in both languages, and the
 * sentence around it — «this step expires in …» — is the part that lives in the catalogue
 * (`rules/i18n.mdc` §14). Its caller is the second-factor step of the sign-in, which has five
 * minutes to spend and has to say how many are left.
 */
export const formatSecondsClock = (totalSeconds: number): string => {
  const minutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;

  return `${minutes.toString()}:${seconds.toString().padStart(2, '0')}`;
};

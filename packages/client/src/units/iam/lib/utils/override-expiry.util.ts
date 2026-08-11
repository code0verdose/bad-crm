/**
 * The two translations between what an administrator picks and what the contract carries.
 *
 * `PermissionOverride.expiresAt` is an instant (`date-time`); the form asks for a **day**, because
 * «this delegation ends on the 30th» is the sentence people actually mean and an hour-and-minute
 * field would be four more decisions nobody has an opinion about. The pair below is where that
 * gap is bridged, once, instead of in the component that submits.
 *
 * **The day is read and written in UTC**, and the exception therefore stops applying at midnight
 * UTC of the chosen day rather than at midnight where the administrator is sitting. Stated in the
 * label the person reads, not hidden: a time zone the interface guesses is worse than one it names.
 * The alternative — the browser's zone — would make the same URL mean a different instant for two
 * administrators of one organization, which is precisely the ambiguity an audit trail cannot carry.
 */

/** Milliseconds in a day. Named, because `86_400_000` in an expression explains nothing. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `YYYY-MM-DD`, the format `<input type="date">` reads and writes.
 *
 * `toISOString().slice(0, 10)` rather than a hand-rolled template: the parts have to be zero-padded
 * and the month is zero-based, and both are mistakes that only show up on one day of the month.
 */
export const calendarDayOf = (instant: Date): string => instant.toISOString().slice(0, 10);

/** The default an ALLOW starts with: `days` from now, as a day. */
export const calendarDayIn = (days: number, from: Date): string =>
  calendarDayOf(new Date(from.getTime() + days * DAY_MS));

/**
 * The day as the instant the contract wants — the start of that day, UTC.
 *
 * `Z` is written explicitly: `new Date('2027-01-01')` is already UTC by the specification, while
 * `new Date('2027-01-01T00:00:00')` is *local*, and the two differ by hours. Spelling the zone
 * removes the difference between the two readings rather than relying on which one this string
 * happens to trigger.
 */
export const expiryInstantOf = (calendarDay: string): string =>
  new Date(`${calendarDay}T00:00:00.000Z`).toISOString();

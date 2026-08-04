/**
 * The three habits a timesheet has to accept, and the ones it has to refuse.
 *
 * Refusing two of the three is how a field earns a reputation for «not taking what I typed», and the
 * cost of accepting them is one regular expression — so the accepted forms are asserted one by one
 * rather than sampled. The refusals matter just as much: a parser that accepts everything turns a
 * typo into a working day of recorded time.
 */
import { describe, expect, it } from 'vitest';

import { SharedValidation } from '../../src/index.js';

describe('parseDurationMinutes', () => {
  it.each([
    ['a clock reading', '7:30', 450],
    ['a clock reading with no minutes', '8:00', 480],
    ['a clock reading under an hour', '0:45', 45],
    ['decimal hours', '7.5', 450],
    ['decimal hours with a comma, as a Russian keyboard produces', '7,5', 450],
    ['a bare number, meaning hours', '8', 480],
    ['explicit minutes', '450m', 450],
    ['explicit hours', '7h', 420],
    ['both units', '7h30m', 450],
    ['both units with a space', '7h 30m', 450],
    ['upper case units', '7H30M', 450],
    ['surrounding whitespace', '  7:30  ', 450],
  ])('reads %s', (_case, input, expected) => {
    expect(SharedValidation.parseDurationMinutes(input)).toBe(expected);
  });

  /**
   * `7.51` hours is 450.6 minutes. Truncating loses six-tenths of a minute every time somebody
   * types a decimal — small once, and a missing hour a month across a team.
   */
  it('rounds a decimal that does not land on a whole minute', () => {
    expect(SharedValidation.parseDurationMinutes('7.51')).toBe(451);
  });

  it.each([
    ['an empty string', ''],
    ['whitespace only', '   '],
    ['words', 'seven hours'],
    ['sixty minutes on the clock, which is an hour', '7:60'],
    ['a negative value', '-1:00'],
    ['a stray unit', '7x'],
    ['two colons', '7:30:15'],
  ])('refuses %s', (_case, input) => {
    expect(SharedValidation.parseDurationMinutes(input)).toBeUndefined();
  });
});

describe('durationMinutesSchema', () => {
  it('parses an accepted form to whole minutes', () => {
    expect(SharedValidation.durationMinutesSchema.parse('7:30')).toBe(450);
  });

  it.each([
    ['something that is not a duration', 'later', 'validation.duration.invalid'],
    ['nothing at all', '0:00', 'validation.duration.zero'],
    ['more than a day', '25:00', 'validation.duration.tooLong'],
  ])('refuses %s with a translatable reason', (_case, input, message) => {
    const result = SharedValidation.durationMinutesSchema.safeParse(input);

    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(message);
  });

  it('CONTROL: accepts exactly a full day', () => {
    expect(SharedValidation.durationMinutesSchema.parse('24:00')).toBe(1440);
  });
});

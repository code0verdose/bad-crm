import { z } from 'zod';

/**
 * The profile form, as the person or the administrator fills it in.
 *
 * The bounds are the server's, restated so the field turns red before a request is made rather than
 * after: 0…80 hours is a `CHECK` in the database and a Zod bound in the request validator, and this
 * is the third statement of the same rule — the one the person actually sees.
 *
 * **Empty strings become `null`.** A cleared «Job title» field is a job title that was removed, and
 * an empty string in the column would be a different value that renders identically — the sort of
 * difference that shows up years later in a report.
 */
/**
 * Exported because the field's hint says the same range in words, and a hint that disagrees with
 * the check is the defect this file has just been cleared of in its messages.
 */
export const CAPACITY_MIN = 0;
export const CAPACITY_MAX = 80;
const MAX_SKILLS = 50;
const MAX_SKILL_LENGTH = 64;
const MAX_NAME = 120;
/** Job title and department share a bound because they are the same kind of short free text. */
const MAX_POSITION_TEXT = 160;
const MAX_TIMEZONE = 64;
const MAX_EMERGENCY_CONTACT = 500;

/**
 * Every bound names the sentence that reports it, and none of them repeats its own number.
 *
 * A bound with no `error` falls back to Zod's own English — «Too big: expected string to have <=120
 * characters» — and `@mantine/form` renders it verbatim, so a Russian interface refuses in English
 * and no gate sees it: the suite runs in `cimode`, where an untranslated string and a translated one
 * are indistinguishable. The keys below are read by `SharedLib.zodFormResolver`, which hands the
 * sentence the `maximum` the check itself carried — the number lives here and only here.
 */
const TEXT_TOO_LONG_KEY = 'validation.text.tooLong';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, { error: TEXT_TOO_LONG_KEY })
    .transform((value) => (value === '' ? null : value));

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * The label of each contract type, as a literal map.
 *
 * Not `t(\`employee.employmentType.${type}\`)`: a key built at runtime is invisible to
 * `test/i18n/catalogue-parity.test.ts`, which reads the source for keys and reports anything it
 * cannot find as an entry nobody asks for. The gate is right to — a key it cannot see is a key that
 * can be deleted without anything failing until somebody opens the screen.
 */
export const EMPLOYMENT_TYPE_LABEL: Readonly<Record<EmploymentType, string>> = {
  FULL_TIME: 'employee.employmentType.FULL_TIME',
  PART_TIME: 'employee.employmentType.PART_TIME',
  CONTRACTOR: 'employee.employmentType.CONTRACTOR',
  INTERN: 'employee.employmentType.INTERN',
};

export const employeeProfileFormSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .max(MAX_NAME, { error: TEXT_TOO_LONG_KEY }),
  lastName: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .max(MAX_NAME, { error: TEXT_TOO_LONG_KEY }),
  jobTitle: optionalText(MAX_POSITION_TEXT),
  department: optionalText(MAX_POSITION_TEXT),
  /**
   * Keyed although the control is a `NativeSelect` and cannot offer anything else: the value can
   * also arrive from the stored document, and a contract type retired from this list would then
   * refuse the whole form in English.
   */
  employmentType: z.enum(EMPLOYMENT_TYPES, { error: 'validation.choice.invalid' }),
  /**
   * Typed as text, sent as a number. A text field is what the form has — the numeric widget costs
   * `Combobox` in the bundle — so the coercion belongs here, where «what is typed» and «what is
   * sent» are already two different things.
   */
  weeklyCapacityHours: z.coerce
    .number({ error: 'validation.number.invalid' })
    .int({ error: 'validation.number.notInteger' })
    .min(CAPACITY_MIN, { error: 'employee.field.capacityTooSmall' })
    .max(CAPACITY_MAX, { error: 'employee.field.capacityTooLarge' }),
  timezone: z
    .string()
    .trim()
    .min(1, { error: 'validation.required' })
    .max(MAX_TIMEZONE, { error: TEXT_TOO_LONG_KEY }),
  /** Comma-separated in the field, an array on the wire — the split belongs to the form. */
  skills: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((skill) => skill.trim())
        .filter((skill) => skill !== ''),
    )
    .pipe(
      z
        .array(z.string())
        .max(MAX_SKILLS, { error: 'employee.field.tooManySkills' })
        /**
         * The length of one entry is checked over the whole list rather than per element, and that
         * is not a shortcut. An element issue arrives with the path `skills.3`, and the form has no
         * such field — Mantine would look for a control by that name, find none, and the refusal
         * would be shown to nobody while the submit stayed blocked. One input, one message.
         *
         * `params` carries the bound because a `refine` has none of its own; the resolver reads it
         * exactly as it reads `maximum`, so the number still lives only here.
         */
        .refine((skills) => skills.every((skill) => skill.length <= MAX_SKILL_LENGTH), {
          error: 'employee.field.skillTooLong',
          params: { count: MAX_SKILL_LENGTH },
        }),
    ),
  emergencyContact: optionalText(MAX_EMERGENCY_CONTACT),
});

export type EmployeeProfileFormValues = z.input<typeof employeeProfileFormSchema>;
export type EmployeeProfilePayload = z.output<typeof employeeProfileFormSchema>;

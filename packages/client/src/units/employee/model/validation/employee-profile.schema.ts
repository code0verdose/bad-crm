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
const CAPACITY_MIN = 0;
const CAPACITY_MAX = 80;
const MAX_SKILLS = 50;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
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
  firstName: z.string().trim().min(1, { error: 'validation.required' }).max(120),
  lastName: z.string().trim().min(1, { error: 'validation.required' }).max(120),
  jobTitle: optionalText(160),
  department: optionalText(160),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  /**
   * Typed as text, sent as a number. A text field is what the form has — the numeric widget costs
   * `Combobox` in the bundle — so the coercion belongs here, where «what is typed» and «what is
   * sent» are already two different things.
   */
  weeklyCapacityHours: z.coerce
    .number({ error: 'validation.number.invalid' })
    .int()
    .min(CAPACITY_MIN)
    .max(CAPACITY_MAX),
  timezone: z.string().trim().min(1).max(64),
  /** Comma-separated in the field, an array on the wire — the split belongs to the form. */
  skills: z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((skill) => skill.trim())
        .filter((skill) => skill !== ''),
    )
    .pipe(z.array(z.string().max(64)).max(MAX_SKILLS)),
  emergencyContact: optionalText(500),
});

export type EmployeeProfileFormValues = z.input<typeof employeeProfileFormSchema>;
export type EmployeeProfilePayload = z.output<typeof employeeProfileFormSchema>;

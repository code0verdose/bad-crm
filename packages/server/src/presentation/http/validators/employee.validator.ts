import { userIdSchema } from '@bad-crm/shared/validation';
import { z } from 'zod';

/**
 * The request schemas of the employee-profile surface.
 *
 * `strictObject`, like every other body in this API: a client that ships `weeklyCapacity` against an
 * operation reading `weeklyCapacityHours` is refused rather than silently ignored — the alternative
 * is a form that reports success and saves nothing.
 *
 * **Every field is optional and `.nullable()` where the column is**, because this is a PATCH: absent
 * means «leave it», `null` means «clear it», and folding the two together would make clearing a job
 * title impossible to express.
 *
 * There is no `locale` here. The language belongs to the **account** (`users.locale`), not to the
 * personnel record: it decides what the interface and the mail are written in, and it is set at
 * registration and when the invitation is accepted. Accepting it on this body would mean either a
 * write to a second table from an operation named after the first, or a field that is quietly
 * dropped — and the second is the failure this project keeps refusing to ship.
 */

export const userIdParamsSchema = z.strictObject({ userId: userIdSchema });

/** Hours a week. The same 0…80 the database enforces — one bound, stated twice on purpose. */
const CAPACITY_MIN = 0;
const CAPACITY_MAX = 80;
/** How many skills one person may list. Beyond this it is a CV, not a search facet. */
const MAX_SKILLS = 50;

const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'CONTRACTOR', 'INTERN'] as const;

/** A calendar day: nobody is hired at 14:32, and an instant would be off by one for half the planet. */
const dateOnlySchema = z.iso.date({ error: 'validation.date.invalid' });

export const employeeProfileBodySchema = z.strictObject({
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  jobTitle: z.string().trim().max(160).nullish(),
  department: z.string().trim().max(160).nullish(),
  /** `null` clears the manager; a self-reference is refused by the database and by the policy. */
  managerId: userIdSchema.nullish(),
  weeklyCapacityHours: z.number().int().min(CAPACITY_MIN).max(CAPACITY_MAX).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  hiredAt: dateOnlySchema.nullish(),
  terminatedAt: dateOnlySchema.nullish(),
  timezone: z.string().trim().min(1).max(64).optional(),
  skills: z.array(z.string().trim().min(1).max(64)).max(MAX_SKILLS).optional(),
  /**
   * Free text, and the one field of this body that is encrypted at rest. Bounded generously — «сестра
   * Ольга, +7 900 000-00-00» is the shape, not a document.
   */
  emergencyContact: z.string().trim().max(500).nullish(),
});

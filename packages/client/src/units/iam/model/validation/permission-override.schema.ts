import { z } from 'zod';

/**
 * What an administrator has to type before one person differs from their role.
 *
 * The two rules are the whole point of the form, and neither is politeness:
 *
 *   * **a reason of at least ten characters after trimming.** The database enforces it too
 *     (`permission-model.md` §«Слой 3»), and six months later this sentence is the only thing that
 *     explains why this person is not like their colleagues. Ten is the contract's number, restated
 *     here so the person is told while they are still typing rather than by a 422;
 *   * **an expiry, or an explicit decision not to have one.** An exception without an end is a
 *     permanent role nobody named, and «until somebody removes it» has to be chosen rather than
 *     defaulted into. The checkbox starts unticked and the date starts thirty days out, so the
 *     cheap path is the reversible one.
 *
 * The messages are i18n **keys** rather than sentences, the way every schema in this tree writes
 * them (`rules/i18n.mdc` §5). What the neighbouring forms then do — spread `form.getInputProps`
 * straight into a Mantine input — renders that key verbatim, so the form component in this unit
 * translates it before it reaches the field. See `permission-override-form.component.tsx`.
 */

/** `docs/api/openapi.yaml` → `PermissionOverride.reason`, and the `ck_` constraint behind it. */
export const REASON_MIN_LENGTH = 10;

/** Long enough for a sentence explaining a delegation, short enough to stay a note. */
export const REASON_MAX_LENGTH = 500;

/** What an ALLOW is worth by default: a month, after which somebody looks at it again. */
export const DEFAULT_ALLOW_DAYS = 30;

export const REASON_TOO_SHORT_KEY = 'permissions.field.reasonTooShort';
export const REASON_TOO_LONG_KEY = 'permissions.field.reasonTooLong';
export const EXPIRY_REQUIRED_KEY = 'permissions.field.expiryRequired';
export const EXPIRY_IN_PAST_KEY = 'permissions.field.expiryInPast';

/** `YYYY-MM-DD`, which is what an `<input type="date">` holds and hands back. */
const CALENDAR_DAY = /^\d{4}-\d{2}-\d{2}$/;

export const permissionOverrideFormSchema = z
  .object({
    reason: z
      .string()
      .trim()
      .min(REASON_MIN_LENGTH, { error: REASON_TOO_SHORT_KEY })
      .max(REASON_MAX_LENGTH, { error: REASON_TOO_LONG_KEY }),
    /**
     * «Until somebody removes it». Ticking this is what makes the date field irrelevant, and it is
     * the only way to get there — an empty date is a mistake, not a choice.
     */
    neverExpires: z.boolean(),
    /** Empty while `neverExpires` is set; otherwise the day the exception stops applying. */
    expiresOn: z.string(),
  })
  .refine((values) => values.neverExpires || CALENDAR_DAY.test(values.expiresOn), {
    error: EXPIRY_REQUIRED_KEY,
    // Attached to the field rather than to the object, so `@mantine/form` renders it under the
    // input it is about and `aria-describedby` has something to point at (`rules/a11y.mdc` §18).
    path: ['expiresOn'],
  })
  .refine(
    (values) =>
      values.neverExpires ||
      !CALENDAR_DAY.test(values.expiresOn) ||
      // Compared as a calendar day against a calendar day, never as an instant: `new Date()` in a
      // browser west of Greenwich is already «yesterday» in UTC, and comparing the two would refuse
      // a date the person can see on their own calendar. `toISOString().slice(0, 10)` is the same
      // projection the date input itself uses.
      values.expiresOn > new Date().toISOString().slice(0, 10),
    { error: EXPIRY_IN_PAST_KEY, path: ['expiresOn'] },
  );

export type PermissionOverrideFormValues = z.infer<typeof permissionOverrideFormSchema>;

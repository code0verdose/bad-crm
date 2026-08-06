import { SharedPermissions } from '@bad-crm/shared';
import { z } from 'zod';

/**
 * The state of the matrix screen, as the URL carries it (`rules/lists-and-filters.mdc` §1).
 *
 * Everything a person can adjust while reading the matrix lives here rather than in component
 * state, so the view survives a reload, works with the back button and can be sent to a colleague —
 * «look at what `manager` may do with invoices» is a link, not a description of six clicks.
 *
 * The optional fields carry **defaults** rather than being absent: the screen then reads one shape
 * instead of «a value or the thing I would have done anyway», and the `?? []` that would appear in
 * three components is a branch nobody can see going wrong.
 *
 * Every one of them falls back with `.catch` rather than `.default`, and the difference is the whole
 * behaviour of a hand-edited URL. A default fills in an **absent** value; a present one that means
 * nothing — `?diff=no`, a domain that no longer exists, a search string somebody pasted an essay
 * into — fails validation, and a failed `validateSearch` replaces the screen with the error
 * boundary. With `replace: true` on every filter change that broken address also stays in the bar,
 * so a reload does not help. Falling back is the only behaviour that treats a mistyped query string
 * as what it is.
 *
 * The **draft** deliberately does not: a screenful of unsaved toggles in the address bar would be
 * shared as if it were the truth, and restored by a back button that the person meant as «undo».
 */
export const rolesSearchSchema = z.object({
  /** Substring the rows are filtered by — matched against the key, not the translated label. */
  q: z.string().trim().max(64).catch(''),
  /**
   * Domains left collapsed. Absent means every group is open, which is the honest default for a
   * screen whose job is to show what a role may do.
   */
  collapsed: z
    .array(z.enum(SharedPermissions.PERMISSION_DOMAINS))
    .max(SharedPermissions.PERMISSION_DOMAINS.length)
    .catch([]),
  /**
   * Show only the permissions the roles disagree about — the fastest way to read a matrix.
   *
   * Not `z.coerce.boolean()`: that answers `true` to every non-empty string, so a hand-written
   * `?diff=no` would turn the filter **on** — the opposite of what it says. The two spellings a URL
   * can carry are named, and anything else falls back to the default.
   */
  diff: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((value) => value === true || value === 'true')
    .catch(false),
});

export type RolesSearch = z.infer<typeof rolesSearchSchema>;

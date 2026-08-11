import { z } from 'zod';

/**
 * The state of the permissions tab on a personnel card, as the URL carries it
 * (`rules/lists-and-filters.mdc` §1, `rules/frontend-fsd.mdc` rule 16).
 *
 * All three parameters belong to this unit even though the route is the employee card, and that is
 * the honest placement rather than a convenience: `tab` exists **because** this tab exists — the
 * card had one face until STORY-011-11 — and `q`/`exceptions` narrow a catalogue of permissions.
 * A copy in `units/employee` would be a schema that knows about a screen it does not own.
 *
 * Every field falls back with `.catch` instead of throwing, for the reason the roles matrix states
 * next door: these values come out of the address bar — a link in a chat, a stale bookmark, a
 * hand-edited query string — and a failed `validateSearch` replaces the screen with an error
 * boundary. Since the filters are written with `replace: true`, that broken address also stays in
 * the bar, so a reload does not help either.
 */

/**
 * The faces of the card. `profile` is the default and the fallback, because it is the one every
 * person may open on themselves — including the person whose card it is, who has no business
 * reading their own exceptions here (`permission-model.md` §7(ж), decision 2: «своё не исключение»).
 *
 * A literal union rather than `z.string()`: the value picks a `Tabs.Panel`, and an unknown one
 * would render a card with no body at all.
 */
export const EMPLOYEE_CARD_TABS = ['profile', 'roles'] as const;

export type EmployeeCardTab = (typeof EMPLOYEE_CARD_TABS)[number];

/** Long enough for the longest key in the catalogue, short enough not to be an essay. */
export const PERMISSION_SEARCH_MAX_LENGTH = 64;

/**
 * Every field carries `.catch(…).default(…)`, and the pair is not redundant: `catch` handles a
 * value that is **present and wrong**, `default` a value that is **absent**. Without the second
 * one the parsed shape would make all three fields required of every caller — and `Link to=
 * "/admin/members/$userId"` in the directory, which has no opinion about tabs, would stop
 * compiling. That is exactly what happened when this schema was first written with `catch` alone.
 */
export const userPermissionsSearchSchema = z.object({
  tab: z.enum(EMPLOYEE_CARD_TABS).catch('profile').default('profile'),
  /**
   * Substring the rows are filtered by, matched against the **key** rather than the translated
   * label — the same choice the roles matrix makes, and for the same reason: `task:update` is what
   * an administrator has in front of them in an audit entry, and it does not change with the
   * interface language.
   */
  q: z.string().trim().max(PERMISSION_SEARCH_MAX_LENGTH).catch('').default(''),
  /**
   * Show only the keys carrying a personal exception — the review question this screen exists for
   * («what is this person allowed to do that their role does not say»).
   *
   * Not `z.coerce.boolean()`: that answers `true` for every non-empty string, so `?exceptions=no`
   * would switch the filter **on**. The two spellings a URL can carry are named, and anything else
   * falls back.
   */
  exceptions: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((value) => value === true || value === 'true')
    .catch(false)
    .default(false),
});

export type UserPermissionsSearch = z.infer<typeof userPermissionsSearchSchema>;

import { z } from 'zod';

import { MFA_GATES } from '@units/organization/model/enums/mfa-gate.enums.js';

/**
 * The state of `/admin/organization`, as the URL carries it (`rules/lists-and-filters.mdc` §1).
 *
 * Which tab is open and how the coverage report is narrowed both live here rather than in component
 * state, so «вот кто у нас без второго фактора» is a link: it survives a reload, works with the back
 * button and can be sent to a colleague.
 *
 * **Every field falls back with `.catch` rather than `.default`.** A default fills in an *absent*
 * value; a present one that means nothing — a gate that is not a gate, a tab that does not exist —
 * fails validation, and a failed `validateSearch` replaces the screen with the error boundary. Every
 * write here is `replace: true`, so that broken address also stays in the bar and a reload does not
 * help. The server does the opposite and answers 422, because there an unknown value means a client
 * sent something it should not have.
 *
 * **What is deliberately not here is the policy draft.** The roles somebody is considering and the
 * grace period they are typing are an unsaved form, not a view of the organization: a link that
 * carried them would show a colleague a policy nobody had agreed to as though it were in force. The
 * draft lives in the editor hook and reaches the server only as the preview's query parameters.
 */

/**
 * The tabs that exist.
 *
 * `ux-architecture.md` plans five — `general`, `branding`, `locale`, `security`, `storage` — and
 * this list grows as each arrives with its panel. A name in the enum with nothing to render is a
 * link that leads to an empty screen, which is worse than a link that is not offered yet.
 */
export const ORGANIZATION_TABS = ['security'] as const;

export type OrganizationTab = (typeof ORGANIZATION_TABS)[number];

/** Long enough for a full name plus an address. */
const MAX_QUERY = 64;

/** As many as the policy itself may name (`MFA_POLICY_ROLES_MAX`) — a filter cannot exceed its subject. */
const MAX_ROLE_FILTERS = 64;

export const organizationSettingsSearchSchema = z.object({
  tab: z.enum(ORGANIZATION_TABS).catch('security'),
  /** The typed phrase, matched against the address on the report the screen already holds. */
  q: z.string().trim().max(MAX_QUERY).catch(''),
  /** Role references as the report spells them — a system role key, or the id of a custom role. */
  role: z.array(z.string().max(64)).max(MAX_ROLE_FILTERS).catch([]),
  gate: z.array(z.enum(MFA_GATES)).max(MFA_GATES.length).catch([]),
});

export type OrganizationSettingsSearch = z.infer<typeof organizationSettingsSearchSchema>;

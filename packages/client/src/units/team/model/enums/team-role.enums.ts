/**
 * What somebody is on a team — and the answer to «where is the lead».
 *
 * There is no `leadId` on a team, and that is a decision rather than an omission: two models of the
 * same fact drift the first time one of them is written without the other, so a lead is a membership
 * whose role says so (`docs/api/openapi.yaml` → `TeamMember.teamRole`).
 *
 * The labels are **keys**, never text (`rules/i18n.mdc` §5): a label map holding «Ведущий» is a
 * string the parity gate cannot see and the English interface cannot use.
 */
export const TEAM_ROLES = ['MEMBER', 'LEAD'] as const;

export type TeamRole = (typeof TEAM_ROLES)[number];

/**
 * Written out rather than composed from the value. ADR-0019 forbids assembling a key at runtime: a
 * key built from the role cannot be found by reading the source, and the parity gate would report
 * two translated strings as zero used ones.
 */
export const TEAM_ROLE_LABEL: Readonly<Record<TeamRole, string>> = {
  MEMBER: 'teams.role.MEMBER',
  LEAD: 'teams.role.LEAD',
};

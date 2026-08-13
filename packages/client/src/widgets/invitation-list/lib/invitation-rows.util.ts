import { type EmployeeApi } from '@units/employee';
import { type IamApi, type IamService } from '@units/iam';

export interface InvitationRow {
  readonly id: string;
  readonly email: string;
  /** Resolved by the cell, and only for a reader who may be told (`team:read`). */
  readonly teamIds: readonly string[];
  /**
   * The role by name, or `undefined` when it cannot be named — no role at all, or a reader without
   * `role:read`. **Never the identifier**: a UUID in a table cell is noise a person has to ignore,
   * and it is the one thing the row does carry (STORY-012-08, D1).
   */
  readonly roleLabel: string | undefined;
  /** Who sent it, by the same rule and behind `employee:read`. */
  readonly invitedByLabel: string | undefined;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly isExpired: boolean;
}

/**
 * A person as one string, and never an empty one.
 *
 * The twin of `widgets/team-detail/lib/person-label.util.ts`, deliberately not imported from it: two
 * widgets reaching into each other's segments is a coupling neither of them wants, and the sentence
 * is three lines. The day a third screen needs it, it moves to a unit that owns people.
 */
const personLabel = (person: EmployeeApi.EmployeeListItem): string => {
  const full = `${person.firstName} ${person.lastName}`.trim();

  return full === '' ? person.email : full;
};

/**
 * The open invitations, joined with whatever the two conditional reads could say about them.
 *
 * Three callers land on the same `undefined`, and that is why the fallback is one rule here rather
 * than three conditions in the table: an invitation carrying no role at all, a reader without the
 * permission to name roles or people, and a role or person outside the answer that was fetched.
 */
export const invitationRows = (
  items: readonly IamService.IamHooks.OpenInvitation[],
  roles: readonly IamApi.RoleListEntry[],
  people: readonly EmployeeApi.EmployeeListItem[],
): readonly InvitationRow[] => {
  const roleNames = new Map(roles.map((role) => [role.id, role.name]));
  const personNames = new Map(people.map((person) => [person.userId, personLabel(person)]));

  return items.map(({ invitation, isExpired }) => ({
    id: invitation.id,
    email: invitation.email,
    teamIds: invitation.teamIds,
    roleLabel: invitation.roleId === null ? undefined : roleNames.get(invitation.roleId),
    invitedByLabel: personNames.get(invitation.invitedById),
    createdAt: invitation.createdAt,
    expiresAt: invitation.expiresAt,
    isExpired,
  }));
};

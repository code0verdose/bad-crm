import { type Actor } from '@/domain/access/actor.types.js';
import { authorizeCapability, holdsEffectively } from '@/domain/access/authorize.util.js';
import { type Decision } from '@/domain/access/decision.types.js';
import { allow, assertAllowed, deny } from '@/domain/access/decision.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/** A team as a decision needs it: which row, and whether it is still there. */
export interface TeamScope {
  readonly teamId: string;
  readonly isDeleted: boolean;
}

/** The account a membership would be written for. */
export interface TeamSubject {
  readonly userId: string;
  readonly status: 'ACTIVE' | 'SUSPENDED' | 'INVITED';
}

/**
 * Who may do what to a team.
 *
 * **All five decisions are capability-only, and that is the model rather than an omission.** Every
 * `team:*` key carries `requiredLevel: null` in the catalogue, so there is no resource level to
 * consult: a team is an org-structure container, not a group of access. The `ResourceAcl` that would
 * make one the subject of a grant — and would give these keys a level — is STORY-011-06, which is
 * blocked until a resource layer exists (`permission-model.md` §12, open question 3). Writing the
 * conjunction here today would mean a branch nothing can reach and no test can prove.
 *
 * The functions exist as named decisions rather than as `authorizeCapability(actor, 'team:update')`
 * spelled at each call site for the reason `rules/permissions.mdc`, 3 gives: the authority is the
 * use-case, and a use-case that reaches for the key directly is one refactor away from reaching for
 * a different one. They also make the day `resolveAcl` arrives a change to this file rather than to
 * six call sites.
 */
export const canReadTeams = (actor: Actor | null): Decision =>
  authorizeCapability(actor, 'team:read');

export const canCreateTeam = (actor: Actor | null): Decision =>
  authorizeCapability(actor, 'team:create');

export const canUpdateTeam = (actor: Actor | null): Decision =>
  authorizeCapability(actor, 'team:update');

export const canDeleteTeam = (actor: Actor | null): Decision =>
  authorizeCapability(actor, 'team:delete');

export const canManageTeamMembers = (actor: Actor | null): Decision =>
  authorizeCapability(actor, 'team:manage_members');

/**
 * Whether this id names a team the caller may go on to address.
 *
 * Separate from the capability above, and evaluated **after** it, so that the read costs nothing to
 * somebody who may not ask — and, more to the point, so that «you have no permission» and «that team
 * does not exist» take the same time to answer (`docs/security/permission-model.md` §5).
 *
 * `null` and «soft-deleted» are one answer. The row survives a deletion — `teams.deleted_at` is set
 * rather than the row removed, so the slug can be reused — which means the repository can still see
 * something the caller must not be told about. Anything but `resource_not_found` here would let the
 * API confirm that an id once named a team in this organization.
 */
export const teamAddressable = (team: TeamScope | null): Decision =>
  team === null || team.isDeleted ? deny('resource_not_found') : allow();

/**
 * The same decision, in the form a caller that goes on to *use* the row needs.
 *
 * An assertion signature rather than a boolean for the reason `assertAllowed` has one: after this
 * call the row is non-null for the compiler, so the shape that reads `team.name` right after
 * deciding it exists is also the shape that type-checks — and a use-case that skipped the check
 * still has a `TeamScope | null` it has to deal with.
 */
export function assertTeamAddressable<T extends TeamScope>(team: T | null): asserts team is T {
  assertAllowed(teamAddressable(team), 'team');
}

/**
 * Whether this account may be put on a team at all.
 *
 * Throws rather than returning a `Decision` for the same reason `assertTransferable` does: the
 * refusal is a **409**, and `DenyReason` has no member that answers one — a deactivated account is
 * not a permission problem. The request is well formed, both parties exist, and the fix is to
 * reactivate them first.
 *
 * The rule closes the loop offboarding opens. Deactivation deletes every `team_members` row of the
 * person (STORY-012-05), on the reasoning that membership is access rather than history; an add path
 * that accepted a `SUSPENDED` account would undo that one row at a time, and the trail would read as
 * if somebody had been re-onboarded when nobody had. `INVITED` is refused with it: an invitation
 * nobody has accepted is not yet a person, and the invitation itself already carries the teams they
 * will join.
 *
 * A missing account is **404**, not 403 — «somebody else's user» and «nobody» stay one answer.
 *
 * **The 409 itself is gated on `user:read` (the gate's L-1).** `team:manage_members` says nothing
 * about being allowed to look somebody up in the directory, and `member_not_active` is exactly a
 * directory fact — it tells a caller who took a `userId` off a team roster whether that account is
 * merely inactive or specifically suspended, for any `userId` in the organization, not only for
 * people on teams this caller administers. A holder of `team:manage_members` who does not also hold
 * `user:read` gets the same 404 a foreign account gets instead: the account's *state* stays as hidden
 * from them as the account's *name* already is everywhere else in this application. A caller who
 * does hold `user:read` sees the same 409 as before — nothing about the informative answer changes
 * for the person the grant is actually for.
 */
export const assertMemberJoinable = (actor: Actor, subject: TeamSubject | null): void => {
  if (subject === null) throw denyAccess('user', 'other_organization');

  if (subject.status !== 'ACTIVE') {
    if (!holdsEffectively(actor, 'user:read')) throw denyAccess('user', 'other_organization');

    throw new ConflictError('member_not_active', { cause: subject.status });
  }
};

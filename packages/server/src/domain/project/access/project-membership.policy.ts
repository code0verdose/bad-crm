import { type Actor } from '@/domain/access/actor.types.js';
import { holdsEffectively } from '@/domain/access/authorize.util.js';
import { assertAllowed, deny } from '@/domain/access/decision.util.js';
import { type ProjectSubject } from '@/domain/project/project.entity.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/**
 * The rules of a project roster that are neither a capability nor a level — STORY-014-02,
 * acceptance 6, 7 and 8. The capability and the level are `canManageProjectMembers` in
 * `project-access.policy.ts`; these three run after it, over facts the use-case has already read.
 *
 * Pure in the sense the layer requires: no I/O, no clock, nothing imported from outside the domain.
 */

/**
 * Nobody puts themselves on a project, names themselves its lead, or raises their own role,
 * whatever key they hold (`T-PROJ-02`).
 *
 * Three paths write a seat's level — `POST …/members`, the `leadId` of `PATCH /projects/{id}` and
 * the `projectRole` of `PATCH …/members/{userId}` — and the rule holds on all three, or a `MANAGER`
 * by an expiring ACL grant could turn the grant into a permanent `LEAD` membership through
 * whichever path forgot it (the security gate's finding on the first draft, which guarded one).
 *
 * A 403 inside the contour, not a 404: the caller holds `project:manage_members` and is on the
 * project as `MANAGER` — the refusal is about *this* pair of subject and object, and the reason
 * `self_assignment_forbidden` is the one the role-assignment policy already uses for the identical
 * shape («you may grant this, but not to yourself»). The key travels with the refusal so the denial
 * trail can file it: the request is a mutation, and §10 records those.
 */
export const assertNotSelfJoin = (actor: Actor, userId: string): void => {
  if (userId === actor.userId) {
    assertAllowed(deny('self_assignment_forbidden', 'project:manage_members'), 'project');
  }
};

/**
 * The last `LEAD` stays (acceptance 7).
 *
 * `leads` is what `ProjectMemberRepositoryPort.leads()` answered **under `FOR UPDATE`** in the
 * same transaction — the lock is the database half of this rule, and without it two concurrent
 * removals each count two leads and both proceed. A project with no lead has nobody holding
 * `MANAGER` by membership, and the way out is to appoint another lead first — a conflict with a
 * next step, not a refusal of a right, so it throws the 409 rather than returning a `Decision`
 * (`assertTransferable` and `assertMemberJoinable` make the same choice for the same reason).
 */
export const assertLastLeadKept = (leads: readonly string[], leavingUserId: string): void => {
  if (leads.length === 1 && leads[0] === leavingUserId) {
    throw new ConflictError('last_project_lead_required');
  }
};

/**
 * Whether this account may be put on a project at all (acceptance 8).
 *
 * The same rule `assertMemberJoinable` applies to teams, restated here rather than imported across
 * contexts: a policy of the project domain that reached into `domain/iam` would make the two
 * rosters share a rule by accident, and the day one of them needs a different answer the import
 * becomes a refactor of both. The reasoning is the team policy's: a missing account is **404**
 * (another organization's and nobody's are one answer); a `SUSPENDED` or `INVITED` account is a
 * **409** with a next step — reactivate them, or wait for the invitation to be accepted — and that
 * 409 is told only to a caller who also holds `user:read`, because *which* inactive state a
 * `userId` is in is a directory fact and `project:manage_members` does not buy it (the gate's L-1).
 */
export const assertProjectSubjectJoinable = (
  actor: Actor,
  subject: ProjectSubject | null,
): void => {
  if (subject === null) throw denyAccess('user', 'other_organization');

  if (subject.status !== 'ACTIVE') {
    if (!holdsEffectively(actor, 'user:read')) throw denyAccess('user', 'other_organization');

    throw new ConflictError('member_not_active', { cause: subject.status });
  }
};

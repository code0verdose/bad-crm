import {
  type AddMemberResult,
  type DisbandedTeam,
  type TeamDetail,
  type TeamDraft,
  type TeamListEntry,
  type TeamRepositoryPort,
  type TeamSummary,
} from '@/application/iam/ports/team-repository.port.js';
import { type TeamScope, type TeamSubject } from '@/domain/iam/access/team-access.policy.js';
import { TenantScopedRepository } from '@/infrastructure/persistence/prisma/tenant-scoped.repository.js';

/**
 * Teams and their membership, through Prisma, inside the scope the caller opened.
 *
 * Five details are the whole of the class.
 *
 * **The list filters deleted rows and the reads by id do not.** A list of teams that showed a
 * disbanded one would be wrong; a read addressed by id that filtered it in SQL would take the
 * decision away from the policy and leave the `resource_not_found`-for-a-disbanded-team branch
 * unreachable.
 *
 * **Disbanding is two statements and both are needed.** The team is hidden and the memberships are
 * deleted with `RETURNING`, because `deleteMany` cannot report what it removed and these rows are
 * the only record that the memberships existed — `team_members` has no `deleted_at`.
 *
 * **The version bump is one statement whatever the size of the team.** `= ANY($n)` rather than a
 * statement per person: the same reasoning as `bumpHoldersOfMany` next door.
 *
 * **`scope()` and `subject()` read under `FOR SHARE`.** Both close the same TOCTOU (the gate's M-1):
 * a plain read here and a plain `UPDATE` in `disband()` or in `PrismaUserLifecycleRepository.suspend()`
 * can interleave under `ReadCommitted` so that a write later in the *same* transaction — `addMember`
 * above all — lands on a fact the other side had already overturned. The lock is held for the rest of
 * the transaction the caller opened, not released after the `SELECT`, which is what makes it a lock on
 * the decision rather than on the row for one statement.
 *
 * **`addMember` is an upsert, not an `INSERT … DO NOTHING`.** The gate's L-3: a plain `DO NOTHING`
 * made a role change through this same endpoint a silent no-op, because promoting an existing member
 * to `LEAD` *is* a second `POST` with a different `teamRole` — there is no other endpoint for it. The
 * `SELECT … FOR UPDATE` ahead of the `INSERT` is what lets the method tell `'created'` apart from
 * `'role_changed'` apart from a genuine no-op, for the caller to audit correctly.
 */
export class PrismaTeamRepository extends TenantScopedRepository implements TeamRepositoryPort {
  protected readonly resource = 'team' as const;
  protected readonly repositoryName = 'TeamRepository';

  list(): Promise<readonly TeamListEntry[]> {
    return this.run('list', async (tx) => {
      const rows = await tx.team.findMany({
        where: { organizationId: this.organizationId('list'), deletedAt: null },
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          _count: { select: { members: true } },
        },
      });

      return rows.map((row) => ({
        teamId: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        memberCount: row._count.members,
      }));
    });
  }

  scope(teamId: string): Promise<TeamScope | null> {
    return this.run('scope', async (tx) => {
      // `FOR SHARE`, not a plain read — the gate's M-1. `disband()` two lines down takes an exclusive
      // lock on this same row with its `UPDATE`; without a lock here, this read and that write can
      // interleave under `ReadCommitted` so that `addMember`/`removeMember`, called later in the same
      // transaction on the strength of this answer, write a membership for a team a concurrent
      // request has already hidden. The share lock forces one of the two transactions to wait for the
      // other rather than let both proceed from the same stale fact, and whichever commits second
      // either sees the fresh `deleted_at` or — if it is `disband` that runs second — its own
      // unconditional `DELETE FROM team_members` removes whatever the other transaction just
      // committed. Held for the rest of *this* transaction, exactly like the ownership guard in
      // `ownership.repository.ts`'s `transfer` holds its lock through every write that follows it.
      const rows = await tx.$queryRaw<{ id: string; deleted_at: Date | null }[]>`
        SELECT id, deleted_at FROM teams
         WHERE organization_id = ${this.organizationId('scope')}::uuid
           AND id = ${teamId}::uuid
         FOR SHARE`;

      const row = rows[0];

      if (row === undefined) return null;

      return { teamId: row.id, isDeleted: row.deleted_at !== null };
    });
  }

  /**
   * `scope`'s read plus the name and slug — no `FOR SHARE`, and no `members` include. This is a
   * report for an audit `before`, not a decision a concurrent write has to be serialized against
   * (`update()`'s own `deletedAt: null` predicate is what actually guards the write), and the point of
   * splitting it out of `detail` is exactly to avoid the roster `detail` always fetches alongside it.
   */
  summary(teamId: string): Promise<TeamSummary | null> {
    return this.run('summary', async (tx) => {
      const row = await tx.team.findFirst({
        where: { organizationId: this.organizationId('summary'), id: teamId },
        select: { id: true, name: true, slug: true, deletedAt: true },
      });

      if (row === null) return null;

      return { teamId: row.id, name: row.name, slug: row.slug, isDeleted: row.deletedAt !== null };
    });
  }

  detail(teamId: string): Promise<TeamDetail | null> {
    return this.run('detail', async (tx) => {
      const row = await tx.team.findFirst({
        where: { organizationId: this.organizationId('detail'), id: teamId },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          deletedAt: true,
          members: {
            orderBy: { joinedAt: 'asc' },
            select: { userId: true, teamRole: true, joinedAt: true },
          },
        },
      });

      if (row === null) return null;

      return {
        teamId: row.id,
        name: row.name,
        slug: row.slug,
        description: row.description,
        isDeleted: row.deletedAt !== null,
        memberCount: row.members.length,
        members: row.members.map((member) => ({
          userId: member.userId,
          teamRole: member.teamRole,
          joinedAt: member.joinedAt,
        })),
      };
    });
  }

  create(draft: TeamDraft): Promise<string> {
    return this.run('create', async (tx) => {
      const team = await tx.team.create({
        data: {
          organizationId: this.organizationId('create'),
          name: draft.name,
          slug: draft.slug,
          description: draft.description,
        },
        select: { id: true },
      });

      return team.id;
    });
  }

  update(teamId: string, draft: TeamDraft): Promise<boolean> {
    return this.run('update', async (tx) => {
      // `updateMany`, not `update`: a row that is not there is an ordinary outcome of a concurrent
      // deletion, and the caller decides what to answer — `update` would raise `P2025`, which the
      // base class turns into a 404 before the caller ever sees the outcome.
      //
      // The `deletedAt: null` predicate matters as much as the id: a disbanded team must not be
      // editable, and without it a rename would resurrect a slug conflict against a live team.
      const { count } = await tx.team.updateMany({
        where: { organizationId: this.organizationId('update'), id: teamId, deletedAt: null },
        data: { name: draft.name, slug: draft.slug, description: draft.description },
      });

      return count > 0;
    });
  }

  disband(teamId: string): Promise<DisbandedTeam | null> {
    return this.run('disband', async (tx) => {
      const organizationId = this.organizationId('disband');

      // Conditional on `deleted_at IS NULL` and returning the name in the same statement: reading
      // first and hiding afterwards would be two statements over a row that a concurrent request can
      // disband in between, and the second caller would then file a `team.deleted` entry for a
      // deletion somebody else performed.
      const hidden = await tx.$queryRaw<{ name: string }[]>`
        UPDATE teams
           SET deleted_at = now()
         WHERE organization_id = ${organizationId}::uuid
           AND id = ${teamId}::uuid
           AND deleted_at IS NULL
        RETURNING name`;

      const team = hidden[0];

      if (team === undefined) return null;

      // `RETURNING user_id, team_role`, because `deleteMany` cannot report what it removed and there
      // is nothing left to read afterwards: `team_members` has no `deleted_at`, so this result is the
      // only place either column survives the deletion.
      const removed = await tx.$queryRaw<{ user_id: string; team_role: string }[]>`
        DELETE FROM team_members
         WHERE organization_id = ${organizationId}::uuid
           AND team_id = ${teamId}::uuid
        RETURNING user_id, team_role`;

      return {
        name: team.name,
        members: removed.map((row) => ({ userId: row.user_id, teamRole: row.team_role })),
      };
    });
  }

  subject(userId: string): Promise<TeamSubject | null> {
    return this.run('subject', async (tx) => {
      // `FOR SHARE`, for the symmetric half of M-1. `PrismaUserLifecycleRepository.suspend()` takes
      // an exclusive lock on this same row with its `UPDATE … SET status = 'SUSPENDED'`, and then
      // unconditionally deletes every row of `team_members` naming this user. Without a lock here,
      // `addMember` can read `ACTIVE`, offboarding can suspend the account and delete a (still
      // nonexistent) membership in between, and `addMember`'s own `INSERT` — which carries no
      // predicate on the subject's current status — can still land afterwards: a `SUSPENDED` account
      // holding a membership, exactly the state offboarding's own `DELETE` exists to make
      // unreachable. The share lock serializes the two: whichever commits second either re-reads a
      // status that has just changed (and `assertMemberJoinable` refuses) or, if offboarding commits
      // second, its `DELETE` runs after the membership was written and removes it.
      const rows = await tx.$queryRaw<{ id: string; status: TeamSubject['status'] }[]>`
        SELECT id, status FROM users
         WHERE organization_id = ${this.organizationId('subject')}::uuid
           AND id = ${userId}::uuid
           AND deleted_at IS NULL
         FOR SHARE`;

      const user = rows[0];

      if (user === undefined) return null;

      return { userId: user.id, status: user.status };
    });
  }

  addMember(teamId: string, userId: string, teamRole: string): Promise<AddMemberResult> {
    return this.run('addMember', async (tx) => {
      const organizationId = this.organizationId('addMember');

      // `FOR UPDATE`, not a plain read: two requests promoting the same person to `LEAD` at once must
      // not both believe they were the one that changed anything, and the lock is what makes the
      // decision below and the write after it one atomic step rather than a read a concurrent writer
      // can invalidate in between. Nothing to lock when the row does not exist yet, and that half is
      // only a data-integrity guarantee, not an outcome one: two transactions racing the **same
      // not-yet-existing** pair both read an empty `existing` here, both proceed to the `INSERT`
      // below, and PostgreSQL's own conflict handling still leaves exactly one row — but each
      // transaction still classifies its own write as `'created'` from the stale read it took before
      // the lock existed to take. The use-case files `team.member_added` and bumps the version on the
      // strength of that classification, so this specific race can double both, for a person actually
      // added once. Accepted as a residual risk of the gate that introduced the three-way outcome
      // (STORY-012-07, L-3) rather than fixed here — see the story's «Что отложено».
      const existing = await tx.$queryRaw<{ team_role: string }[]>`
        SELECT team_role FROM team_members
         WHERE organization_id = ${organizationId}::uuid
           AND team_id = ${teamId}::uuid
           AND user_id = ${userId}::uuid
         FOR UPDATE`;

      const previousRole = existing[0]?.team_role ?? null;

      // The gate's L-3: a bare `DO NOTHING` made a second `POST` with a different `teamRole` a no-op
      // that still answered 204 — the only way this API can promote an existing member to `LEAD`, and
      // it silently didn't. `DO UPDATE … WHERE team_role <> EXCLUDED.team_role` fixes that without
      // touching the row at all when the role actually matches: the conflict target is named by
      // columns rather than `ON CONSTRAINT uq_team_members` for the reason `invitation.repository.ts`
      // documents — that name is a unique *index*, which `pg_constraint` does not carry, so the
      // constraint spelling fails at parse time on every call rather than only on a conflict.
      if (previousRole === teamRole) return { outcome: 'unchanged', previousRole: null };

      await tx.$executeRaw`
        INSERT INTO team_members (organization_id, team_id, user_id, team_role, updated_at)
        VALUES (${organizationId}::uuid, ${teamId}::uuid, ${userId}::uuid, ${teamRole}, now())
        ON CONFLICT (team_id, user_id) DO UPDATE
          SET team_role = EXCLUDED.team_role, updated_at = now()
          WHERE team_members.team_role <> EXCLUDED.team_role`;

      return {
        outcome: previousRole === null ? 'created' : 'role_changed',
        previousRole,
      };
    });
  }

  removeMember(teamId: string, userId: string): Promise<boolean> {
    return this.run('removeMember', async (tx) => {
      const { count } = await tx.teamMember.deleteMany({
        where: { organizationId: this.organizationId('removeMember'), teamId, userId },
      });

      return count > 0;
    });
  }

  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void> {
    return this.run('bumpPermissionsVersionOf', async (tx) => {
      if (userIds.length === 0) return;

      await tx.$executeRaw`
        UPDATE users
           SET permissions_version = permissions_version + 1
         WHERE organization_id = ${this.organizationId('bumpPermissionsVersionOf')}::uuid
           AND id = ANY(${[...userIds]}::uuid[])`;
    });
  }
}

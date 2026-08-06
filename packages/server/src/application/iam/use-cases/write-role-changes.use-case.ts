import { type SharedPermissions } from '@bad-crm/shared';

import {
  type CustomRoleRepositoryPort,
  type RoleComposition,
} from '@/application/iam/ports/role-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  judgeRoleChanges,
  type RoleChange,
  type RoleChangeVerdict,
} from '@/domain/iam/access/role-batch.policy.js';
import { assertAllowed } from '@/domain/access/decision.util.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';
import { ConfirmationRequiredError } from '@/domain/shared/errors/app.errors.js';

/** One row of the draft as the screen sends it: the composition the role should end up with. */
export interface DraftedRole {
  readonly roleId: string;
  readonly permissions: readonly SharedPermissions.PermissionKey[];
}

export interface RoleChangesInput {
  readonly actor: Actor;
  readonly changes: readonly DraftedRole[];
  /** The caller has seen the dangerous keys and repeated the request. Ignored by the preview. */
  readonly confirmedDangerous?: boolean;
}

/** What the preview tells the screen about one drafted role. */
export interface RoleChangeOutcome extends RoleChangeVerdict {
  readonly key: string;
  readonly name: string;
  readonly isSystem: boolean;
  readonly holderCount: number;
}

/**
 * «What would happen if I saved this» — the read the matrix screen makes before it writes.
 *
 * The screen could compute the difference itself; the two things it cannot compute are how many
 * people each change affects and **whether the server would accept it**. Both have to come from the
 * same place that decides on save, or the summary shown to the administrator is a second opinion
 * that can disagree with the first — and the one that disagrees is the one they read.
 *
 * Nothing is written and nothing is locked: this is a read behind `role:read`, and a draft the
 * administrator abandons costs a query and no rows.
 */
export class PreviewRoleChangesQuery {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly roles: CustomRoleRepositoryPort,
  ) {}

  execute(input: RoleChangesInput): Promise<readonly RoleChangeOutcome[]> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const { drafted, counts } = await readDraft(this.roles, input);
        const holdings = await this.roles.holdingsOf(input.actor.userId);
        const verdicts = judgeRoleChanges(
          input.actor,
          drafted.map((entry) => entry.change),
          holdings,
        );

        return verdicts.map((verdict, index) => {
          const { before } = drafted[index] as Drafted;

          return {
            ...verdict,
            key: before.key,
            name: before.name,
            isSystem: before.isSystem,
            holderCount: counts.get(before.roleId) ?? 0,
          };
        });
      },
    );
  }
}

/**
 * Saves the draft — **all of it or none of it**.
 *
 * A partial application is the outcome worth designing against: the administrator sees twelve
 * changes, eleven land, and the matrix on screen now describes a state that exists nowhere. So every
 * change is judged first, and one refusal refuses the request. The client learns *which* one by
 * asking the preview again — the refusal carries a code, never a list, because `details` reaches the
 * log and never the body.
 *
 * Everybody holding a role that actually moved is invalidated, by role, in the same transaction.
 * Roles whose composition the draft leaves unchanged are skipped entirely: an administrator who
 * clicked a cell twice has not changed anybody's rights, and a bump would answer 401 to every holder
 * for nothing.
 */
export class ApplyRoleChangesUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly roles: CustomRoleRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: RoleChangesInput): Promise<void> {
    return this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const { drafted } = await readDraft(this.roles, input);
        const holdings = await this.roles.holdingsOf(input.actor.userId);
        const verdicts = judgeRoleChanges(
          input.actor,
          drafted.map((entry) => entry.change),
          holdings,
        );

        // One refusal refuses the request: the alternative is eleven changes of twelve landing and a
        // screen describing a state that exists nowhere. Which one it was comes from the preview,
        // the read that exists to answer exactly that.
        for (const verdict of verdicts) {
          if (verdict.reason !== null)
            assertAllowed({ allowed: false, reason: verdict.reason }, 'role');
        }

        const dangerous = verdicts.flatMap((verdict) => verdict.dangerous);

        if (dangerous.length > 0 && input.confirmedDangerous !== true) {
          throw new ConfirmationRequiredError({ dangerous: [...new Set(dangerous)] });
        }

        const moved = verdicts.filter(
          (verdict) => verdict.added.length > 0 || verdict.removed.length > 0,
        );

        for (const verdict of moved) {
          const entry = drafted.find((candidate) => candidate.change.roleId === verdict.roleId);

          await this.applyOne(input.actor, verdict, entry as Drafted);
        }

        // One statement for the whole draft rather than one per role: sixty-four round trips inside
        // a transaction with a five-second ceiling is a save that fails on arithmetic, and a single
        // ordered statement also gives two concurrent drafts the same lock order.
        await this.roles.bumpHoldersOfMany(moved.map((verdict) => verdict.roleId));
      },
    );
  }

  private async applyOne(
    actor: Actor,
    verdict: RoleChangeVerdict,
    drafted: Drafted,
  ): Promise<void> {
    const { before, change } = drafted;

    const updated = await this.roles.update(verdict.roleId, {
      name: before.name,
      // Carried through, not defaulted: this operation edits the composition, and a `null` here
      // would erase the description of every role anybody saved from the matrix screen — invisibly,
      // because the trail records the composition and not the prose beside it.
      description: before.description,
      permissions: change.after,
    });

    // Deleted between the read and this write: the same answer as for a role of another
    // organization, and it takes the whole draft with it rather than leaving eleven of twelve.
    if (!updated) throw denyAccess('role', 'other_organization');

    if (verdict.dangerous.length > 0) {
      await this.audit.record({
        action: 'role.dangerous_granted',
        actor: { userId: actor.userId, organizationId: actor.organizationId, ipAddress: undefined },
        target: { type: 'ROLE', id: verdict.roleId },
        after: { permissions: [...verdict.dangerous] },
        requestId: undefined,
      });
    }

    await this.audit.record({
      action: 'role.updated',
      actor: { userId: actor.userId, organizationId: actor.organizationId, ipAddress: undefined },
      target: { type: 'ROLE', id: verdict.roleId },
      before: { key: before.key, name: before.name, permissions: [...before.permissions] },
      after: { key: before.key, name: before.name, permissions: [...change.after] },
      requestId: undefined,
    });
  }
}

/** A drafted change beside the role it changes — paired once, so nothing has to be looked up again. */
interface Drafted {
  readonly change: RoleChange;
  readonly before: RoleComposition;
}

/**
 * Turns the draft into what the policy needs, and refuses a role this organization does not have.
 *
 * A missing role is **404 for the whole draft**, not a change quietly dropped: the screen sent a
 * matrix it believes in, and applying the rest of it would leave that belief intact and wrong.
 *
 * The pairing is the point of returning `Drafted` rather than two collections: every later step has
 * the composition in hand, so there is no lookup that could miss and no «cannot happen» branch to
 * write a test for or, worse, to leave untested.
 */
const readDraft = async (
  roles: CustomRoleRepositoryPort,
  input: RoleChangesInput,
): Promise<{ drafted: readonly Drafted[]; counts: ReadonlyMap<string, number> }> => {
  const roleIds = input.changes.map((change) => change.roleId);
  const [found, counts] = await Promise.all([
    roles.compositionsOf(roleIds),
    roles.holderCounts(roleIds),
  ]);
  const compositions = new Map(found.map((role) => [role.roleId, role]));

  const drafted = input.changes.map((entry) => {
    const before = compositions.get(entry.roleId);

    if (before === undefined) throw denyAccess('role', 'other_organization');

    return {
      before,
      change: {
        roleId: entry.roleId,
        key: before.key,
        isSystem: before.isSystem,
        before: before.permissions,
        after: entry.permissions,
      },
    };
  });

  return { drafted, counts };
};

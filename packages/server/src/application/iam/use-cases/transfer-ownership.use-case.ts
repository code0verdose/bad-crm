import { type OwnershipRepositoryPort } from '@/application/iam/ports/ownership-repository.port.js';
import { type AuditLoggerPort } from '@/application/platform/ports/audit-logger.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { type Actor } from '@/domain/access/actor.types.js';
import { assertTransferable } from '@/domain/iam/access/ownership-transfer.policy.js';
import { denyAccess } from '@/domain/shared/errors/access-denial.util.js';

export interface TransferOwnershipInput {
  readonly actor: Actor;
  readonly toUserId: string;
  /** What the outgoing owner keeps. The screen defaults it to `admin` and shows the choice. */
  readonly previousOwnerRoleKey: string;
}

export interface OwnershipTransferResult {
  readonly fromUserId: string;
  readonly toUserId: string;
  readonly previousOwnerRoleKey: string;
}

/**
 * Handing the organization to somebody else.
 *
 * **The whole point is that it is one operation.** Ownership used to be changeable only by editing
 * the database, and an installation whose founder leaves is otherwise a support ticket. What makes
 * it safe is the transaction: roles, the tenant root and both permission versions move together, so
 * there is no moment at which the organization has two owners or none.
 *
 * **Both versions are bumped, and the outgoing one is not an afterthought.** The recipient needs
 * their new authority on their next request; the previous owner's live token still claims an
 * authority they have just given away, and a version that did not move would honour it for the rest
 * of its fifteen minutes.
 *
 * No capability check in this body: whether the caller holds `organization:transfer_ownership` is
 * the guard's question and it already answered it. What the use-case owes is the decision the guard
 * cannot make — and there turn out to be two of them, not one. The obvious one is whether *this*
 * recipient may receive it, and whether they exist in this tenant at all. The one that is easy to
 * miss is whether the caller is *entitled to give it away in the first place*: the capability can be
 * held by somebody other than `organizations.owner_id` — a per-user override, a custom role, a
 * genuine owner delegating "transfer on my behalf while I am away" — and none of that makes their
 * organization the delegate's to hand over. `organizations.owner_id` is read inside this transaction,
 * before the policy that decides whether this transfer may proceed, and answers that question the
 * only way it can be answered honestly: from the row, not from the token.
 */
export class TransferOwnershipUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly ownership: OwnershipRepositoryPort,
    private readonly audit: AuditLoggerPort,
  ) {}

  async execute(input: TransferOwnershipInput): Promise<OwnershipTransferResult> {
    return await this.unitOfWork.withTenant(
      { organizationId: input.actor.organizationId, userId: input.actor.userId },
      async () => {
        const recipient = await this.ownership.candidate(input.toUserId);

        // Somebody of another organization: 404, indistinguishable from an id that never existed.
        // Resolved before ownership is even read — an unknown recipient is refused the same way
        // whoever is asking, and reading `currentOwnerId()` first would buy this branch nothing.
        if (recipient === null) throw denyAccess('user', 'other_organization');

        // Read inside the transaction, before the policy, rather than trusting the actor's own
        // claim: the caller holds the *capability* — the guard already confirmed that — but the
        // capability is not who owns the organization. Between the token and the row, the row wins,
        // because it is the thing about to change.
        const fromUserId = await this.ownership.currentOwnerId();

        // `null` means this tenant's own root did not resolve inside its own scope — a soft-deleted
        // organization, or a broken installation. There is no correct owner to name in that state,
        // and quietly attributing the transfer to the caller (the previous behaviour) would let an
        // orphaned scope silently transfer as whoever happened to ask. Fail loudly instead: this is
        // not a request the caller got wrong, it is data the use-case cannot proceed on.
        if (fromUserId === null) {
          throw new Error(
            'transfer-ownership: currentOwnerId() answered null inside the tenant scope it belongs ' +
              'to — the organization has no resolvable owner and the transfer cannot be attributed',
          );
        }

        assertTransferable(input.actor, fromUserId, recipient);

        await this.ownership.transfer({
          fromUserId,
          toUserId: recipient.userId,
          previousOwnerRoleKey: input.previousOwnerRoleKey,
        });

        await this.audit.record({
          action: 'organization.ownership_transferred',
          actor: {
            userId: input.actor.userId,
            organizationId: input.actor.organizationId,
            ipAddress: undefined,
          },
          target: { type: 'ORGANIZATION', id: input.actor.organizationId },
          before: { ownerId: fromUserId },
          // Both ids and the fallback role: after this entry a different person can do everything,
          // including granting themselves whatever the trail would otherwise record.
          after: { ownerId: recipient.userId, previousOwnerRoleKey: input.previousOwnerRoleKey },
          requestId: undefined,
        });

        return {
          fromUserId,
          toUserId: recipient.userId,
          previousOwnerRoleKey: input.previousOwnerRoleKey,
        };
      },
    );
  }
}

import { SharedAudit } from '@bad-crm/shared';
import { Prisma } from '@prisma/client';

import { redactAuditPayload } from '@/application/platform/audit/audit-redaction.util.js';
import {
  AuditFenceRollbackError,
  AuditTrailUnscopedError,
} from '@/application/platform/audit/audit-trail.errors.js';
import { isDegradableAuditAction } from '@/application/platform/audit/degradable-audit-actions.util.js';
import { AUDIT_ACTIONS_WITHOUT_ORGANIZATION } from '@/application/platform/audit/unscoped-audit-actions.constant.js';
import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import {
  currentTenant,
  type TenantStore,
} from '@/infrastructure/persistence/prisma/tenant.context.js';

export interface PrismaAuditLoggerDependencies {
  readonly addressHasher: AddressHasherPort;
  readonly requestContext: RequestContextPort;
  /**
   * Where an event goes when it has no organization to be filed under.
   *
   * Not a fallback for failures — a failure here must not be swallowed — and not a fallback for
   * callers either: only the actions on `AUDIT_ACTIONS_WITHOUT_ORGANIZATION` reach it, and
   * everything else that cannot be a row is refused instead. `organization_id` is `NOT NULL`, so a
   * maintenance path that steps around row level security has nowhere to be filed; it is still part
   * of the trail, and the log line is where an installation reads it.
   */
  readonly unscoped: AuditLoggerPort;
}

/**
 * The audit trail as rows, written **inside the transaction that caused them**.
 *
 * That is the whole design, and everything else follows from it:
 *
 * - the transaction is the one `withTenant` opened, read out of AsyncLocalStorage rather than passed
 *   in — the same rule every repository follows, and here it is what makes the guarantee real: a
 *   rolled-back change rolls back its record, and a change that committed cannot have lost one;
 * - there is no `organizationId` parameter. The tenant is the scope, and a trail that could be
 *   written into another organization would be worse than no trail;
 * - the moment is stamped by the database (`occurred_at` defaults to `now()`), not by the caller.
 *
 * **`severity` comes from the action**, through `AUDIT_ACTION_SEVERITY`, and never from the call
 * site: the same event filed at two levels by two use-cases makes «show me the critical ones»
 * silently incomplete.
 *
 * **The payload is filtered before anything is written**, on the way in rather than on each of the
 * two ways out: an event that cannot be a row still goes to the log, and a log line is read by
 * everyone who can read the logs. Doing it once here is also what makes the guarantee checkable —
 * one place to point at, instead of thirty call sites to trust
 * (`application/platform/audit/audit-redaction.util.ts`).
 *
 * **The address is hashed, never stored.** `AuditEvent` carries the address because that is what an
 * HTTP layer has; what reaches the column is a keyed digest, the same one sessions store, so «the
 * same address again» stays answerable without the address being recoverable from a dump.
 *
 * **A degradable insert is fenced in a savepoint; a fail-closed one is not.** The writer still
 * rejects on every failure — softening is not its job — but a failed statement aborts the
 * PostgreSQL transaction it ran in, and an action that may go on without its row
 * (`degradable-audit-actions.util.ts`) needs a transaction that still accepts its commit. The
 * savepoint is what makes that so, and it is bought only where it is used: for every other action
 * the aborted transaction *is* the intended outcome.
 *
 * **Records are serialised per transaction, and every fence has a name of its own.** A savepoint is
 * a point on the connection's stack, and `ROLLBACK TO` undoes everything issued after it — not only
 * the insert it was set for. Two records started together on one transaction put both fences on
 * the stack before either insert ran, and the rollback of the second erased the row of the first
 * while the first reported success and the counter saw one failure. So the fence and the insert of
 * one entry are kept contiguous on the wire by a queue keyed on the transaction, and the name is
 * taken from a counter so a rollback can only ever address the point it set. The name is the one
 * thing this file interpolates into SQL, and it is built from a checked integer and nothing the
 * caller supplied.
 */
export class PrismaAuditLogger implements AuditLoggerPort {
  /** Numbers the fences; never restarts, so no two fences of this process share a name. */
  private fenceSequence = 0;

  /**
   * The tail of the queue of each open transaction. A `WeakMap` on the transaction client, so a
   * transaction that ended takes its entry with it and nothing here outlives `withTenant`.
   */
  private readonly queues = new WeakMap<object, Promise<unknown>>();

  constructor(private readonly dependencies: PrismaAuditLoggerDependencies) {}

  async record(event: AuditEvent): Promise<void> {
    // Spread rather than assignment: under `exactOptionalPropertyTypes` an absent payload and one
    // present as `undefined` are different types, and «nothing to record» must stay absent.
    const before = redactAuditPayload(event.before);
    const after = redactAuditPayload(event.after);
    const safe: AuditEvent = {
      ...event,
      ...(before === undefined ? {} : { before }),
      ...(after === undefined ? {} : { after }),
    };
    const store = currentTenant();
    const organizationId = safe.actor.organizationId;

    // No organization at all. Only the listed actions have none by nature; for every other action
    // this is a caller that lost its scope, and the log line it used to get was a hole in the trail
    // nobody was told about (`unscoped-audit-actions.constant.ts`).
    if (organizationId === undefined) {
      if (!AUDIT_ACTIONS_WITHOUT_ORGANIZATION.has(safe.action)) {
        throw new AuditTrailUnscopedError(safe.action, 'it names no organization');
      }

      await this.dependencies.unscoped.record(safe);

      return;
    }

    // The event knows its organization and there is no transaction to join. Writing it as a log line
    // would let the caller succeed while its privileged action went unrecorded, which is precisely
    // what the port promises does not happen.
    if (store === undefined) {
      throw new AuditTrailUnscopedError(
        safe.action,
        `it names organization ${organizationId} but no tenant scope is open`,
      );
    }

    // A disagreement is a bug in the caller for every action, the listed ones included: the scope is
    // the authority on the tenant. Filing under the open scope would put one organization's event
    // into another's trail, and a reader of the second cannot tell.
    if (store.ctx.organizationId !== organizationId) {
      throw new AuditTrailUnscopedError(
        safe.action,
        `it names organization ${organizationId} while the open scope is ${store.ctx.organizationId}`,
      );
    }

    return this.enqueue(store.tx, () => this.write(store.tx, safe, organizationId));
  }

  /**
   * Runs one write after every write already queued on the same transaction — whatever the earlier
   * one's outcome, since its rejection belongs to its own caller and must not turn the next record
   * into a second failure.
   */
  private enqueue(tx: object, write: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(tx) ?? Promise.resolve();
    const next = previous.then(write, write);

    this.queues.set(tx, next);

    return next;
  }

  private async write(
    tx: TenantStore['tx'],
    safe: AuditEvent,
    organizationId: string,
  ): Promise<void> {
    const insert = (): Promise<unknown> =>
      tx.auditLog.create({
        data: {
          organizationId,
          actorId: safe.actor.userId ?? null,
          // A privileged action with an acting person is `USER`; one without is the system acting on
          // its own — a job, a migration path, a scheduled revocation.
          actorType: safe.actor.userId === undefined ? 'SYSTEM' : 'USER',
          action: safe.action,
          resourceType: safe.target.type,
          resourceId: safe.target.id ?? null,
          before: toJson(safe.before),
          after: toJson(safe.after),
          ipHash:
            safe.actor.ipAddress === undefined
              ? null
              : this.dependencies.addressHasher.hash(safe.actor.ipAddress),
          userAgent: null,
          // The thread that ties an HTTP request to its entry. Taken from the ambient context when the
          // caller did not pass one, because a use-case should not have to carry a transport detail
          // through four constructor arguments to record it.
          requestId: safe.requestId ?? this.dependencies.requestContext.current()?.requestId ?? '',
          severity: SharedAudit.severityOf(safe.action),
        },
      });

    // A fail-closed action — every WARNING and CRITICAL, and the INFO entries that stand behind a
    // dangerous key — is written bare. If the insert fails, the transaction is aborted and the
    // caller's own commit is refused — which is the outcome the trail wants, and paying two round
    // trips to fence it would buy nothing but the ability to soften it.
    if (!isDegradableAuditAction(safe.action)) {
      await insert();

      return;
    }

    // A degradable row may be missing without the action being undone (STORY-016-02, acceptance
    // 9), and that is only true if a failed insert leaves the transaction usable: PostgreSQL aborts
    // it on the first failed statement and refuses everything after, the `COMMIT` included. The
    // savepoint is what restores it. The failure is still rethrown from here — the writer reports,
    // and who softens it is decided one layer up (`degrading-audit-logger.adapter.ts`), where the
    // counter and the log line live. Cost of the fence: two statements, priced in
    // `docs/runbooks/audit-log.md`.
    const savepoint = Prisma.raw(this.nextFenceName());

    await tx.$executeRaw`SAVEPOINT ${savepoint}`;

    try {
      await insert();
    } catch (insertFailure) {
      try {
        await tx.$executeRaw`ROLLBACK TO SAVEPOINT ${savepoint}`;
      } catch (rollbackFailure) {
        throw new AuditFenceRollbackError(safe.action, rollbackFailure, insertFailure);
      }

      throw insertFailure;
    }

    await tx.$executeRaw`RELEASE SAVEPOINT ${savepoint}`;
  }

  /**
   * `audit_entry_<n>` from the adapter's own counter. The check is what makes `Prisma.raw` above
   * defensible: the interpolated text is an identifier built from a positive safe integer, and
   * nothing that arrived in an event can reach it.
   */
  private nextFenceName(): string {
    this.fenceSequence += 1;

    if (!Number.isSafeInteger(this.fenceSequence) || this.fenceSequence <= 0) {
      throw new RangeError(`audit savepoint sequence out of range: ${this.fenceSequence}`);
    }

    return `audit_entry_${this.fenceSequence}`;
  }
}

/** `undefined` is «nothing to record»; Prisma's `JsonNull` is how that is written to a nullable column. */
const toJson = (
  value: Readonly<Record<string, unknown>> | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

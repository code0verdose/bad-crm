import { SharedAudit } from '@bad-crm/shared';
import { Prisma } from '@prisma/client';

import { redactAuditPayload } from '@/application/platform/audit/audit-redaction.util.js';
import { AuditTrailUnscopedError } from '@/application/platform/audit/audit-trail.errors.js';
import { AUDIT_ACTIONS_WITHOUT_ORGANIZATION } from '@/application/platform/audit/unscoped-audit-actions.constant.js';
import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type AddressHasherPort } from '@/application/identity/ports/address-hasher.port.js';
import { type RequestContextPort } from '@/application/platform/ports/request-context.port.js';
import { currentTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

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
 */
export class PrismaAuditLogger implements AuditLoggerPort {
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

    await store.tx.auditLog.create({
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
  }
}

/** `undefined` is «nothing to record»; Prisma's `JsonNull` is how that is written to a nullable column. */
const toJson = (
  value: Readonly<Record<string, unknown>> | undefined,
): Prisma.InputJsonValue | typeof Prisma.JsonNull =>
  value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);

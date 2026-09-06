import { type SharedPermissions } from '@bad-crm/shared';

import {
  type AuditEvent,
  type AuditLoggerPort,
} from '@/application/platform/ports/audit-logger.port.js';
import { type LoggerPort } from '@/application/platform/ports/logger.port.js';
import { type MetricsPort } from '@/application/platform/ports/metrics.port.js';
import { type RateLimitPort } from '@/application/platform/ports/rate-limit.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';
import { recordableDenial } from '@/domain/access/denied-access-audit.policy.js';

/**
 * How many entries one actor's refusals may produce before they are summarised.
 *
 * The same number as `RATE_LIMIT_POLICY.access_denial_audit.points`, and it has to be: the limiter
 * decides *when* to stop, this decides what the summary **says** it stopped after. The two live in
 * different layers — the policy table is infrastructure, this is the application — so they cannot be
 * one constant; `record-denied-access.use-case.test.ts` asserts they agree, because a `points: 12`
 * with an unchanged constant here would produce a truthful row saying the wrong number.
 */
export const DENIAL_AUDIT_BUDGET = 11;

/** The window that budget is spent over — `windowSeconds` of the same policy, asserted the same way. */
export const BURST_WINDOW_SECONDS = 60;

/**
 * One refusal, as much of it as may be written down.
 *
 * **No URL and no body, at any level.** A path segment of this product can itself be a credential
 * (`/l/:token`), and `rules/observability.mdc` keeps both out of every channel (§9 on the route
 * template, «Исключения» on the body) — the trail
 * included, and more so, because it is the channel that is kept. What identifies the attempt is the
 * permission key, which comes from a closed catalogue and has no cardinality and no secrets in it.
 */
export interface DeniedAccess {
  readonly reason: SharedPermissions.DenyReason;
  readonly permissionKey: SharedPermissions.PermissionKey | undefined;
  readonly method: string;
  readonly actorUserId: string;
  readonly organizationId: string;
  readonly ipAddress: string | undefined;
  readonly requestId: string | undefined;
}

/** What the HTTP surface holds: a call that returns, whatever happens underneath. */
export interface DeniedAccessAuditSink {
  record(denial: DeniedAccess): void;
}

export interface RecordDeniedAccessDependencies {
  readonly rateLimit: RateLimitPort;
  readonly unitOfWork: UnitOfWorkPort;
  readonly audit: AuditLoggerPort;
}

/**
 * The refusal trail: the one path that writes an audit row for something that did **not** happen.
 *
 * ## Why it is here and not where the refusal is built
 *
 * Three places could hold this, and two of them are wrong for reasons the layers already state.
 *
 * - **`assertAllowed`, in `domain`** — the natural-looking home, and forbidden: the domain does no
 *   I/O at all (`rules/hexagonal-backend.mdc` §2), which is the same rule that keeps a clock and a
 *   metrics port out of it. It is also the wrong *shape*: a refusal is thrown from a pure function
 *   that cannot await anything.
 * - **each use-case** — correct layer, wrong multiplicity. It would put the same four lines at every
 *   `assertAllowed` in the codebase, and the first one written without them would be invisible;
 *   worse, it would miss the refusals that never reach a use-case at all, which is most of them —
 *   the capability guard refuses in middleware, before the controller runs.
 * - **the error handler**, which is what this is called from. Every refusal *that carries a reason*
 *   passes through it by construction — the same argument that already put
 *   `incrementPermissionDenied` there — so nothing has to be remembered at a call site, and a new
 *   `assertAllowed` is covered on the day it is written.
 *
 * **What that last sentence does not cover, and the limit is the same one the metric has.** The
 * other refusal family — `denyAccess` (`domain/shared/errors/access-denial.util.ts`), the one a
 * use-case answers «the row is not there, or not yours» with — produces a plain
 * `NotFoundError`/`ForbiddenError` and carries no `DenyReason` at all, so it reaches neither this
 * sink nor `permission_denied_total`. There are more of those call sites than there are
 * `assertAllowed`s, and some are cross-tenant refusals on mutating routes. Inventing a reason from
 * the status is what the error handler's own comment refuses to do, and for the reason invariant 2
 * gives: «404 means resource_not_found» is precisely the inference the model exists to make
 * impossible. Folding the two families into one is STORY-016-02's remaining work, not this path's.
 *
 * ## Why it opens its own transaction
 *
 * The handler runs after the use-case's transaction closed, and `PrismaAuditLogger` writes into the
 * scope `withTenant` opened, refusing outright when there is none. So this path opens one of its
 * own, on the tenant of the actor who was refused — the only tenant it may name, and the one whose
 * journal the entry belongs in.
 *
 * That is a write on the refusal path, which is the path an attacker chooses, so it is bounded
 * twice before it gets here: `recordableDenial` drops the classes that are cheap to provoke, and
 * `access_denial_audit` caps what one actor can write in a minute at eleven rows regardless. A
 * refused `GET` on an **ordinary** permission costs nothing at all — not a row, not a transaction,
 * not even a Redis round trip. On a `dangerous` one it costs all three, on every request, because
 * the first rule of the selection says so on purpose: reading who may impersonate whom is the
 * reconnaissance step, and it is a `GET`.
 *
 * ## Why a failure here is not fail-closed
 *
 * `audit-logger.port.ts` puts the decision on the caller, and for a privileged action the answer is
 * "an action nobody could write down did not happen". A refusal is the opposite case: nothing
 * happened, and the caller is already being told so. There is no transaction to roll back and no
 * effect to undo, so a broken Redis or a broken insert must not turn a correct 403 into a 500 — the
 * failure is counted (`audit_write_failed_total`) and logged, by the wrapper below.
 */
export class RecordDeniedAccessUseCase {
  constructor(private readonly dependencies: RecordDeniedAccessDependencies) {}

  async record(denial: DeniedAccess): Promise<void> {
    const recordable = recordableDenial(denial);

    if (recordable === null) return;

    const budget = await this.dependencies.rateLimit.consume('access_denial_audit', {
      userId: denial.actorUserId,
    });

    // The run has already been summarised. Everything after that is the counter's job.
    if (!budget.allowed) return;

    // The last point of the budget buys the summary rather than another copy of the same refusal:
    // one entry per run, the shape `user.mfa_recovery_locked_out` established.
    const burst = budget.remaining === 0;
    const event: AuditEvent = {
      action: burst ? 'access.denial_burst' : 'access.denied',
      actor: {
        userId: denial.actorUserId,
        organizationId: denial.organizationId,
        ipAddress: denial.ipAddress,
      },
      // No row was reached — that is what the refusal means — so the target is the organization the
      // attempt was made inside, with no id. `AuditTarget.id` is documented absent for exactly this:
      // an action about a capability rather than about a row. A resource type of its own was
      // considered and left out; there is no resource here to name.
      target: { type: 'ORGANIZATION', id: undefined },
      after: {
        reason: recordable.reason,
        // `null`, not absent: "this refusal was not about a key" is a fact worth reading back, and
        // a missing field reads as a writer that forgot.
        permissionKey: denial.permissionKey ?? null,
        method: denial.method,
        because: recordable.because,
        ...(burst
          ? { collapsedAfter: DENIAL_AUDIT_BUDGET - 1, windowSeconds: BURST_WINDOW_SECONDS }
          : {}),
      },
      requestId: denial.requestId,
    };

    await this.dependencies.unitOfWork.withTenant(
      { organizationId: denial.organizationId, userId: denial.actorUserId },
      () => this.dependencies.audit.record(event),
    );
  }
}

export interface BestEffortDependencies {
  readonly logger: LoggerPort;
  readonly metrics?: MetricsPort | undefined;
}

/**
 * The sink the HTTP surface holds: it starts the write and returns.
 *
 * Detached on purpose. Awaiting it would put a Redis round trip and a transaction between a refused
 * caller and their 403 — making the refusal slower than the success, on the path somebody chooses to
 * hammer — and would hand a broken dependency the ability to change the answer. What is lost is
 * ordering: the response can be on the wire before the row is. That is acceptable for an entry
 * describing something that did not happen, and it is not acceptable for a privileged action, which
 * is why no other audit call site looks like this one.
 *
 * A rejection is counted into the same series a failed trail write is counted into and logged at
 * `warn` with the reason only — never the address, which belongs in the hashed column and in no log
 * (`session-client.util.ts`).
 */
export const bestEffortDeniedAccessAudit = (
  service: { record(denial: DeniedAccess): Promise<void> },
  dependencies: BestEffortDependencies,
): DeniedAccessAuditSink => ({
  record: (denial: DeniedAccess): void => {
    void (async (): Promise<void> => {
      try {
        await service.record(denial);
      } catch (error) {
        dependencies.metrics?.incrementAuditWriteFailed();
        dependencies.logger.warn(
          { reason: denial.reason, err: error },
          'denied access was not recorded',
        );
      }
      // A second net under the first, because this promise is detached and nothing above it can
      // catch anything: a throw from the counter or the logger inside that `catch` would leave an
      // unhandled rejection, and Node's default is to end the process on one. Unreachable in
      // practice — `prom-client` does not throw on an unlabelled increment, pino serialises a
      // cyclic `err` — but this is the only place in the change where a failure escapes the request
      // that caused it, and the cost of being wrong is the whole process rather than one response.
    })().catch(() => undefined);
  },
});

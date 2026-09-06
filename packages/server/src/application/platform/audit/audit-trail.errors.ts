import { type SharedAudit } from '@bad-crm/shared';

/**
 * A privileged action that could not be written to the trail, and must therefore not take effect.
 *
 * A programming error, not user input: it means a call site recorded outside the tenant scope of the
 * change it describes, or named an organization the open scope disagrees with. Both are bugs in the
 * caller, and both used to be answered by writing a log line and returning success — which turned
 * the trail's fail-closed contract into a best effort at exactly the moments it mattered.
 *
 * Thrown rather than logged, so the existing chain does its job unchanged: `countedAuditLogger`
 * counts it into `audit_write_failed_total` and rethrows, the enclosing transaction rolls back, and
 * the action does not happen. The message names the action and the reason, because the person who
 * will read it is the author of the call site, not an operator.
 */
export class AuditTrailUnscopedError extends Error {
  constructor(action: SharedAudit.AuditAction, reason: string) {
    super(
      `Audit action ${action} cannot be recorded: ${reason}. ` +
        'Record it inside the withTenant scope of the change it describes, or add the action to ' +
        'AUDIT_ACTIONS_WITHOUT_ORGANIZATION with the reason it has no organization.',
    );
    this.name = 'AuditTrailUnscopedError';
  }
}

/**
 * The row was refused and the savepoint that fenced it could not be rolled back afterwards.
 *
 * Two failures in one exception, and neither may replace the other: the insert failure is the
 * reason there is no row (`cause`), the rollback failure is the reason the transaction is no longer
 * known to be usable (the message). The first draft rethrew whatever the rollback threw and lost
 * the insert failure with it, so the line an operator read named a `ROLLBACK TO SAVEPOINT` that
 * could not run and said nothing about why the row was refused in the first place.
 *
 * Its own class rather than a plain `Error`, because the degrading decorator has to recognise it:
 * an `INFO` action may go on without its row only while the transaction is intact, and after a
 * failed rollback that is exactly what nobody knows. So this one is never softened, whatever the
 * severity — the caller's commit decides, and the trail does not claim a success it cannot see.
 */
export class AuditFenceRollbackError extends Error {
  constructor(action: SharedAudit.AuditAction, rollbackFailure: unknown, insertFailure: unknown) {
    super(
      `Audit row for ${action} could not be written, and the savepoint around it could not be ` +
        `rolled back afterwards (${describeFailure(rollbackFailure)}); the transaction is not known ` +
        'to be usable. The insert failure is the cause.',
      { cause: insertFailure },
    );
    this.name = 'AuditFenceRollbackError';
  }
}

const describeFailure = (failure: unknown): string =>
  failure instanceof Error ? `${failure.name}: ${failure.message}` : String(failure);

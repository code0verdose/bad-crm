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

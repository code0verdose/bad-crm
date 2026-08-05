import { AUDIT_ACTIONS, type AuditAction } from './audit-action.enums.js';

/**
 * How loudly an entry reads. Same three levels as the column
 * (`docs/security/permission-model.md` §10, «Что логируется всегда»).
 */
export const AUDIT_SEVERITIES = ['INFO', 'WARNING', 'CRITICAL'] as const;

export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

/**
 * The severity of an action, decided once per action rather than per call site.
 *
 * The document assigns severity to the *action*, not to the moment: «role.assigned» is a `warning`
 * wherever it is raised, and an ownership transfer is `critical` even when it is routine. Leaving it
 * to the caller would produce the failure that makes a severity column useless — the same event
 * filed at two levels depending on which use-case raised it, so a filter on «show me the critical
 * ones» silently misses half of them.
 *
 * `Record<AuditAction, …>` is what keeps it complete: an action added to the catalogue with no level
 * here does not compile.
 */
export const AUDIT_ACTION_SEVERITY: Readonly<Record<AuditAction, AuditSeverity>> = {
  // Creating an organization is the ordinary start of everything; loud only in aggregate.
  'organization.registered': 'INFO',
  'session.signed_in': 'INFO',
  // A session ending is routine; the interesting version of it — a family revoked because a token
  // was replayed — is a different record when that action exists.
  'session.revoked': 'INFO',
  // A credential changed: the event an incident review starts from when an account behaves oddly.
  'password.changed': 'WARNING',
  // Same, and reachable by whoever holds a mailbox rather than the old password.
  'password.reset': 'WARNING',
  // Who may do what changed. `warning` because it is the event an escalation review starts from:
  // §10 of the permission model files every change of rights at this level.
  'role.assigned': 'WARNING',
  'role.revoked': 'WARNING',
  // Row-level security deliberately bypassed. Nothing in normal operation raises it, and an
  // untraced bypass is indistinguishable from an intrusion.
  'rls.bypassed': 'CRITICAL',
};

/** The severity of an action, for a caller that has a validated action and nothing else. */
export const severityOf = (action: AuditAction): AuditSeverity => AUDIT_ACTION_SEVERITY[action];

/** Every action carries a level — the assertion the type already makes, for a runtime reader. */
export const AUDIT_ACTIONS_WITH_SEVERITY: readonly (readonly [AuditAction, AuditSeverity])[] =
  AUDIT_ACTIONS.map((action) => [action, AUDIT_ACTION_SEVERITY[action]] as const);

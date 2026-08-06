/**
 * What a privileged action is called in the audit trail.
 *
 * A closed list rather than free-form strings, for the same reason the permission catalogue is one:
 * an action named at a call site is an action nobody reviewed, and a typo opens a second name for
 * the same event — which a filter over the trail then silently misses. A new kind of privileged
 * action is added here deliberately, in the pull request that introduces it.
 *
 * The names are `<subject>.<verb>` in the past tense: the trail records what **happened**, not what
 * was attempted. An attempt that failed is a different record, and today it is not one this list
 * carries.
 */
export const AUDIT_ACTIONS = [
  /** An organization and its first owner were created (STORY-006-01). */
  'organization.registered',
  /** A credential was accepted and a session issued. */
  'session.signed_in',
  /** A session was ended by its owner, or revoked from the session list. */
  'session.revoked',
  /** A password was changed by the person who knew the old one. */
  'password.changed',
  /** A password was set through a recovery link. */
  'password.reset',
  /** A custom role was composed, recomposed or removed (STORY-011-03). */
  'role.created',
  'role.updated',
  'role.deleted',
  /**
   * A role was stored containing a key the catalogue marks dangerous.
   *
   * A second entry beside `role.created`/`role.updated` rather than the same one filed louder:
   * severity comes from the action and never from the call site, and «show me every time somebody
   * put `user:impersonate` into a role» is the question an escalation review actually asks — a
   * filter answers it, re-reading every composition does not.
   */
  'role.dangerous_granted',
  /** A role was given to somebody (STORY-011-04). */
  'role.assigned',
  /** A role was taken away, by an administrator or by the expiry of a temporary grant. */
  'role.revoked',
  /** A per-user exception was written, replaced or removed (STORY-011-05). */
  'permission.override.created',
  'permission.override.updated',
  'permission.override.deleted',
  /**
   * Row level security was bypassed on purpose — a migration path, a support action, a background
   * job that must see every tenant.
   *
   * The one entry here that records a *capability* rather than a change to data, and the reason the
   * trail exists at all for an installation whose operator can reach the database: an untraced
   * bypass is indistinguishable from an intrusion.
   */
  'rls.bypassed',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const AUDIT_ACTION_SET: ReadonlySet<string> = new Set<string>(AUDIT_ACTIONS);

export const isAuditAction = (value: string): value is AuditAction => AUDIT_ACTION_SET.has(value);

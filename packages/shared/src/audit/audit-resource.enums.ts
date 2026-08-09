/**
 * What a privileged action was done **to**, in the vocabulary of the trail.
 *
 * A closed list for the same reason the actions are one: `resourceType` is what a reader filters by
 * («everything that happened to this person»), and a second spelling of the same thing — `user` next
 * to `USER`, `session-family` next to `SESSION_FAMILY` — is a filter that silently misses half the
 * history. The names are the ones `docs/security/permission-model.md` §10 uses.
 *
 * Grows with the domains: a new kind of object joins this list in the release that introduces it.
 */
export const AUDIT_RESOURCE_TYPES = [
  'ORGANIZATION',
  'USER',
  /** One signed-in device — the refresh-token family, not a single rotation of it. */
  'SESSION_FAMILY',
  'SESSION',
  'ROLE',
  'USER_ROLE',
  'USER_PERMISSION_OVERRIDE',
  /** An invitation — a role assignment written in advance, and a credential until it is accepted. */
  'INVITATION',
  /** A team: an org-structure container, not a group of access (STORY-012-07, acceptance 10). */
  'TEAM',
] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

const AUDIT_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(AUDIT_RESOURCE_TYPES);

export const isAuditResourceType = (value: string): value is AuditResourceType =>
  AUDIT_RESOURCE_TYPE_SET.has(value);

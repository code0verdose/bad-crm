import { type SharedPermissions } from '@bad-crm/shared';

/**
 * One object, addressed the way `resource_acl` addresses it — by kind and id, without a foreign key.
 *
 * The polymorphic pair of `rules/polymorphic-access.mdc`, and the only shape the ACL layer knows an
 * object by. It never carries the object: an access reader hands back a scope, not an entity
 * (`rules/hexagonal-backend.mdc`, 6).
 */
export interface AclResourceRef {
  readonly type: SharedPermissions.AclResourceType;
  readonly id: string;
}

/** Who a grant is for — a person, a role or a team, by id. */
export interface AclSubjectRef {
  readonly type: SharedPermissions.AclSubjectType;
  readonly id: string;
}

/**
 * One node of the ancestor chain, tagged with how far up it sits.
 *
 * Depth 0 is the object itself; the last node is always the organization. The order is the whole
 * meaning of «ближайшая явная запись побеждает» (`permission-model.md`, «Правило разрешения
 * конфликтов», 1): the resolver reads entries on every node in one query and lets the smallest
 * depth decide.
 */
export interface AclChainNode extends AclResourceRef {
  readonly depth: number;
}

/**
 * One matching row, as the reader found it on the chain.
 *
 * Only the three facts the resolution rules read: where on the chain, what level, and until when.
 * Which subject matched — the person, a role they hold or a team they are on — is deliberately not
 * here: rule 2 takes the maximum across all of them and never asks which one it was.
 */
export interface AclEntryOnChain {
  readonly depth: number;
  readonly level: SharedPermissions.AccessLevel;
  readonly expiresAt: Date | null;
}

/** What a grant asks for: who, how much, and until when (`null` — for good). */
export interface AclGrantDraft {
  readonly subject: AclSubjectRef;
  readonly level: SharedPermissions.AccessLevel;
  readonly expiresAt: Date | null;
}

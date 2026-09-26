/**
 * What a `ResourceAcl` row may point at — on both ends.
 *
 * Source of truth: `docs/architecture/data-model.md`, «Полиморфные связи», the `ResourceAcl` row;
 * `docs/security/permission-model.md`, «Слой 4 — resource-scoped ACL».
 *
 * Both lists are **closed and complete**, and both mirror a PostgreSQL enum of the same name
 * (`acl_resource_type`, `acl_subject_type`), so a value outside them is refused by the database and
 * not only by a schema at the API boundary (`rules/polymorphic-access.mdc`, 2). Adding a value is
 * five steps in one pull request — the enum in a migration, this list, a branch in the chain
 * registry of `resolve-acl.query.ts`, a cascade in the deletion of the parent, and the integrity job
 * (`rules/polymorphic-access.mdc`, 7) — which is why the list lives here, where the client and the
 * server read the same one, rather than being retyped at each of those places.
 *
 * Not every type here has a chain today. The registry in `resolve-acl.query.ts` says which do, and
 * a type without one answers `unavailable` (503) rather than «resolved by the organization» — the
 * fail-closed answer `rules/permissions.mdc` 6 asks for.
 */
export const ACL_RESOURCE_TYPES = [
  /** The root of every chain — an org-wide grant. */
  'ORGANIZATION',
  'PROJECT',
  'BOARD',
  'TASK',
  'DOC_PAGE',
  'KB_SPACE',
  'KB_NOTE',
  'FILE',
  'FILE_FOLDER',
  'CHANNEL',
  'VAULT',
  'DASHBOARD',
] as const;

export type AclResourceType = (typeof ACL_RESOURCE_TYPES)[number];

const ACL_RESOURCE_TYPE_SET: ReadonlySet<string> = new Set<string>(ACL_RESOURCE_TYPES);

export const isAclResourceType = (value: string): value is AclResourceType =>
  ACL_RESOURCE_TYPE_SET.has(value);

/**
 * Whether the owner of the organization clears the level on this kind of object.
 *
 * The one family the model names as an exception is the vault: there access follows from holding a
 * `wrappedVaultKey`, no permission substitutes for a key, and `resolveAcl` does not read
 * `ResourceAcl` for it at all (`permission-model.md`, «Про `isOwner` и ACL»). Written as a total
 * map rather than as `type === 'VAULT'` so that a second vault-like type — a secure link, say —
 * cannot be added to the list above without an explicit decision here.
 */
export const ACL_RESOURCE_FAMILY: Readonly<Record<AclResourceType, 'standard' | 'vault'>> = {
  ORGANIZATION: 'standard',
  PROJECT: 'standard',
  BOARD: 'standard',
  TASK: 'standard',
  DOC_PAGE: 'standard',
  KB_SPACE: 'standard',
  KB_NOTE: 'standard',
  FILE: 'standard',
  FILE_FOLDER: 'standard',
  CHANNEL: 'standard',
  VAULT: 'vault',
  DASHBOARD: 'standard',
};

/**
 * Who a grant is for.
 *
 * All three are accepted by `POST /acl` (since 2026-09-26). The resolver's single query matches a
 * `ROLE` entry through `user_roles` and a `TEAM` entry through `team_members`, and deleting a
 * custom role or disbanding a team removes that subject's grants in the same transaction
 * (STORY-011-06 acceptance 13, STORY-012-07 acceptance 5).
 */
export const ACL_SUBJECT_TYPES = ['USER', 'ROLE', 'TEAM'] as const;

export type AclSubjectType = (typeof ACL_SUBJECT_TYPES)[number];

const ACL_SUBJECT_TYPE_SET: ReadonlySet<string> = new Set<string>(ACL_SUBJECT_TYPES);

export const isAclSubjectType = (value: string): value is AclSubjectType =>
  ACL_SUBJECT_TYPE_SET.has(value);

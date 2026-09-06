import { type SharedPermissions } from '@bad-crm/shared';

import { type AclResourceRef, type AclSubjectRef } from '@/domain/access/acl-chain.types.js';

/** One grant as stored — what the trail records as `before`, and what a revocation removes. */
export interface AclEntryRow {
  readonly id: string;
  readonly resource: AclResourceRef;
  readonly subject: AclSubjectRef;
  readonly level: SharedPermissions.AccessLevel;
  readonly expiresAt: Date | null;
  readonly grantedById: string | null;
}

export interface AclEntryDraft {
  readonly resource: AclResourceRef;
  readonly subject: AclSubjectRef;
  readonly level: SharedPermissions.AccessLevel;
  readonly expiresAt: Date | null;
  readonly grantedById: string;
}

/**
 * The grants of the current tenant, for the two commands that write them.
 *
 * Nothing here decides access — the resolver reads through `AclReaderPort`, and the policy decides.
 * What this port knows that the reader does not is the *subject*: whether it exists in this
 * organization, and which accounts it stands for. Both are facts the commands need and the
 * resolution never asks.
 */
export interface AclRepositoryPort {
  /** The current opinion about this subject on this object, or `null`. Read before writing, so the trail can say what changed. */
  find(resource: AclResourceRef, subject: AclSubjectRef): Promise<AclEntryRow | null>;

  /**
   * Writes or replaces — never a second row for the same pair (`uq_resource_acl`). Answers the id
   * of the row, so the trail can name it.
   */
  upsert(draft: AclEntryDraft): Promise<string>;

  /** `false` when there was nothing to remove — the same end state, and not an error. */
  remove(resource: AclResourceRef, subject: AclSubjectRef): Promise<boolean>;

  /**
   * Whether the subject exists **in this organization** — a live user, a role, a team that is not
   * disbanded. `false` is what the caller answers 404 to, never 403: the id of a team elsewhere
   * must not be confirmed by a grant that refuses differently from an unknown one.
   */
  subjectExists(subject: AclSubjectRef): Promise<boolean>;

  /**
   * The accounts a grant reaches: the person, everyone holding the role, everyone on the team.
   *
   * For the version bump of STORY-011-06 acceptance 1 — «инкрементится `permissions_version` всем
   * членам команды» — so that a cached view of rights is dropped for each of them on the next
   * request, in the same transaction as the grant.
   */
  subjectUserIds(subject: AclSubjectRef): Promise<readonly string[]>;

  /** One statement for the whole set, however large; a no-op for an empty one. */
  bumpPermissionsVersionOf(userIds: readonly string[]): Promise<void>;
}

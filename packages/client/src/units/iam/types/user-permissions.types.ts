import { type SharedPermissions } from '@bad-crm/shared';

/**
 * What the grouping needs of one permission, and no more.
 *
 * Declared here rather than taken from `api`, for the reason the org-chart types state next door:
 * `lib` may not import `api` (`test/architecture/layers.test.ts`), and assembling rows needs a key,
 * an origin and the roles behind it — anything carrying those can be assembled. The generated wire
 * type satisfies this structurally, so nothing is duplicated; the narrower interface is the honest
 * statement of what the function reads.
 *
 * `source` is `CapabilitySource` rather than a local union: the rungs are the shared ladder's, and
 * a copy of the list here would be a fourth place the permission model is written down.
 */
export interface PermissionStateFacts {
  readonly key: string;
  readonly source: SharedPermissions.CapabilitySource;
  /** Roles granting the key — **whatever the source is**, so «back to inherited» can be honest. */
  readonly roleIds: readonly string[];
  readonly override: OverrideFacts | null;
}

export interface OverrideFacts {
  readonly effect: 'ALLOW' | 'DENY';
  readonly reason: string;
  readonly grantedById: string | null;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
}

/** A role of the organization as the response names it — enough to turn a `roleId` into a word. */
export interface HeldRoleFacts {
  readonly roleId: string;
  readonly name: string;
}

/**
 * One line of the table: the server's answer, plus the two things the row draws that the answer
 * carries only as ids.
 *
 * `inheritedFrom` is the names behind `roleIds`, resolved against the `roles` of the **same**
 * response rather than against a directory fetched separately — the ids and the names arrive
 * together for exactly this reason (`permission-model.md` §7(ж)).
 */
export interface PermissionRow {
  readonly key: SharedPermissions.PermissionKey;
  readonly source: SharedPermissions.CapabilitySource;
  readonly override: OverrideFacts | null;
  readonly inheritedFrom: readonly string[];
  readonly dangerous: boolean;
}

/** The rows of one domain of the catalogue, in the catalogue's own order. */
export interface PermissionRowGroup {
  readonly domain: SharedPermissions.PermissionDomain;
  readonly rows: readonly PermissionRow[];
}

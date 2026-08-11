import { type UserPermissions } from '@/application/iam/use-cases/get-user-permissions.query.js';

/**
 * One exception as the wire carries it — the four facts the badge on screen shows.
 *
 * `grantedById` and not a name. Who wrote an exception is an id the client resolves against the
 * directory it already loaded for the same screen; putting a person's name in this body would put a
 * name into the response of an operation about permissions, and from there into every log line and
 * every cache that touches it (`rules/observability.mdc` §5).
 */
export interface PermissionOverrideFactsResponse {
  readonly effect: 'ALLOW' | 'DENY';
  readonly reason: string;
  readonly grantedById: string | null;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
}

export interface PermissionStateResponse {
  readonly key: string;
  readonly allowed: boolean;
  readonly source: string;
  readonly roleIds: readonly string[];
  readonly override: PermissionOverrideFactsResponse | null;
}

export interface UserPermissionsResponse {
  readonly userId: string;
  readonly isOwner: boolean;
  readonly version: number;
  readonly roles: readonly {
    readonly roleId: string;
    readonly key: string;
    readonly name: string;
  }[];
  readonly permissions: readonly PermissionStateResponse[];
}

/**
 * The effective permissions of one person → the schema of `docs/api/openapi.yaml`.
 *
 * Dates become ISO strings here rather than in the query, for the reason every serializer in this
 * folder exists: `application` answers in domain values and knows nothing about the wire, and a
 * `Date` that reached `res.json` would be serialised by whatever `JSON.stringify` happens to do
 * rather than by a decision anybody made.
 *
 * Nothing is dropped and nothing is computed. The catalogue metadata a client needs to render this —
 * whether a key is `dangerous`, whether it carries a `requiredLevel`, what to call it — is imported
 * from `@bad-crm/shared` on both sides, so sending it per key would be several kilobytes of a
 * constant the client already has.
 */
export const serializeUserPermissions = (
  permissions: UserPermissions,
): UserPermissionsResponse => ({
  userId: permissions.userId,
  isOwner: permissions.isOwner,
  version: permissions.version,
  roles: permissions.roles.map((role) => ({
    roleId: role.roleId,
    key: role.key,
    name: role.name,
  })),
  permissions: permissions.permissions.map((state) => ({
    key: state.key,
    allowed: state.allowed,
    source: state.source,
    roleIds: [...state.roleIds],
    override:
      state.override === null
        ? null
        : {
            effect: state.override.effect,
            reason: state.override.reason,
            grantedById: state.override.grantedById,
            grantedAt: state.override.grantedAt.toISOString(),
            expiresAt: state.override.expiresAt?.toISOString() ?? null,
          },
  })),
});

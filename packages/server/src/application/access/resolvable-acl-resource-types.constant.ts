import { type SharedPermissions } from '@bad-crm/shared';

/**
 * The kinds of object whose ancestor chain the resolver can build today — and therefore the only
 * kinds a grant can be read, written or revoked on over HTTP.
 *
 * One list for two readers. `ResolveAclQuery` keys its registry of chains by it (a `Record`, so a
 * kind listed here without a builder does not compile, and a builder without a line here is an
 * excess property), and `acl.validator.ts` takes its `resourceType` whitelist from it — so a request
 * about a kind nobody can resolve is a `422` at the boundary, not a `503` from the resolver that a
 * client would retry forever. The shared catalogue (`ACL_RESOURCE_TYPES`) names all twelve kinds
 * the table accepts; this is the subset a domain has made real, and it grows with the domains —
 * the board's chain adds `BOARD` here and to the `enum` of `AclResourceType` in `openapi.yaml` in
 * the same delta (`test/contract/acl-resource-types.test.ts` holds the two together).
 */
export const RESOLVABLE_ACL_RESOURCE_TYPES = [
  'ORGANIZATION',
  'PROJECT',
] as const satisfies readonly SharedPermissions.AclResourceType[];

export type ResolvableAclResourceType = (typeof RESOLVABLE_ACL_RESOURCE_TYPES)[number];

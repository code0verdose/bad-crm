import { type AclChainNode, type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';

/**
 * The one read the resolution rules need: every live grant for this person on any node of a chain.
 *
 * **One round trip, whatever the depth** (STORY-011-06, acceptance 8). The chain arrives as values,
 * the adapter joins them against `resource_acl` in a single statement, and what comes back is the
 * matching rows tagged with the depth of the node each sits on. Which subjects match — the person,
 * the roles they hold, the teams they are on — is resolved inside that same statement; the port does
 * not ask the caller for role or team ids, because a caller that had to supply them would have made
 * two more queries to do so.
 *
 * Not an access reader in the sense of `rules/hexagonal-backend.mdc` 6: it returns no scope and
 * decides nothing. The rules — closest node, `NONE`, maximum, expiry — are
 * `domain/access/acl-resolution.policy.ts`'s, and the rows come back unreduced so that they are
 * applied in one place. Expired rows are filtered by the statement as well; the policy filters
 * again, and that second filter is the rule.
 *
 * No `organizationId` parameter, for the reason every persistence port gives: the tenant is the
 * scope the caller opened, and a second answer to that question is one the policy filters
 * silently rather than refusing.
 */
export interface AclReaderPort {
  entriesAlong(chain: readonly AclChainNode[], userId: string): Promise<readonly AclEntryOnChain[]>;
}

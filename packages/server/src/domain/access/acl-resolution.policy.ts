import { SharedPermissions } from '@bad-crm/shared';

import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';

/**
 * The level one actor holds on one object, from the entries found on its ancestor chain —
 * `docs/security/permission-model.md`, «Правило разрешения конфликтов (нормативно)», rules 1–4:
 *
 * 1. **the closest explicit entry wins** — the walk stops at the first node that has one;
 * 2. **on that node, `NONE` beats everything, otherwise the maximum** across the matched subjects;
 * 3. **an expired entry is absent** (`expiresAt <= now`);
 * 4. **no entry on the whole chain → the implicit level** (`implicit-level.policy.ts`).
 *
 * Rules 5 and 6 are not here, and not by omission. The owner (5) is cleared by `authorizeResource`,
 * which also knows the family of the object; a broken chain (6) is answered by the resolver with
 * `missing` — a 404 — before this function is reached, so «resolve by the organization» cannot
 * happen by falling through.
 *
 * **Expiry is filtered here as well as in the query.** The reader's `expires_at > now()` keeps
 * the rows it returns equal to what a query of the table would show; this one is the rule, and
 * the rule is what the table-driven test proves. The two use different clocks (the database's and
 * `ClockPort`'s), and the second filter is what makes a row that expired between the two reads
 * count as expired rather than as live.
 *
 * Pure: no I/O, no clock of its own — the moment is an argument, which is what lets the test say
 * «one second ago» exactly.
 */
export const resolveFromChain = (
  entries: readonly AclEntryOnChain[],
  implicit: SharedPermissions.AccessLevel,
  now: Date,
): SharedPermissions.AccessLevel => {
  const live = entries.filter(
    (entry) => entry.expiresAt === null || entry.expiresAt.getTime() > now.getTime(),
  );

  if (live.length === 0) return implicit;

  const closest = Math.min(...live.map((entry) => entry.depth));
  const atNode = live.filter((entry) => entry.depth === closest);

  if (atNode.some((entry) => entry.level === 'NONE')) return 'NONE';

  return atNode.reduce<SharedPermissions.AccessLevel>(
    (best, entry) => (SharedPermissions.atLeast(entry.level, best) ? entry.level : best),
    'NONE',
  );
};

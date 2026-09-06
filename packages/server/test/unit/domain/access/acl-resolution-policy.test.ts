import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { resolveFromChain } from '@/domain/access/acl-resolution.policy.js';

/**
 * «Правило разрешения конфликтов (нормативно)», `docs/security/permission-model.md`, «Наследование
 * ACL» — the four rules a pure function can hold. Rule 5 (the owner) is `authorizeResource`'s, and
 * rule 6 (a broken chain) is answered before this function is called: the resolver returns
 * `missing`, which is a 404, and never «resolve by the organization».
 *
 * The entries arrive as the reader found them — every live row matching the subject anywhere on
 * the chain, tagged with the depth of the node it sits on. The function does not know what the
 * nodes are; it knows only that a smaller depth is closer.
 */

const NOW = new Date('2026-09-06T12:00:00Z');

const entry = (
  depth: number,
  level: SharedPermissions.AccessLevel,
  expiresAt: Date | null = null,
): AclEntryOnChain => ({ depth, level, expiresAt });

describe('resolveFromChain — rule 1: the closest explicit entry wins', () => {
  it('stops at the first node with an entry, ignoring everything above it', () => {
    // PROJECT → TEAM=backend → EDITOR (depth 1); DOC_PAGE → USER=ivan → VIEWER (depth 0).
    expect(resolveFromChain([entry(1, 'EDITOR'), entry(0, 'VIEWER')], 'NONE', NOW)).toBe('VIEWER');
  });

  it('gives the closer EDITOR over a farther VIEWER — the reverse layout of acceptance 2', () => {
    expect(resolveFromChain([entry(1, 'VIEWER'), entry(0, 'EDITOR')], 'NONE', NOW)).toBe('EDITOR');
  });

  it('does not depend on the order the rows arrive in', () => {
    expect(resolveFromChain([entry(0, 'VIEWER'), entry(1, 'EDITOR')], 'NONE', NOW)).toBe('VIEWER');
  });

  it('walks past an empty node to the next one that has entries', () => {
    // Nothing at depth 0 and 1; the grant on the organization (depth 2) is the closest there is.
    expect(resolveFromChain([entry(2, 'COMMENTER')], 'NONE', NOW)).toBe('COMMENTER');
  });
});

describe('resolveFromChain — rule 2: on one node, NONE beats everything, otherwise the maximum', () => {
  it('takes the maximum across the subjects matched on the closest node', () => {
    // TEAM → EDITOR and USER → VIEWER on the same node (acceptance 4).
    expect(resolveFromChain([entry(0, 'EDITOR'), entry(0, 'VIEWER')], 'NONE', NOW)).toBe('EDITOR');
  });

  it('lets a NONE on the node refuse, whatever else the node grants', () => {
    expect(resolveFromChain([entry(0, 'MANAGER'), entry(0, 'NONE')], 'MANAGER', NOW)).toBe('NONE');
  });

  it('applies NONE to the subtree: a NONE on the parent is the answer for the child', () => {
    // KB_SPACE → USER=ivan → NONE (depth 1) while the project (depth 2) grants EDITOR.
    expect(resolveFromChain([entry(2, 'EDITOR'), entry(1, 'NONE')], 'EDITOR', NOW)).toBe('NONE');
  });

  it('does not let a NONE on a farther node reach past a closer grant', () => {
    expect(resolveFromChain([entry(0, 'VIEWER'), entry(1, 'NONE')], 'NONE', NOW)).toBe('VIEWER');
  });
});

describe('resolveFromChain — rule 3: an expired entry is treated as absent', () => {
  it('ignores an entry that expired a second ago', () => {
    const expired = new Date(NOW.getTime() - 1_000);

    expect(resolveFromChain([entry(0, 'MANAGER', expired)], 'VIEWER', NOW)).toBe('VIEWER');
  });

  it('treats the exact moment of expiry as expired — `expiresAt <= now()`', () => {
    expect(resolveFromChain([entry(0, 'MANAGER', NOW)], 'VIEWER', NOW)).toBe('VIEWER');
  });

  it('keeps an entry that expires in the future', () => {
    const later = new Date(NOW.getTime() + 1_000);

    expect(resolveFromChain([entry(0, 'MANAGER', later)], 'VIEWER', NOW)).toBe('MANAGER');
  });

  it('lets an expired NONE stop refusing — the closest live node decides', () => {
    const expired = new Date(NOW.getTime() - 1_000);

    expect(resolveFromChain([entry(0, 'NONE', expired), entry(1, 'EDITOR')], 'NONE', NOW)).toBe(
      'EDITOR',
    );
  });
});

describe('resolveFromChain — rule 4: no entry on the whole chain → implicitLevel', () => {
  it.each<SharedPermissions.AccessLevel>(['NONE', 'VIEWER', 'COMMENTER', 'EDITOR', 'MANAGER'])(
    'answers the implicit level %s when there are no entries at all',
    (implicit) => {
      expect(resolveFromChain([], implicit, NOW)).toBe(implicit);
    },
  );

  /**
   * The implicit level is **not** a floor under the explicit ones: a project member with implicit
   * `EDITOR` who is explicitly granted `VIEWER` on a document gets `VIEWER` there. Otherwise no
   * grant could ever narrow what membership gives, and the whole point of a closer entry is lost.
   */
  it('is replaced, not combined, when an explicit entry exists', () => {
    expect(resolveFromChain([entry(0, 'VIEWER')], 'EDITOR', NOW)).toBe('VIEWER');
  });
});

describe('resolveFromChain — purity', () => {
  it('leaves the input untouched', () => {
    const entries = [entry(1, 'EDITOR'), entry(0, 'VIEWER')];
    const copy = entries.map((row) => ({ ...row }));

    resolveFromChain(entries, 'NONE', NOW);

    expect(entries).toEqual(copy);
  });
});

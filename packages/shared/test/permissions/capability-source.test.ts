import { describe, expect, it } from 'vitest';

import type { CapabilityView, PermissionKey } from '../../src/permissions/index.js';
import {
  CAPABILITY_SOURCES,
  capabilityOutcome,
  capabilitySource,
  effectivePermission,
  outcomeAllows,
  sourceAllows,
} from '../../src/permissions/index.js';

/**
 * The layer that decided, reported without deciding a second time.
 *
 * The administration screen of STORY-011-11 shows every permission with its origin — granted by a
 * role, granted by a personal exception, taken away by one, or never granted at all. The danger the
 * whole file exists to remove is a *second* implementation written for that screen: two ladders
 * agree the day they are written and disagree the day one of them is edited, and the screen would
 * then lie to the administrator at exactly the moment it is consulted.
 *
 * So the ladder is one function, and both the boolean and the origin are derived from it. What the
 * last suite below asserts is the property that makes the derivation safe: attribution splits the
 * granted branch in two and **never** moves an answer across the allow/deny line.
 */

const ORG_READ: PermissionKey = 'organization:read';

const view = (input: Partial<CapabilityView> = {}): CapabilityView => ({
  isOwner: false,
  permissions: new Set<PermissionKey>(),
  denied: new Set<PermissionKey>(),
  ...input,
});

const none: ReadonlySet<PermissionKey> = new Set<PermissionKey>();
const byOverride: ReadonlySet<PermissionKey> = new Set<PermissionKey>([ORG_READ]);

/**
 * The capability half of the truth table in `docs/security/permission-model.md` §5 — rows 1–5, 10,
 * 11 and 14, which are the ones decided before any resource is consulted.
 */
const CASES = [
  {
    name: 'row 2 — a role grants it and no exception says otherwise',
    view: view({ permissions: new Set([ORG_READ]) }),
    allowedByOverride: none,
    source: 'ROLE',
    allowed: true,
  },
  {
    name: 'row 4 — nothing but an ALLOW exception grants it',
    view: view({ permissions: new Set([ORG_READ]) }),
    allowedByOverride: byOverride,
    source: 'OVERRIDE_ALLOW',
    allowed: true,
  },
  {
    name: 'row 3 — a DENY exception beats the role that grants it',
    view: view({ permissions: new Set([ORG_READ]), denied: new Set([ORG_READ]) }),
    allowedByOverride: none,
    source: 'OVERRIDE_DENY',
    allowed: false,
  },
  {
    name: 'row 1 — nobody granted it',
    view: view(),
    allowedByOverride: none,
    source: 'NOT_GRANTED',
    allowed: false,
  },
  {
    name: 'row 14 — a DENY row on the owner is an anomaly the owner outranks',
    view: view({ isOwner: true, denied: new Set([ORG_READ]) }),
    allowedByOverride: none,
    source: 'OWNER',
    allowed: true,
  },
  {
    name: 'the owner short-circuits an empty permission set',
    view: view({ isOwner: true }),
    allowedByOverride: none,
    source: 'OWNER',
    allowed: true,
  },
] as const;

describe('capabilitySource()', () => {
  it.each(CASES)('$name', ({ view: capability, allowedByOverride, source, allowed }) => {
    expect(capabilitySource(capability, ORG_READ, allowedByOverride)).toBe(source);
    expect(sourceAllows(capabilitySource(capability, ORG_READ, allowedByOverride))).toBe(allowed);
  });

  it('names every source it can return, so a new branch cannot go unlisted', () => {
    const returned = new Set(
      CASES.map((testCase) =>
        capabilitySource(testCase.view, ORG_READ, testCase.allowedByOverride),
      ),
    );

    expect([...returned].toSorted()).toEqual([...CAPABILITY_SOURCES].toSorted());
  });
});

/**
 * The property that lets one ladder serve both callers.
 *
 * Attribution is reporting: whether the grant arrived through a role or through an exception is not
 * a fact any decision may turn on. If this ever fails, the explain screen has become a second
 * authorization path, which is what invariant 2 of CLAUDE.md forbids.
 */
describe('attribution is decision-neutral', () => {
  const VIEWS = [
    view(),
    view({ isOwner: true }),
    view({ permissions: new Set([ORG_READ]) }),
    view({ denied: new Set([ORG_READ]) }),
    view({ permissions: new Set([ORG_READ]), denied: new Set([ORG_READ]) }),
    view({ isOwner: true, permissions: new Set([ORG_READ]), denied: new Set([ORG_READ]) }),
    // The two shapes missing until now: an owner who also happens to hold a grant, and an owner
    // with nothing but a DENY row against them. Both are decided on the same branch as every other
    // owner view — ownership short-circuits before either set is consulted — so this is coverage
    // completing the claim `can.util.ts` makes about `capabilitySource`, not a new behaviour.
    view({ isOwner: true, permissions: new Set([ORG_READ]) }),
    view({ isOwner: true, denied: new Set([ORG_READ]) }),
  ];

  it.each(VIEWS.map((capability, index) => [index, capability] as const))(
    'view %i answers the same whether or not attribution is supplied',
    (_index, capability) => {
      const decided = effectivePermission(capability, ORG_READ);

      expect(sourceAllows(capabilitySource(capability, ORG_READ, none))).toBe(decided);
      expect(sourceAllows(capabilitySource(capability, ORG_READ, byOverride))).toBe(decided);
      expect(outcomeAllows(capabilityOutcome(capability, ORG_READ))).toBe(decided);
    },
  );
});

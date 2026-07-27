import { describe, expect, it } from 'vitest';

import type { AccessLevel, CapabilityView, PermissionKey } from '../../src/permissions/index.js';
import { can, effectivePermission } from '../../src/permissions/index.js';

const view = (input: Partial<CapabilityView> = {}): CapabilityView => ({
  isOwner: false,
  permissions: new Set<PermissionKey>(),
  denied: new Set<PermissionKey>(),
  ...input,
});

/** `organization:update` needs MANAGER; `organization:read` needs no resource context. */
const ORG_UPDATE: PermissionKey = 'organization:update';
const ORG_READ: PermissionKey = 'organization:read';

interface Case {
  readonly name: string;
  readonly view: CapabilityView;
  readonly key: string;
  readonly level?: AccessLevel;
  readonly expected: boolean;
}

const CASES: Case[] = [
  {
    name: 'owner bypasses roles and overrides',
    view: view({ isOwner: true }),
    key: ORG_READ,
    expected: true,
  },
  {
    name: 'a DENY override beats a granted role, even for a resource-free key',
    view: view({ permissions: new Set([ORG_READ]), denied: new Set([ORG_READ]) }),
    key: ORG_READ,
    expected: false,
  },
  {
    name: 'a granted capability without a resource requirement is enough',
    view: view({ permissions: new Set([ORG_READ]) }),
    key: ORG_READ,
    expected: true,
  },
  {
    name: 'no capability at all is a deny (fail closed)',
    view: view(),
    key: ORG_READ,
    expected: false,
  },
  {
    name: 'a resource-scoped key with a sufficient ACL level is allowed',
    view: view({ permissions: new Set([ORG_UPDATE]) }),
    key: ORG_UPDATE,
    level: 'MANAGER',
    expected: true,
  },
  {
    name: 'a resource-scoped key with too low an ACL level is denied (conjunction, not disjunction)',
    view: view({ permissions: new Set([ORG_UPDATE]) }),
    key: ORG_UPDATE,
    level: 'EDITOR',
    expected: false,
  },
  {
    name: 'a resource-scoped key with no level passed is denied, never assumed',
    view: view({ permissions: new Set([ORG_UPDATE]) }),
    key: ORG_UPDATE,
    expected: false,
  },
  {
    name: 'an ACL level without the capability is denied',
    view: view(),
    key: ORG_UPDATE,
    level: 'MANAGER',
    expected: false,
  },
  {
    name: 'an unknown key is denied, so a typo never opens access',
    view: view({ isOwner: true }),
    key: 'organization:reed',
    expected: false,
  },
  {
    name: 'owner still needs the ACL level of a resource-scoped key',
    view: view({ isOwner: true }),
    key: ORG_UPDATE,
    level: 'VIEWER',
    expected: false,
  },
];

describe('can()', () => {
  it.each(CASES)('$name', ({ view: capability, key, level, expected }) => {
    expect(can(capability, key, level)).toBe(expected);
  });
});

describe('effectivePermission()', () => {
  it.each([
    ['owner', view({ isOwner: true }), true],
    [
      'denied override',
      view({ permissions: new Set([ORG_READ]), denied: new Set([ORG_READ]) }),
      false,
    ],
    ['granted by role', view({ permissions: new Set([ORG_READ]) }), true],
    ['nothing granted', view(), false],
  ] as const)('%s', (_name, capability, expected) => {
    expect(effectivePermission(capability, ORG_READ)).toBe(expected);
  });
});

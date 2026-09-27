import { describe, expect, it } from 'vitest';

import { type SharedPermissions } from '@bad-crm/shared';

import { type AclEntryOnChain } from '@/domain/access/acl-chain.types.js';
import { type Actor } from '@/domain/access/actor.types.js';
import {
  readsProjectUnder,
  visibilityImpact,
  type ProjectAudienceSeat,
} from '@/domain/project/access/visibility-impact.policy.js';
import { type ProjectRole } from '@/domain/project/project.enums.js';

/**
 * How many colleagues a change of visibility takes a project away from, or hands it to
 * (STORY-014-01, acceptance 7) — decided seat by seat by **the read decision itself**.
 *
 * Every seat below is one colleague with one combination the model distinguishes: on the project or
 * not, a grant on the project node or on the organization node, expired or live, `NONE` or a level,
 * a guest, the owner, a DENY exception on `project:read`, no `project:read` at all. For each the
 * table states by hand whether they read the project under `PUBLIC_ORG` and under `PRIVATE`; the
 * policy is held to that table, and the impact to the set difference of its two columns — so a
 * count that agreed with itself but not with the read decision fails with the seat named.
 */

const ORG = '018f4a3b-0000-7000-8000-0000000000a1';
const PROJECT = '018f4a3b-0000-7000-8000-0000000000b1';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const PAST = new Date('2026-09-27T11:59:59.000Z');
const FUTURE = new Date('2026-09-28T12:00:00.000Z');

const actorOf = (userId: string, overrides: Partial<Actor> = {}): Actor => ({
  userId,
  organizationId: ORG,
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['project:read']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: ['developer'],
  ...overrides,
});

const onProject = (
  level: SharedPermissions.AccessLevel,
  expiresAt: Date | null = null,
): AclEntryOnChain => ({ depth: 0, level, expiresAt });

const onOrganization = (
  level: SharedPermissions.AccessLevel,
  expiresAt: Date | null = null,
): AclEntryOnChain => ({ depth: 1, level, expiresAt });

interface Row {
  readonly who: string;
  readonly seat: ProjectAudienceSeat;
  /** Reads the project while it is `PUBLIC_ORG` — written by hand, not computed. */
  readonly publicly: boolean;
  /** Reads it once it is `PRIVATE`. */
  readonly privately: boolean;
}

let ids = 0;

const seat = (
  memberRole: ProjectRole | null,
  entries: readonly AclEntryOnChain[] = [],
  actor: Partial<Actor> = {},
): ProjectAudienceSeat => {
  ids += 1;

  return {
    actor: actorOf(`018f4a3b-0000-7000-8000-${String(ids).padStart(12, '0')}`, actor),
    memberRole,
    entries,
  };
};

const ROWS: readonly Row[] = [
  { who: 'a bystander', seat: seat(null), publicly: true, privately: false },
  { who: 'the lead', seat: seat('LEAD'), publicly: true, privately: true },
  { who: 'an observer', seat: seat('OBSERVER'), publicly: true, privately: true },
  {
    who: 'a bystander with VIEWER on the project',
    seat: seat(null, [onProject('VIEWER')]),
    publicly: true,
    privately: true,
  },
  {
    who: 'a bystander whose VIEWER on the project has expired',
    seat: seat(null, [onProject('VIEWER', PAST)]),
    publicly: true,
    privately: false,
  },
  {
    who: 'a bystander with a VIEWER on the project that expires tomorrow',
    seat: seat(null, [onProject('VIEWER', FUTURE)]),
    publicly: true,
    privately: true,
  },
  {
    who: 'a bystander with VIEWER on the organization',
    seat: seat(null, [onOrganization('VIEWER')]),
    publicly: true,
    privately: true,
  },
  {
    who: 'a bystander closed out of the project by NONE',
    seat: seat(null, [onProject('NONE')]),
    publicly: false,
    privately: false,
  },
  {
    who: 'a colleague closed out of the whole organization, opened on the project',
    seat: seat(null, [onOrganization('NONE'), onProject('VIEWER')]),
    publicly: true,
    privately: true,
  },
  {
    who: 'a bystander closed out of the whole organization',
    seat: seat(null, [onOrganization('NONE')]),
    publicly: false,
    privately: false,
  },
  {
    who: 'a guest without a grant',
    seat: seat(null, [], { roleKeys: ['guest'] }),
    publicly: false,
    privately: false,
  },
  {
    who: 'a guest with VIEWER on the project',
    seat: seat(null, [onProject('VIEWER')], { roleKeys: ['guest'] }),
    publicly: true,
    privately: true,
  },
  {
    who: 'the owner, on nothing',
    seat: seat(null, [onProject('NONE')], {
      isOwner: true,
      permissions: new Set(),
      roleKeys: ['owner'],
    }),
    publicly: true,
    privately: true,
  },
  {
    who: 'a bystander refused project:read by an exception',
    seat: seat(null, [], {
      denied: new Set<SharedPermissions.PermissionKey>(['project:read']),
    }),
    publicly: false,
    privately: false,
  },
  {
    who: 'a bystander who never held project:read',
    seat: seat(null, [], { permissions: new Set() }),
    publicly: false,
    privately: false,
  },
];

const project = (visibility: 'PUBLIC_ORG' | 'PRIVATE') => ({
  projectId: PROJECT,
  organizationId: ORG,
  visibility,
});

describe('readsProjectUnder — the read decision, for one colleague and one visibility', () => {
  it.each(ROWS)('$who', async ({ seat: row, publicly, privately }) => {
    expect(await readsProjectUnder(row, project('PUBLIC_ORG'), NOW)).toBe(publicly);
    expect(await readsProjectUnder(row, project('PRIVATE'), NOW)).toBe(privately);
  });
});

describe('visibilityImpact — the set difference of the two columns', () => {
  const seats = ROWS.map((row) => row.seat);
  const count = (predicate: (row: Row) => boolean): number => ROWS.filter(predicate).length;

  it('closing a public project: who reads it now and will not', async () => {
    const impact = await visibilityImpact(
      seats,
      { ...project('PUBLIC_ORG'), visibility: 'PUBLIC_ORG' },
      'PRIVATE',
      NOW,
    );

    // Two by hand: the bystander and the one whose grant has expired.
    expect(impact).toEqual({ losingAccess: 2, gainingAccess: 0 });
    expect(impact.losingAccess).toBe(count((row) => row.publicly && !row.privately));
  });

  it('opening a private project: who does not read it now and will', async () => {
    const impact = await visibilityImpact(seats, project('PRIVATE'), 'PUBLIC_ORG', NOW);

    expect(impact).toEqual({ losingAccess: 0, gainingAccess: 2 });
    expect(impact.gainingAccess).toBe(count((row) => !row.privately && row.publicly));
  });

  it('asks nothing of anybody when the visibility would not move', async () => {
    expect(await visibilityImpact(seats, project('PRIVATE'), 'PRIVATE', NOW)).toEqual({
      losingAccess: 0,
      gainingAccess: 0,
    });
  });

  it('counts nobody in an empty organization', async () => {
    expect(await visibilityImpact([], project('PUBLIC_ORG'), 'PRIVATE', NOW)).toEqual({
      losingAccess: 0,
      gainingAccess: 0,
    });
  });
});

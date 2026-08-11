import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { type PermissionStateFacts } from '@units/iam/types';

import { permissionRows } from './permission-rows.util.js';

/**
 * The rows of the permissions tab: ordering, grouping, filtering, and the names behind `roleIds`.
 *
 * What is asserted here is everything the screen adds to the answer — and, just as importantly,
 * everything it does **not**: `source` is copied through untouched. A test that recomputed the
 * expected source from `override`/`roleIds` would be a second capability ladder living in the
 * suite, which is the failure `permission-model.md` §«Слой 5» names.
 */

const MANAGER = '018f0000-0000-7000-8000-00000000ma01';
const DEVELOPER = '018f0000-0000-7000-8000-00000000de01';

const ROLES = [
  { roleId: MANAGER, name: 'Manager' },
  { roleId: DEVELOPER, name: 'Developer' },
];

/** Every key of the catalogue as the server reports it when nobody granted anything. */
const nothingGranted = (): PermissionStateFacts[] =>
  SharedPermissions.PERMISSIONS.map((key) => ({
    key,
    source: 'NOT_GRANTED' as const,
    roleIds: [],
    override: null,
  }));

const withState = (
  key: string,
  patch: Partial<PermissionStateFacts>,
): readonly PermissionStateFacts[] =>
  nothingGranted().map((state) => (state.key === key ? { ...state, ...patch } : state));

const rowFor = (
  groups: ReturnType<typeof permissionRows>,
  key: string,
): { source: string; inheritedFrom: readonly string[] } | undefined =>
  groups.flatMap((group) => group.rows).find((row) => row.key === key);

const build = (
  permissions: readonly PermissionStateFacts[],
  options: { search?: string; exceptionsOnly?: boolean } = {},
): ReturnType<typeof permissionRows> =>
  permissionRows({
    permissions,
    roles: ROLES,
    search: options.search ?? '',
    exceptionsOnly: options.exceptionsOnly ?? false,
  });

describe('the rows of the permissions tab', () => {
  it('CONTROL: the catalogue is not empty, so every case below is about something', () => {
    expect(SharedPermissions.PERMISSIONS.length).toBeGreaterThan(100);
    expect(build(nothingGranted()).flatMap((group) => group.rows)).toHaveLength(
      SharedPermissions.PERMISSIONS.length,
    );
  });

  it('reports the source the server sent, whatever the row looks like', () => {
    // The pairing that makes the point: an ALLOW-shaped override under a source of `OWNER`. It is
    // the anomaly `openapi.yaml` describes — a DENY written before the trigger existed, restored
    // from an old dump — and a screen that recomputed the source would quietly disagree with the
    // server about who this person is.
    const groups = build(
      withState('task:update', {
        source: 'OWNER',
        roleIds: [DEVELOPER],
        override: {
          effect: 'DENY',
          reason: 'written before the trigger existed',
          grantedById: null,
          grantedAt: '2026-01-01T00:00:00.000Z',
          expiresAt: null,
        },
      }),
    );

    expect(rowFor(groups, 'task:update')?.source).toBe('OWNER');
  });

  it('names the roles behind roleIds, so «back to inherited» can say what it would restore', () => {
    const groups = build(
      withState('task:update', { source: 'ROLE', roleIds: [MANAGER, DEVELOPER] }),
    );

    expect(rowFor(groups, 'task:update')?.inheritedFrom).toEqual(['Manager', 'Developer']);
  });

  it('keeps roleIds under a DENY — the two futures are different and both have to be sayable', () => {
    const denied = withState('task:update', {
      source: 'OVERRIDE_DENY',
      roleIds: [MANAGER],
      override: {
        effect: 'DENY',
        reason: 'handed billing to somebody else',
        grantedById: null,
        grantedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: null,
      },
    });

    // Under a DENY the roles are being overruled — and are exactly what lifting it would restore.
    expect(rowFor(build(denied), 'task:update')?.inheritedFrom).toEqual(['Manager']);

    // CONTROL, the other future: same source, no role behind it.
    const orphaned = withState('task:update', {
      source: 'OVERRIDE_DENY',
      roleIds: [],
      override: {
        effect: 'DENY',
        reason: 'handed billing to somebody else',
        grantedById: null,
        grantedAt: '2026-08-01T00:00:00.000Z',
        expiresAt: null,
      },
    });

    expect(rowFor(build(orphaned), 'task:update')?.inheritedFrom).toEqual([]);
  });

  it('drops a role id the response does not name, rather than rendering a uuid', () => {
    const groups = build(
      withState('task:update', { source: 'ROLE', roleIds: ['role-nobody-sent'] }),
    );

    expect(rowFor(groups, 'task:update')?.inheritedFrom).toEqual([]);
  });

  it('drops a key this build does not know — the control would write back a 422', () => {
    const groups = build([
      ...nothingGranted(),
      { key: 'chimera:invent', source: 'ROLE', roleIds: [MANAGER], override: null },
    ]);

    expect(rowFor(groups, 'chimera:invent')).toBeUndefined();
    // CONTROL: the sweep did run over a populated list.
    expect(rowFor(groups, 'task:update')).toBeDefined();
  });

  it('narrows by substring of the key, case-insensitively', () => {
    const groups = build(nothingGranted(), { search: '  TASK:UP ' });
    const keys = groups.flatMap((group) => group.rows).map((row) => row.key);

    expect(keys).toContain('task:update');
    expect(keys.every((key) => key.includes('task:up'))).toBe(true);
    // CONTROL: the unfiltered set is much larger, so the assertion above is not true of everything.
    expect(keys.length).toBeLessThan(SharedPermissions.PERMISSIONS.length);
  });

  it('keeps only the keys carrying an exception when asked', () => {
    const groups = build(
      withState('task:update', {
        source: 'OVERRIDE_ALLOW',
        roleIds: [],
        override: {
          effect: 'ALLOW',
          reason: 'covering for the manager on leave',
          grantedById: null,
          grantedAt: '2026-08-01T00:00:00.000Z',
          expiresAt: '2026-09-01T00:00:00.000Z',
        },
      }),
      { exceptionsOnly: true },
    );

    expect(groups.flatMap((group) => group.rows).map((row) => row.key)).toEqual(['task:update']);
  });

  it('groups by domain and leaves out the domains the filters emptied', () => {
    const groups = build(nothingGranted(), { search: 'vault_item:' });

    expect(groups.map((group) => group.domain)).toEqual(['vault']);
    expect(groups[0]?.rows.length).toBeGreaterThan(0);
  });

  it('marks the dangerous keys, because a red word is the only warning before a click', () => {
    const groups = build(nothingGranted());
    const rows = groups.flatMap((group) => group.rows);

    expect(rows.find((row) => row.key === 'audit:export')?.dangerous).toBe(true);
    // CONTROL: not everything is dangerous, or the flag would say nothing.
    expect(rows.find((row) => row.key === 'task:read')?.dangerous).toBe(false);
  });
});

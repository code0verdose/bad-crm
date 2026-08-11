import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { GetUserPermissionsQuery } from '@/application/iam/use-cases/get-user-permissions.query.js';
import { type Actor } from '@/domain/access/actor.types.js';

import { FakeEffectivePermissionsReader } from '../../support/iam-doubles.util.js';
import { FakeAuditLogger, FakeUnitOfWork } from '../../support/identity-doubles.util.js';

/**
 * The query on its own, with no route in front of it.
 *
 * That is the point of the file rather than an accident of unit testing: the guard on the route is a
 * fail-fast and this class is the authority (invariant 2 of CLAUDE.md), and the only way to show the
 * authority is real is to call it where the guard is not. Delete the `assertAllowed` line and the
 * HTTP suite stays green — the middleware would still refuse — while these two cases fail.
 */

const IVAN = 'ivan';
const MANAGER_ROLE = 'role-manager';

const actorWith = (overrides: Partial<Actor> = {}): Actor => ({
  userId: 'admin',
  organizationId: 'org-1',
  isOwner: false,
  permissionsVersion: 1,
  permissions: new Set<SharedPermissions.PermissionKey>(['permission:override_read']),
  denied: new Set<SharedPermissions.PermissionKey>(),
  roleKeys: [],
  ...overrides,
});

const queryOver = (
  reader: FakeEffectivePermissionsReader,
  audit: FakeAuditLogger = new FakeAuditLogger(),
): GetUserPermissionsQuery => new GetUserPermissionsQuery(new FakeUnitOfWork(), reader, audit);

describe('GetUserPermissionsQuery', () => {
  const subject = {
    isOwner: false,
    granted: ['task:read', 'task:update'] as SharedPermissions.PermissionKey[],
    denied: ['task:delete'] as SharedPermissions.PermissionKey[],
    roleKeys: ['manager'],
    permissionsVersion: 4,
  };

  const attribution = {
    [IVAN]: {
      roles: [{ roleId: MANAGER_ROLE, key: 'manager', name: 'Manager' }],
      grantedByRole: {
        'task:read': [MANAGER_ROLE],
        'task:update': [MANAGER_ROLE],
        'task:delete': [MANAGER_ROLE],
      },
      overrides: {
        'task:delete': {
          effect: 'DENY' as const,
          reason: 'deletions frozen until the audit closes',
          grantedById: 'admin',
          grantedAt: new Date('2026-08-01T00:00:00.000Z'),
          expiresAt: null,
        },
      },
    },
  };

  const reader = (): FakeEffectivePermissionsReader =>
    new FakeEffectivePermissionsReader(null, { [IVAN]: subject }, attribution);

  it('refuses a caller without the capability, with the guard nowhere in sight', async () => {
    const query = queryOver(reader());

    await expect(
      query.execute({
        actor: actorWith({ permissions: new Set<SharedPermissions.PermissionKey>() }),
        subjectUserId: IVAN,
      }),
    ).rejects.toMatchObject({ code: 'organization_forbidden', reason: 'permission_not_granted' });
  });

  /**
   * Refused **before** the subject is looked up, which is what keeps the answer free of information
   * about who exists: the reader here answers `null` for everybody, and the refusal is still the
   * capability one rather than a 404.
   */
  it('decides the capability before it resolves the subject', async () => {
    const query = queryOver(new FakeEffectivePermissionsReader(null));

    await expect(
      query.execute({
        actor: actorWith({ permissions: new Set<SharedPermissions.PermissionKey>() }),
        subjectUserId: IVAN,
      }),
    ).rejects.toMatchObject({ code: 'organization_forbidden' });
  });

  it('answers 404 for somebody who is not in this organization', async () => {
    const query = queryOver(new FakeEffectivePermissionsReader(null));

    await expect(
      query.execute({ actor: actorWith(), subjectUserId: 'somebody-else' }),
    ).rejects.toMatchObject({ code: 'user_not_found' });
  });

  it('reports each permission with the layer that decided it', async () => {
    const result = await queryOver(reader()).execute({
      actor: actorWith(),
      subjectUserId: IVAN,
    });

    const byKey = new Map(result.permissions.map((state) => [state.key, state]));

    expect(result).toMatchObject({ userId: IVAN, isOwner: false, version: 4 });
    expect(result.roles).toEqual([{ roleId: MANAGER_ROLE, key: 'manager', name: 'Manager' }]);
    expect(byKey.get('task:read')).toMatchObject({ allowed: true, source: 'ROLE' });
    expect(byKey.get('task:delete')).toMatchObject({
      allowed: false,
      source: 'OVERRIDE_DENY',
      roleIds: [MANAGER_ROLE],
    });
    expect(byKey.get('organization:delete')).toMatchObject({
      allowed: false,
      source: 'NOT_GRANTED',
    });
  });

  /**
   * The property the whole design is for: what this screen says and what the guard decides are the
   * same function, checked here over the **entire** catalogue rather than over the three keys the
   * case above happens to name.
   *
   * `effectivePermission` is what `authorizeCapability` answers with, so a divergence between the
   * screen and the door shows up as a list of keys instead of as a support ticket.
   */
  it('agrees with the shared ladder on every key of the catalogue', async () => {
    const result = await queryOver(reader()).execute({
      actor: actorWith(),
      subjectUserId: IVAN,
    });

    const view: SharedPermissions.CapabilityView = {
      isOwner: subject.isOwner,
      permissions: new Set(subject.granted),
      denied: new Set(subject.denied),
    };

    const disagreements = result.permissions
      .filter((state) => state.allowed !== SharedPermissions.effectivePermission(view, state.key))
      .map((state) => state.key);

    expect(disagreements).toEqual([]);
  });

  /**
   * `permission-model.md` §10: a `GET` is not audited, and this operation is the named exception —
   * it hands back the sentences an administrator wrote about a named colleague, and a run of it
   * across the roster draws the map of who administers the organization. `INFO`, because the read
   * grants and takes away nothing; the point is that the look is on the record at all.
   */
  it('files permission.inspected for a successful read, and nothing else', async () => {
    const audit = new FakeAuditLogger();

    await queryOver(reader(), audit).execute({ actor: actorWith(), subjectUserId: IVAN });

    expect(audit.events).toEqual([
      {
        action: 'permission.inspected',
        actor: { userId: 'admin', organizationId: 'org-1', ipAddress: undefined },
        target: { type: 'USER', id: IVAN },
        requestId: undefined,
      },
    ]);
  });

  /**
   * A refusal is not a read: nobody's exceptions were shown, so there is nothing here for the trail
   * to make reviewable. Covers both refusal branches — capability first, subject second — so that an
   * audit call moved ahead of `assertAllowed` (which would file an entry for every guess at a uuid)
   * fails this rather than only the two refusal tests above.
   */
  it('files nothing when the read is refused, by capability or by subject', async () => {
    const byCapability = new FakeAuditLogger();

    await expect(
      queryOver(reader(), byCapability).execute({
        actor: actorWith({ permissions: new Set<SharedPermissions.PermissionKey>() }),
        subjectUserId: IVAN,
      }),
    ).rejects.toBeDefined();
    expect(byCapability.events).toEqual([]);

    const bySubject = new FakeAuditLogger();

    await expect(
      queryOver(new FakeEffectivePermissionsReader(null), bySubject).execute({
        actor: actorWith(),
        subjectUserId: 'somebody-else',
      }),
    ).rejects.toBeDefined();
    expect(bySubject.events).toEqual([]);
  });
});

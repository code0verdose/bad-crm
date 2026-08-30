import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { ProvisionSystemRolesUseCase } from '../../../src/application/iam/use-cases/provision-system-roles.use-case.js';
import { FakeAuditLogger } from '../../support/identity-doubles.util.js';
import { FakeRoleRepository } from '../../support/iam-doubles.util.js';

const ORGANIZATION_ID = '11111111-1111-4111-8111-111111111111';

const provisioning = (roles: FakeRoleRepository, audit = new FakeAuditLogger()) =>
  new ProvisionSystemRolesUseCase(roles, audit);

/**
 * What an organization is asked to be given, before any database is involved.
 *
 * The repository half is proved against a real PostgreSQL
 * (`test/integration/db/system-roles-provisioning.test.ts`); this is the half that decides *what* to
 * provision, and it has three decisions worth pinning: every role of the matrix, exactly one
 * default, and an order that reads as a hierarchy rather than as insertion order.
 */

describe('provisioning the system roles', () => {
  it('asks for every role of the matrix, in the order of the document', async () => {
    const roles = new FakeRoleRepository();

    await provisioning(roles).execute({ organizationId: ORGANIZATION_ID });

    expect(roles.lastKeys).toEqual([...SharedPermissions.SYSTEM_ROLE_KEYS]);
  });

  it('carries the permissions the matrix gives each role', async () => {
    const roles = new FakeRoleRepository();

    await provisioning(roles).execute({ organizationId: ORGANIZATION_ID });

    const asked = Object.fromEntries(
      (roles.provisioned.at(-1) ?? []).map((draft) => [draft.key, [...draft.permissions]]),
    );

    expect(asked['owner']).toHaveLength(SharedPermissions.PERMISSIONS.length);
    expect(asked['guest']).toEqual([...SharedPermissions.SYSTEM_ROLE_PERMISSIONS.guest]);
  });

  it('marks exactly one role as the default, and it is the one the model names', async () => {
    const roles = new FakeRoleRepository();

    await provisioning(roles).execute({ organizationId: ORGANIZATION_ID });

    const defaults = (roles.provisioned.at(-1) ?? []).filter((draft) => draft.isDefault);

    expect(defaults.map((draft) => draft.key)).toEqual([SharedPermissions.DEFAULT_SYSTEM_ROLE]);
  });

  /**
   * `priority` is what the interface sorts by, and a list showing `guest` above `owner` would read
   * as a hierarchy that does not exist.
   */
  it('orders them so that the owner ranks highest', async () => {
    const roles = new FakeRoleRepository();

    await provisioning(roles).execute({ organizationId: ORGANIZATION_ID });

    const drafts = roles.provisioned.at(-1) ?? [];
    const priorities = drafts.map((draft) => draft.priority);

    expect(priorities).toEqual([...priorities].sort((left, right) => right - left));
    expect(drafts[0]?.key).toBe('owner');
  });

  /**
   * CONTROL: the repository is what it asks, so a use-case that asked for nothing would fail every
   * case above rather than pass them vacuously.
   */
  it('CONTROL: a refusing repository is not swallowed', async () => {
    const roles = new FakeRoleRepository(true);

    await expect(provisioning(roles).execute({ organizationId: ORGANIZATION_ID })).rejects.toThrow(
      /role repository is unavailable/,
    );
  });
});

/**
 * The half of acceptance 7 that `pnpm db:provision-roles` is for.
 *
 * The composition of a system role is code, so an upgrade re-applies it to every organization of an
 * installation — and until these cases existed it did so **without a single record**: people held
 * rights on Monday they did not hold on Friday, and the trail said nothing. The operator is not the
 * reader here; the owner of each organization is, which is why the entries are filed inside the
 * tenant whose rights moved.
 */
describe('what a re-provisioning leaves in the trail', () => {
  const stored = (
    overrides: Record<string, readonly SharedPermissions.PermissionKey[]> = {},
  ): ReadonlyMap<string, readonly SharedPermissions.PermissionKey[]> =>
    new Map(
      SharedPermissions.SYSTEM_ROLE_KEYS.map((key) => [
        key,
        overrides[key] ?? SharedPermissions.SYSTEM_ROLE_PERMISSIONS[key],
      ]),
    );

  it('records role.updated for the role whose composition moved, and for no other', async () => {
    const audit = new FakeAuditLogger();
    const lead = SharedPermissions.SYSTEM_ROLE_PERMISSIONS.lead;
    const roles = new FakeRoleRepository(false, stored({ lead: lead.slice(1) }));

    await provisioning(roles, audit).execute({ organizationId: ORGANIZATION_ID });

    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]?.action).toBe('role.updated');
    expect(audit.events[0]?.target).toEqual({ type: 'ROLE', id: expect.any(String) });
    expect(audit.events[0]?.after).toMatchObject({ key: 'lead', granted: [lead[0]], revoked: [] });
    expect(audit.events[0]?.before).toMatchObject({
      key: 'lead',
      permissionCount: lead.length - 1,
    });
  });

  /**
   * `actorType` is not a field the caller sets — the writer derives `SYSTEM` from an actor with no
   * person in it (`audit-log.adapter.ts`). What the use-case has to get right is leaving `userId`
   * absent while still naming the organization, which is what the trail is filed under.
   */
  it('files the entry as the system acting on its own, inside the organization it changed', async () => {
    const audit = new FakeAuditLogger();
    const roles = new FakeRoleRepository(false, stored({ guest: [] }));

    await provisioning(roles, audit).execute({ organizationId: ORGANIZATION_ID });

    expect(audit.events[0]?.actor).toEqual({
      userId: undefined,
      organizationId: ORGANIZATION_ID,
      ipAddress: undefined,
    });
  });

  it('writes nothing when the run changed nothing', async () => {
    const audit = new FakeAuditLogger();
    const roles = new FakeRoleRepository(false, stored());

    await provisioning(roles, audit).execute({ organizationId: ORGANIZATION_ID });

    expect(audit.events).toEqual([]);
  });

  /**
   * A fresh organization is not an installation whose rights moved: it is being created, and
   * `organization.registered` already says what it was given. Seven entries per registration would
   * be the same fact written eight times.
   */
  it('stays silent when the organization is being provisioned for the first time', async () => {
    const audit = new FakeAuditLogger();
    const roles = new FakeRoleRepository();

    await provisioning(roles, audit).execute({ organizationId: ORGANIZATION_ID });

    expect(audit.events).toEqual([]);
  });

  /**
   * A role the release adds to an installation that already has the others is a creation, not an
   * update — and it is exactly the change an owner is entitled to see, so it may not fall through
   * the gap between the two cases above.
   */
  it('records role.created for a role the release added to an existing organization', async () => {
    const audit = new FakeAuditLogger();
    const existing = new Map(stored());

    existing.delete('guest');

    const roles = new FakeRoleRepository(false, existing);

    await provisioning(roles, audit).execute({ organizationId: ORGANIZATION_ID });

    expect(audit.events.map((event) => event.action)).toEqual(['role.created']);
    expect(audit.events[0]?.before).toBeUndefined();
    expect(audit.events[0]?.after).toMatchObject({ key: 'guest' });
  });

  /** CONTROL: a refusing trail is not swallowed — an unrecorded rights change must not commit. */
  it('CONTROL: fails closed when the trail refuses', async () => {
    const roles = new FakeRoleRepository(false, stored({ guest: [] }));

    await expect(
      provisioning(roles, new FakeAuditLogger(true)).execute({ organizationId: ORGANIZATION_ID }),
    ).rejects.toThrow(/audit sink unavailable/);
  });
});

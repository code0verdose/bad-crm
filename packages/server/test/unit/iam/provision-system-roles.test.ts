import { SharedPermissions } from '@bad-crm/shared';
import { describe, expect, it } from 'vitest';

import { ProvisionSystemRolesUseCase } from '../../../src/application/iam/use-cases/provision-system-roles.use-case.js';
import { FakeRoleRepository } from '../../support/iam-doubles.util.js';

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

    await new ProvisionSystemRolesUseCase(roles).execute();

    expect(roles.lastKeys).toEqual([...SharedPermissions.SYSTEM_ROLE_KEYS]);
  });

  it('carries the permissions the matrix gives each role', async () => {
    const roles = new FakeRoleRepository();

    await new ProvisionSystemRolesUseCase(roles).execute();

    const asked = Object.fromEntries(
      (roles.provisioned.at(-1) ?? []).map((draft) => [draft.key, [...draft.permissions]]),
    );

    expect(asked['owner']).toHaveLength(SharedPermissions.PERMISSIONS.length);
    expect(asked['guest']).toEqual([...SharedPermissions.SYSTEM_ROLE_PERMISSIONS.guest]);
  });

  it('marks exactly one role as the default, and it is the one the model names', async () => {
    const roles = new FakeRoleRepository();

    await new ProvisionSystemRolesUseCase(roles).execute();

    const defaults = (roles.provisioned.at(-1) ?? []).filter((draft) => draft.isDefault);

    expect(defaults.map((draft) => draft.key)).toEqual([SharedPermissions.DEFAULT_SYSTEM_ROLE]);
  });

  /**
   * `priority` is what the interface sorts by, and a list showing `guest` above `owner` would read
   * as a hierarchy that does not exist.
   */
  it('orders them so that the owner ranks highest', async () => {
    const roles = new FakeRoleRepository();

    await new ProvisionSystemRolesUseCase(roles).execute();

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

    await expect(new ProvisionSystemRolesUseCase(roles).execute()).rejects.toThrow(
      /role repository is unavailable/,
    );
  });
});

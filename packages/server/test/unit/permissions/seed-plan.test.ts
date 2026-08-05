import { describe, expect, it } from 'vitest';

import { SharedPermissions } from '@bad-crm/shared';

import { planCatalog, renderCatalogPlan } from '../../../scripts/seed-permissions.util.js';

/**
 * What the catalogue seed decides, before it touches a database.
 *
 * The interesting case is not «write the keys» — it is what happens to a key the code no longer
 * declares. Deleting it would break every installation where an administrator had already granted
 * it, because `RolePermission` and `UserPermissionOverride` reference permissions **by name**. So it
 * is marked, and the mark is cleared again if a later release brings the key back.
 */

const row = (key: string, deprecatedAt: Date | null = null) => ({ key, deprecatedAt });

describe('planning the catalogue', () => {
  it('writes every key the code declares', () => {
    const plan = planCatalog([]);

    expect(plan.upsert.map((permission) => permission.key)).toEqual([
      ...SharedPermissions.PERMISSIONS,
    ]);
  });

  it('carries the metadata the table stores, from the code', () => {
    const [first] = planCatalog([]).upsert;
    const key = SharedPermissions.PERMISSIONS[0];
    const meta = SharedPermissions.PERMISSION_META[key];

    expect(first).toEqual({
      key,
      resource: meta.resource,
      action: meta.action,
      category: meta.domain,
      isDangerous: meta.dangerous,
    });
  });

  it('marks a key the code no longer declares, and never deletes it', () => {
    const plan = planCatalog([row('legacy:thing')]);

    expect(plan.deprecate).toEqual(['legacy:thing']);
    expect(plan.upsert.some((permission) => permission.key === 'legacy:thing')).toBe(false);
  });

  it('marks it once: a key already deprecated is left alone', () => {
    expect(planCatalog([row('legacy:thing', new Date())]).deprecate).toEqual([]);
  });

  /**
   * The other direction, and the one a release that reinstates a permission needs: a key the code
   * declares again must lose the mark, or the catalogue would carry a permission the code checks and
   * the policy layer refuses.
   */
  it('revives a key that came back', () => {
    const known = SharedPermissions.PERMISSIONS[0];
    const plan = planCatalog([row(known, new Date())]);

    expect(plan.revive).toEqual([known]);
    expect(plan.deprecate).toEqual([]);
  });

  /**
   * CONTROL: a database that already matches the code asks for no change beyond the upserts. Without
   * it, a planner that deprecated everything would look identical to a working one.
   */
  it('CONTROL: asks for nothing when the database already matches', () => {
    const plan = planCatalog(SharedPermissions.PERMISSIONS.map((key) => row(key)));

    expect(plan.deprecate).toEqual([]);
    expect(plan.revive).toEqual([]);
    expect(plan.upsert).toHaveLength(SharedPermissions.PERMISSIONS.length);
  });

  it('says what it did, including that nothing was deleted', () => {
    const rendered = renderCatalogPlan(planCatalog([row('legacy:thing')]));

    expect(rendered).toContain('kept, not deleted');
    expect(rendered).toContain('legacy:thing');
  });
});

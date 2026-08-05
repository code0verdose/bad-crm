import { SharedPermissions } from '@bad-crm/shared';

/**
 * Bringing the permission catalogue in the database in line with the catalogue in the code.
 *
 * Three operations, and the third is the one worth explaining:
 *
 *   * **upsert** every key the code declares, so a changed flag (`dangerous`, `category`) is
 *     corrected rather than left as whatever an earlier release wrote;
 *   * **mark** — never delete — a key the code no longer declares. Rows in `RolePermission` and
 *     `UserPermissionOverride` point at these keys by name, and dropping the row would break every
 *     installation where an administrator had already granted it. A deprecated key is not offered in
 *     the UI and always resolves to «no permission» in the policy layer, and the rows that reference
 *     it are cleaned up by a deliberate contract migration, in its own release
 *     (`docs/architecture/data-model.md`, group 2);
 *   * **revive** a key that came back — a release that reinstates a permission must clear the mark,
 *     or the catalogue would carry a key the code declares and the policy layer refuses.
 *
 * The decision is separated from the database for the same reason it is everywhere else in this
 * repository: it can then be asserted without a container, and what remains in `seed-permissions.ts`
 * is two statements.
 */

export interface PermissionRow {
  readonly key: string;
  readonly deprecatedAt: Date | null;
}

export interface PermissionUpsert {
  readonly key: string;
  readonly resource: string;
  readonly action: string;
  readonly category: string;
  readonly isDangerous: boolean;
}

export interface CatalogPlan {
  /** Every key the code declares, in catalogue order. */
  readonly upsert: readonly PermissionUpsert[];
  /** Keys present in the database, absent from the code and not yet marked. */
  readonly deprecate: readonly string[];
  /** Keys the code declares again after a release that had removed them. */
  readonly revive: readonly string[];
}

export const planCatalog = (existing: readonly PermissionRow[]): CatalogPlan => {
  const declared = new Set<string>(SharedPermissions.PERMISSIONS);

  const upsert = SharedPermissions.PERMISSIONS.map((key) => {
    const meta = SharedPermissions.PERMISSION_META[key];

    return {
      key,
      resource: meta.resource,
      action: meta.action,
      category: meta.domain,
      isDangerous: meta.dangerous,
    };
  });

  return {
    upsert,
    deprecate: existing
      .filter((row) => !declared.has(row.key) && row.deprecatedAt === null)
      .map((row) => row.key),
    revive: existing
      .filter((row) => declared.has(row.key) && row.deprecatedAt !== null)
      .map((row) => row.key),
  };
};

/** What the operator reads: the three numbers that say what this run changed. */
export const renderCatalogPlan = (plan: CatalogPlan): string =>
  [
    `permissions: ${String(plan.upsert.length)} in the catalogue`,
    plan.deprecate.length > 0
      ? `  deprecated (kept, not deleted): ${plan.deprecate.join(', ')}`
      : '  deprecated: none',
    plan.revive.length > 0 ? `  revived: ${plan.revive.join(', ')}` : '  revived: none',
  ].join('\n');

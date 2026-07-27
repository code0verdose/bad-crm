/**
 * Failures of the tenant scope itself, as opposed to failures of a query inside it.
 *
 * Both are programming errors, not user input: they mean a code path reached the database without
 * declaring which organization it belongs to, or tried to change that answer half way through a
 * transaction. They are thrown before any statement is sent, so they never reach the user as a
 * partial write (docs/security/rls-design.md, «Выставление контекста из приложения»).
 */

export class MissingTenantContextError extends Error {
  constructor(where: string) {
    super(`Tenant context is missing for ${where}: wrap the call in withTenant().`);
    this.name = 'MissingTenantContextError';
  }
}

export class CrossTenantNestingError extends Error {
  constructor(outerOrganizationId: string, innerOrganizationId: string) {
    super(
      `Nested withTenant with a different organization: ${outerOrganizationId} → ${innerOrganizationId}. ` +
        'One transaction serves one tenant; iterate organizations with one withTenant each.',
    );
    this.name = 'CrossTenantNestingError';
  }
}

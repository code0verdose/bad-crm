/**
 * One command, one transaction, one tenant.
 *
 * The two are the same thing in this system and the port says so: there is no `withTransaction`
 * that does not also pin a tenant. A transaction without `app.organization_id` reaches the database
 * as a connection whose policies compare rows against an unset setting — the statement fails with
 * `42704`, which is the safe outcome and a useless message. A tenant without a transaction is worse:
 * `set_config(..., is_local => true)` has nothing to be local to, so the value either does not apply
 * or outlives the request and leaks into the next one (docs/security/rls-design.md, «Ловушки», 1).
 *
 * The work function takes no arguments. Repositories find the transaction themselves, through the
 * scope this call opens, so a use-case never holds a database handle and cannot pass one into a
 * place where the scope is no longer in effect (rules/hexagonal-backend.mdc, rule 3).
 */
export interface TenantScope {
  readonly organizationId: string;
  /** `null` where there is no acting user yet: registration, a scheduled job, a migration. */
  readonly userId: string | null;
}

export interface UnitOfWorkPort {
  withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T>;
}

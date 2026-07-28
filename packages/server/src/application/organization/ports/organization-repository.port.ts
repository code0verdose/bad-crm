/**
 * The tenant root, loaded and saved as a whole.
 *
 * Note what is *not* here: no method takes an `organizationId`. The tenant is the scope the caller
 * opened through `UnitOfWorkPort`, and a parameter beside it would be a second answer to the same
 * question — one the policy silently overrules, turning a mismatch into an empty result rather than
 * into an error (rules/tenancy-rls.mdc, 9; docs/security/rls-design.md).
 */

/** What an installation owner supplies when the first organization is created. */
export interface OrganizationDraft {
  readonly name: string;
  /** Globally unique; the only field of this table that is not scoped to a tenant. */
  readonly slug: string;
  readonly timezone: string;
  /** ISO 4217, three letters. */
  readonly defaultCurrency: string;
}

/** The read model of the tenant root; deliberately not the Prisma row. */
export interface OrganizationSummary {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
}

export interface OrganizationRepositoryPort {
  /**
   * Inserts the tenant root **as the organization of the current scope**.
   *
   * There is no `id` in the draft, and that is the mechanism rather than a convenience: the row's
   * primary key *is* the tenant, its policy compares `id` against `app.organization_id`, and any
   * other value would be refused by `WITH CHECK`. Taking the id from the scope makes the refusal
   * impossible to reach — and makes it impossible to create an organization other than the one the
   * caller declared it was acting as (docs/security/rls-design.md, «Особый случай: organizations»).
   */
  create(draft: OrganizationDraft): Promise<OrganizationSummary>;

  /** The organization of the current scope, or `null` when it does not exist or is soft-deleted. */
  findCurrent(): Promise<OrganizationSummary | null>;
}

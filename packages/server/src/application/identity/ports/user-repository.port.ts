/**
 * Users of the organization in the current scope.
 *
 * Only the one operation the organization bootstrap needs is declared here. The rest of the port —
 * lookup by email, status changes, the password lifecycle — arrives with the authentication surface
 * in [EPIC-006], together with the `users` table itself and this port's Prisma adapter. Declaring
 * the whole interface now would be guessing at signatures for methods no caller has yet, and a port
 * is defined by its consumer (rules/hexagonal-backend.mdc, rule 6).
 */

export interface OwnerDraft {
  readonly email: string;
  readonly name: string;
  /** Already hashed by `PasswordHasherPort`; a plaintext password never crosses this boundary. */
  readonly passwordHash: string;
}

export interface UserRepositoryPort {
  /**
   * Creates the first, `ACTIVE` user of the organization in the current scope and returns its id.
   *
   * No `organizationId` argument: the row belongs to the tenant of the surrounding transaction, and
   * the policy would refuse any other value anyway (rules/tenancy-rls.mdc, 9).
   */
  createOwner(draft: OwnerDraft): Promise<string>;
}

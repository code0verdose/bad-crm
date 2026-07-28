import { type RoleSeederPort } from '@/application/identity/ports/role-seeder.port.js';
import {
  type OwnerDraft,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import {
  type OrganizationDraft,
  type OrganizationRepositoryPort,
} from '@/application/organization/ports/organization-repository.port.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';

export interface BootstrapOrganizationInput {
  readonly organization: OrganizationDraft;
  readonly owner: OwnerDraft;
}

export interface BootstrapOrganizationResult {
  readonly organizationId: string;
  readonly ownerId: string;
}

/**
 * Creates an organization and the account that administers it, in one transaction.
 *
 * ## Why this is not an ordinary command
 *
 * Every other command in this system starts from a tenant it was told about: the session says which
 * organization the caller belongs to, `withTenant` pins it, and the policies do the rest. Here there
 * is no such organization — it is the thing being created — so the chicken-and-egg problem of
 * `docs/security/rls-design.md` («Особые пути») has to be solved explicitly.
 *
 * **How it is solved: the application generates the id first, and the scope is opened as that
 * organization.** The insert then satisfies the policy of `organizations`, which is
 * `WITH CHECK (id = current_setting('app.organization_id')::uuid)` — the row being written *is* the
 * tenant the connection already claims to be. Nothing else in the transaction needs special
 * treatment: from the second statement on, the organization exists and this is an ordinary scope.
 *
 * **Why this path opens no hole.** The alternative — a `SECURITY DEFINER` function owned by
 * `app_auth`, which is what the login path uses — would create a second surface that bypasses RLS,
 * and this one does not need it. The scope here is opened as a *freshly generated* uuid: it names
 * an organization that did not exist a moment ago, so reading through it returns nothing and writing
 * through it can only ever touch rows carrying that same id. Even if a caller could choose the id —
 * it cannot; there is no input for it — the policy would confine every statement to the tenant
 * named, which is the whole point of the mechanism. `test/integration/db/organization-bootstrap.test.ts`
 * asserts exactly that: through this path, another organization is neither readable nor writable.
 *
 * ## Atomicity
 *
 * An organization without an owner is an installation nobody can administer; an owner without an
 * organization is a row no policy will ever show again. Both halves are written inside one
 * `withTenant`, and one transaction is what makes "neither, or both" true (STORY-005-06).
 *
 * ## What is deliberately not here
 *
 * Input validation, password hashing, the open-registration switch and `Idempotency-Key` belong to
 * the HTTP entry point in [STORY-006-01], which builds on this use-case; the audit record belongs
 * to the journal of [EPIC-016]. This class stays the part that is about tenancy.
 */
export class BootstrapOrganizationUseCase {
  constructor(
    private readonly unitOfWork: UnitOfWorkPort,
    private readonly organizations: OrganizationRepositoryPort,
    private readonly users: UserRepositoryPort,
    private readonly roles: RoleSeederPort,
    private readonly ids: IdGeneratorPort,
  ) {}

  async execute(input: BootstrapOrganizationInput): Promise<BootstrapOrganizationResult> {
    // Before the transaction, because the transaction is opened *as* this organization. `uuid()`
    // and not `next()`: entity keys in this schema are `uuid`, and a ULID would be rejected by the
    // column before it ever reached the policy.
    const organizationId = this.ids.uuid();

    return this.unitOfWork.withTenant({ organizationId, userId: null }, async () => {
      // First, and not merely for tidiness: every later row carries `organization_id` and a
      // composite foreign key back to this one. Foreign key checks run as the table owner and
      // bypass RLS, so a child written before its parent would not be refused by a policy — it
      // would be refused by the constraint, at the end of the transaction, with a message about
      // the child.
      await this.organizations.create(input.organization);

      const ownerId = await this.users.createOwner(input.owner);

      await this.roles.seedSystemRoles(ownerId);

      return { organizationId, ownerId };
    });
  }
}

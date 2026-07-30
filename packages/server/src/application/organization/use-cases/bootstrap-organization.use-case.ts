import {
  type OrganizationDraft,
  type OrganizationOwnerDraft,
  type OrganizationRepositoryPort,
} from '@/application/organization/ports/organization-repository.port.js';
import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import { type UnitOfWorkPort } from '@/application/platform/ports/unit-of-work.port.js';

export interface BootstrapOrganizationInput {
  readonly organization: OrganizationDraft;
  readonly owner: OrganizationOwnerDraft;
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
 * tenant the connection already claims to be. Nothing else needs special treatment: once that
 * statement has run the organization exists, and this is an ordinary scope.
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
 * organization is a row no policy will ever show again. Since the contract step of STORY-006-09 both
 * rows are written by one **statement**, so "neither, or both" no longer rests on the transaction
 * boundary alone — `organizations.owner_id` is NOT NULL, and the composite foreign key back to
 * `users` is checked when that statement ends. The `withTenant` around it is still what pins the
 * scope (STORY-005-06).
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
    private readonly ids: IdGeneratorPort,
  ) {}

  async execute(input: BootstrapOrganizationInput): Promise<BootstrapOrganizationResult> {
    // Before the transaction, because the transaction is opened *as* this organization. `uuid()`
    // and not `next()`: entity keys in this schema are `uuid`, and a ULID would be rejected by the
    // column before it ever reached the policy.
    const organizationId = this.ids.uuid();

    return this.unitOfWork.withTenant({ organizationId, userId: null }, async () => {
      // One call, because the two rows reference each other and `organizations.owner_id` is NOT NULL
      // since the contract step. The repository writes both in a single statement; the ordering
      // problem that used to live here — organization first, owner second, `owner_id` filled in by a
      // third statement — is gone along with the nullable window it needed.
      const { ownerId } = await this.organizations.createWithOwner(input.organization, input.owner);

      return { organizationId, ownerId };
    });
  }
}

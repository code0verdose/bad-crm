import { describe, expect, it } from 'vitest';

import { type IdGeneratorPort } from '@/application/platform/ports/id-generator.port.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { type RoleSeederPort } from '@/application/identity/ports/role-seeder.port.js';
import {
  type OwnerDraft,
  type UserRepositoryPort,
} from '@/application/identity/ports/user-repository.port.js';
import {
  type OrganizationDraft,
  type OrganizationRepositoryPort,
  type OrganizationSummary,
} from '@/application/organization/ports/organization-repository.port.js';
import { BootstrapOrganizationUseCase } from '@/application/organization/use-cases/bootstrap-organization.use-case.js';
import { ConflictError } from '@/domain/shared/errors/app.errors.js';

/**
 * The one place an organization comes into existence, and the only path in this codebase that opens
 * a tenant scope for a tenant that does not exist yet.
 *
 * The ports are backed by in-memory implementations rather than by mocks (rules/testing.mdc, 3):
 * what has to be observed is *state* — whether a failure half way through leaves an organization
 * nobody can log into — and `expect(mock).toHaveBeenCalled()` cannot see that. `InMemoryDatabase`
 * therefore models the one property of a transaction that matters here: on a throw, everything
 * written inside it is gone.
 */

const NEW_ORGANIZATION_ID = '018f4a3b-0000-7000-8000-0000000000aa';
const NEW_USER_ID = '018f4a3b-0000-7000-8000-0000000000bb';

const draft: OrganizationDraft = {
  name: 'Acme',
  slug: 'acme',
  timezone: 'Europe/Berlin',
  defaultCurrency: 'EUR',
};

const owner: OwnerDraft = {
  email: 'owner@example.com',
  name: 'Owner',
  passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA',
};

interface Row {
  readonly kind: 'organization' | 'user' | 'roles';
  readonly organizationId: string;
  readonly value: unknown;
}

/**
 * The state the ports share, plus the transaction semantics the real database gives them for free.
 */
class InMemoryDatabase {
  rows: Row[] = [];
  readonly scopes: TenantScope[] = [];
  /** Set by a test to make one step fail, exactly the way a driver would. */
  failOn: Row['kind'] | undefined;
  slugsTaken = new Set<string>();

  readonly unitOfWork: UnitOfWorkPort = {
    withTenant: async <T>(scope: TenantScope, work: () => Promise<T>): Promise<T> => {
      this.scopes.push(scope);
      const snapshot = [...this.rows];

      try {
        return await work();
      } catch (error) {
        this.rows = snapshot;

        throw error;
      }
    },
  };

  private write(kind: Row['kind'], organizationId: string, value: unknown): void {
    if (this.failOn === kind) throw new Error(`the ${kind} step failed`);

    this.rows.push({ kind, organizationId, value });
  }

  readonly organizations: OrganizationRepositoryPort = {
    create: (organizationDraft: OrganizationDraft): Promise<OrganizationSummary> => {
      const scope = this.scopes.at(-1);

      if (scope === undefined) throw new Error('create outside a tenant scope');
      if (this.slugsTaken.has(organizationDraft.slug)) {
        throw new ConflictError('organization_already_exists');
      }

      this.write('organization', scope.organizationId, organizationDraft);

      return Promise.resolve({ id: scope.organizationId, ...organizationDraft });
    },
    findCurrent: (): Promise<OrganizationSummary | null> => Promise.resolve(null),
  };

  readonly users: UserRepositoryPort = {
    createOwner: (ownerDraft: OwnerDraft): Promise<string> => {
      const scope = this.scopes.at(-1);

      if (scope === undefined) throw new Error('createOwner outside a tenant scope');

      this.write('user', scope.organizationId, ownerDraft);

      return Promise.resolve(NEW_USER_ID);
    },
  };

  readonly roles: RoleSeederPort = {
    seedSystemRoles: (ownerUserId: string): Promise<void> => {
      const scope = this.scopes.at(-1);

      if (scope === undefined) throw new Error('seedSystemRoles outside a tenant scope');

      this.write('roles', scope.organizationId, ownerUserId);

      return Promise.resolve();
    },
  };

  kinds(): Row['kind'][] {
    return this.rows.map((row) => row.kind);
  }
}

const fixedIds: IdGeneratorPort = {
  next: () => 'not-used-for-entity-ids',
  uuid: () => NEW_ORGANIZATION_ID,
};

const buildUseCase = (database: InMemoryDatabase): BootstrapOrganizationUseCase =>
  new BootstrapOrganizationUseCase(
    database.unitOfWork,
    database.organizations,
    database.users,
    database.roles,
    fixedIds,
  );

describe('BootstrapOrganizationUseCase', () => {
  it('CONTROL: creates the organization, its owner and its system roles', async () => {
    const database = new InMemoryDatabase();

    const result = await buildUseCase(database).execute({ organization: draft, owner });

    expect(result).toEqual({ organizationId: NEW_ORGANIZATION_ID, ownerId: NEW_USER_ID });
    expect(database.kinds()).toEqual(['organization', 'user', 'roles']);
  });

  /**
   * The special path of `docs/security/rls-design.md`, stated as an assertion.
   *
   * The id is generated by the application *before* the transaction opens, and the scope is opened
   * as that organization — which does not exist yet. It is the only way the insert can pass
   * `WITH CHECK (id = current_setting('app.organization_id')::uuid)`: the row being written has to
   * be the tenant the connection already claims to be.
   */
  it('opens the scope as the organization it is about to create, with no acting user', async () => {
    const database = new InMemoryDatabase();

    await buildUseCase(database).execute({ organization: draft, owner });

    expect(database.scopes).toEqual([{ organizationId: NEW_ORGANIZATION_ID, userId: null }]);
  });

  it('runs every step in one transaction, so there is no window between them', async () => {
    const database = new InMemoryDatabase();

    await buildUseCase(database).execute({ organization: draft, owner });

    expect(database.scopes).toHaveLength(1);
    expect(new Set(database.rows.map((row) => row.organizationId))).toEqual(
      new Set([NEW_ORGANIZATION_ID]),
    );
  });

  it.each(['user', 'roles'] as const)(
    'leaves nothing behind when the %s step fails',
    async (failingStep) => {
      const database = new InMemoryDatabase();

      database.failOn = failingStep;

      await expect(
        buildUseCase(database).execute({ organization: draft, owner }),
      ).rejects.toThrow();
      expect(database.rows).toEqual([]);
    },
  );

  /**
   * A taken slug is the one conflict a caller can act on, and it can only be discovered by the
   * unique index: under the policy of an organization that does not exist yet, a pre-flight
   * `SELECT ... WHERE slug = $1` sees nothing at all.
   */
  it('reports a taken slug as a conflict and creates nothing', async () => {
    const database = new InMemoryDatabase();

    database.slugsTaken.add(draft.slug);

    const failure = await buildUseCase(database)
      .execute({ organization: draft, owner })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConflictError);
    expect((failure as ConflictError).code).toBe('organization_already_exists');
    expect(database.rows).toEqual([]);
  });

  it('creates the organization before anything that references it', async () => {
    const database = new InMemoryDatabase();

    database.failOn = 'organization';

    await expect(buildUseCase(database).execute({ organization: draft, owner })).rejects.toThrow();
    expect(database.rows).toEqual([]);
  });
});

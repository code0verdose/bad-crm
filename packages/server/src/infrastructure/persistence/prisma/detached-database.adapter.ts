import { type AuthLookupPort } from '@/application/identity/ports/auth-lookup.port.js';
import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { ServiceUnavailableError } from '@/domain/shared/errors/app.errors.js';

/**
 * The database ports of a container that was built without a database.
 *
 * `ContainerInput.database` has been optional since the container existed, and for a reason that is
 * still true: the HTTP suites build the real application out of in-process adapters and drive it
 * through supertest, and a contract test that needs a container is a contract test that gets
 * skipped. Those suites read the router — which routes exist, which guard each carries, what the
 * specification says about them — and never reach a repository.
 *
 * These two exist so that shape stays *explicit*. The alternative — making the identity use-cases
 * optional in `HttpServerDependencies` and registering the auth routes only when a database is
 * present — would mean the contract test compares the specification against a router that is missing
 * seven operations, and the drift it exists to catch would be the drift it produces.
 *
 * They are not a fallback and not a stub with a plausible answer: every method throws, immediately,
 * naming the missing configuration. A container that reached one of these in production is
 * misconfigured, and the only safe behaviour is to say so rather than to behave like an empty
 * database.
 *
 * **The two throw different things, and the difference is which one production can reach.**
 * `DATABASE_URL` is required by the env schema, so a process without a pool does not exist outside
 * a test — a bare `Error` there is a wiring defect and is answered as one. `DATABASE_AUTH_URL` is
 * `.optional()` (`rules/self-host-packaging.mdc`, rule 2), so a real installation can and does
 * reach the lookup below; a bare `Error` there arrives at the handler as "not one of ours" and
 * becomes `500 internal_error` with no detail — a missing dependency reported as a bug, and nothing
 * an alert can key on. `ServiceUnavailableError` is the same event with the code and the 503 that
 * describe it, and it says which variable to set.
 */

const refuse = (what: string): never => {
  throw new Error(
    `${what}: this process was started without a database connection — set DATABASE_URL (and DATABASE_AUTH_URL for the authentication path)`,
  );
};

const refuseAuth = (): never => {
  throw new ServiceUnavailableError({
    dependency: 'auth-database',
    variable: 'DATABASE_AUTH_URL',
    remedy:
      'this process was started without DATABASE_AUTH_URL, so the org-less authentication path has no connection to resolve an account on',
  });
};

export const detachedUnitOfWork = (): UnitOfWorkPort => ({
  withTenant<T>(_scope: TenantScope, _work: () => Promise<T>): Promise<T> {
    return refuse('withTenant');
  },
});

export const detachedAuthLookup = (): AuthLookupPort => ({
  findUsersByEmail: () => refuseAuth(),
  findUserByEmailAndSlug: () => refuseAuth(),
  findSessionByRefreshHash: () => refuseAuth(),
  findPasswordResetToken: () => refuseAuth(),
  findInvitation: () => refuseAuth(),
});

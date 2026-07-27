import { AsyncLocalStorage } from 'node:async_hooks';
import { organizationIdSchema, userIdSchema } from '@bad-crm/shared/validation';
import { Prisma, type PrismaClient } from '@prisma/client';

import {
  CrossTenantNestingError,
  MissingTenantContextError,
} from '@/infrastructure/persistence/prisma/tenant.errors.js';

/** The transactional client every repository works through; the only handle that carries context. */
export type TxClient = Prisma.TransactionClient;

export interface TenantContext {
  readonly organizationId: string;
  /** `null` for a path that has no acting user yet: registration, a scheduled job, a migration. */
  readonly userId: string | null;
}

export interface TenantStore {
  readonly ctx: TenantContext;
  readonly tx: TxClient;
}

export interface WithTenantOptions {
  readonly maxWaitMs?: number;
  readonly timeoutMs?: number;
  readonly isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * `maxWait` is how long we queue for a connection, `timeout` how long the whole scenario may hold
 * one. An interactive transaction pins its connection for the entire callback, so the ceiling is
 * also the ceiling on how long one request may keep a connection out of the pool — which is why
 * nothing external (S3, SMTP, AI, GitHub) may be called from inside it.
 */
const DEFAULT_MAX_WAIT_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5_000;

const tenantStorage = new AsyncLocalStorage<TenantStore>();

/** The tenant scope currently in effect, or `undefined` outside one. */
export const currentTenant = (): TenantStore | undefined => tenantStorage.getStore();

/**
 * The scope in effect, or a refusal. Used by raw SQL, which `guardedClient` cannot see: a raw
 * statement outside `withTenant` runs without `app.organization_id` and is exactly the path RLS
 * answers with an error rather than with data.
 */
export const requireTenant = (where: string): TenantStore => {
  const store = tenantStorage.getStore();

  if (store === undefined) throw new MissingTenantContextError(where);

  return store;
};

/**
 * Opens one interactive transaction, pins the tenant context to it and runs `fn` inside.
 *
 * Two details are load-bearing and neither is stylistic:
 *
 *   * `set_config(..., is_local => true)` and not `SET`. `SET` survives the transaction, travels
 *     back into the connection pool and applies to the next request — of a different organization.
 *     The symptom is "sometimes a user sees another company's data", only under concurrency, never
 *     in a test (docs/security/rls-design.md, «Ловушки», 1).
 *   * a tagged template and not string interpolation. `SET LOCAL` is a utility command and cannot
 *     take a bind parameter at all, which is the reason `set_config` — an ordinary function — is
 *     used instead: the organization id arrives as `$1` and an id that is not a uuid cannot become
 *     SQL.
 *
 * Both ids are parsed before the transaction opens: they come from a JWT or from a queue message,
 * which is external input regardless of how internal it feels.
 */
export const withTenant = async <T>(
  base: PrismaClient,
  ctx: TenantContext,
  fn: (tx: TxClient) => Promise<T>,
  options: WithTenantOptions = {},
): Promise<T> => {
  const organizationId: string = organizationIdSchema.parse(ctx.organizationId);
  const userId: string | null = ctx.userId === null ? null : userIdSchema.parse(ctx.userId);

  const outer = tenantStorage.getStore();

  if (outer !== undefined) {
    // Nesting is normal — a use-case calls a helper that also declares its scope. Nesting with a
    // *different* organization never is: it would run under the outer tenant's context while the
    // code reads as if it ran under the inner one.
    if (outer.ctx.organizationId !== organizationId) {
      throw new CrossTenantNestingError(outer.ctx.organizationId, organizationId);
    }

    return fn(outer.tx);
  }

  return base.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.organization_id', ${organizationId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.user_id', ${userId ?? ''}, true)`;

      // `await` inside the scope, not `() => fn(tx)`. A repository that ends in
      // `return tx.team.findMany()` hands back a lazy PrismaPromise: its query — and therefore the
      // tenant guard's check — runs when something calls `.then` on it, and that "something" is the
      // awaiting code out here, where the AsyncLocalStorage scope has already closed. The guard
      // would then refuse a call that is perfectly inside `withTenant`. Awaiting in place puts the
      // continuation inside the scope, which is where every extension expects to be.
      return tenantStorage.run({ ctx: { organizationId, userId }, tx }, async () => await fn(tx));
    },
    {
      maxWait: options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      isolationLevel: options.isolationLevel ?? Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
};

export { CrossTenantNestingError, MissingTenantContextError };

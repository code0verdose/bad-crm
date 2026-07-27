import { type PrismaClient } from '@prisma/client';

import { currentTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';
import { MissingTenantContextError } from '@/infrastructure/persistence/prisma/tenant.errors.js';

/**
 * Models that legitimately live outside a tenant scope, by name.
 *
 * An allow-list and not a derived set: "every model without `organizationId` is global" would turn
 * the most expensive mistake in this codebase — a new table that forgot its tenant column — into an
 * automatic exemption from the guard. Both entries are the [G] tables of
 * `docs/architecture/data-model.md`; they arrive with EPIC-011 and EPIC-013, and the guard is
 * written before them on purpose, so the first author of a global table finds the door already
 * built and labelled instead of switching the guard off.
 */
export const GLOBAL_MODELS: ReadonlySet<string> = new Set(['Permission', 'Activity']);

/** The shape Prisma hands to a `$allOperations` interceptor, narrowed to what the guard reads. */
export interface GuardedOperation {
  readonly model?: string | undefined;
  readonly operation: string;
  readonly args: unknown;
  readonly query: (args: never) => Promise<unknown>;
}

/**
 * The safety catch: a model operation outside `withTenant` never reaches the database.
 *
 * Without it such a query does reach it and fails there — `app.organization_id` is unset, so the
 * policy predicate raises `42704`/`22P02`. That is a correct outcome with a useless message,
 * arriving after a connection was taken from the pool and a transaction opened. Refusing in
 * process names the model and the operation, which is the difference between a five-minute fix and
 * an afternoon reading Postgres error codes.
 *
 * An operation Prisma cannot attribute to a model (raw SQL) is refused as well: the guard cannot
 * know whether the statement touches a tenant table, and the safe answer to that question is no.
 * Raw statements go through `requireTenant`, which asks for the context explicitly.
 */
export const guardTenantOperation = async ({
  model,
  operation,
  args,
  query,
}: GuardedOperation): Promise<unknown> => {
  if (model !== undefined && GLOBAL_MODELS.has(model)) return query(args as never);

  if (currentTenant() === undefined) {
    throw new MissingTenantContextError(`${model ?? 'raw'}.${operation}`);
  }

  return query(args as never);
};

/**
 * Wraps a client so that nothing but `withTenant` can use it. The composition root hands this out
 * and keeps the bare client to itself, so a repository has no way to obtain the unguarded one.
 */
export const guardedClient = (base: PrismaClient): PrismaClient =>
  base.$extends({
    name: 'tenant-guard',
    query: { $allModels: { $allOperations: guardTenantOperation } },
  }) as unknown as PrismaClient;

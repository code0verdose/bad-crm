import { type PrismaClient } from '@prisma/client';

import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';
import { translateTransientDatabaseFailure } from '@/infrastructure/persistence/prisma/transient-database-failure.util.js';

/**
 * `UnitOfWorkPort` on `withTenant`: one interactive transaction with the tenant pinned to it.
 *
 * It is constructed with the **base** client, not the guarded one — this is the single place
 * allowed to open a transaction, and `guardedClient` exists precisely to make every other path
 * fail. Repositories never see either handle: they read the transaction out of the scope this
 * call opens (`tenant-scoped.repository.ts`).
 *
 * The work function is invoked with no arguments even though `withTenant` offers the transaction,
 * so that a `TxClient` cannot travel into `application`, where nothing may hold a database handle
 * (rules/hexagonal-backend.mdc, rule 3).
 *
 * It is also where a transient database failure — a deadlock, a lock or serialization conflict, a
 * transaction that expired or never got a connection — becomes `503` with `Retry-After`
 * (`transient-database-failure.util.ts`). Here rather than in `TenantScopedRepository.run`, because
 * this is the only boundary every such failure crosses: `P2028` is raised by `$transaction` itself,
 * on the commit or while queueing for a connection, after every repository call has returned; the
 * repository base would never see it. And here rather than in the error handler, because
 * `presentation` may not know what a Prisma error is.
 */
export class PrismaUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly base: PrismaClient) {}

  async withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    try {
      return await withTenant(this.base, scope, () => work());
    } catch (error) {
      throw translateTransientDatabaseFailure(error);
    }
  }
}

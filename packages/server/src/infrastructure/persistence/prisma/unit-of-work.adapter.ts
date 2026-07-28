import { type PrismaClient } from '@prisma/client';

import {
  type TenantScope,
  type UnitOfWorkPort,
} from '@/application/platform/ports/unit-of-work.port.js';
import { withTenant } from '@/infrastructure/persistence/prisma/tenant.context.js';

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
 */
export class PrismaUnitOfWork implements UnitOfWorkPort {
  constructor(private readonly base: PrismaClient) {}

  withTenant<T>(scope: TenantScope, work: () => Promise<T>): Promise<T> {
    return withTenant(this.base, scope, () => work());
  }
}

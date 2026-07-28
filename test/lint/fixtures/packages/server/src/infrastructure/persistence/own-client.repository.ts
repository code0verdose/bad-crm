import { createPrismaClient } from '@/infrastructure/persistence/prisma/prisma.client.js';

/**
 * A repository holding its own client bypasses `withTenant` by construction: the handle it queries
 * through was never inside a tenant scope, so `guardedClient` cannot see the call and
 * `app.organization_id` is unset for every statement it sends.
 */
export class TeamRepository {
  private readonly client = createPrismaClient({ url: 'postgresql://x', logger: console });

  count(): Promise<unknown> {
    return Promise.resolve(this.client);
  }
}

declare const prisma: {
  team: { findFirst: (args: unknown) => Promise<unknown> };
};

/**
 * A repository that takes the tenant as an argument has a second source of truth for it, and the
 * two disagreeing is not an error: the policy filters against `app.organization_id`, so a mismatch
 * returns an empty result that reads like "no data" (`tenant-scoped.repository.ts`).
 */
export class TeamRepository {
  findById(organizationId: string, id: string): Promise<unknown> {
    return prisma.team.findFirst({ where: { organizationId, id } });
  }
}

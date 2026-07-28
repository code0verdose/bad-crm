declare const prisma: {
  $transaction: (batch: unknown) => Promise<unknown[]>;
  team: { findMany: () => Promise<unknown[]> };
  organization: { findMany: () => Promise<unknown[]> };
};

/**
 * The array form of `$transaction` opens no *interactive* transaction, so `withTenant` never runs
 * around it and `app.organization_id` is never set. Every statement in the batch is then judged by
 * the tenant policy against a context that does not exist — `rules/tenancy-rls.mdc` rule 10 bans it
 * everywhere, and inside `infrastructure/persistence` this is the layer where every other Prisma
 * ban is lifted, so the fixture has to live here.
 */
export const loadEverything = (): Promise<unknown[]> =>
  prisma.$transaction([prisma.team.findMany(), prisma.organization.findMany()]);

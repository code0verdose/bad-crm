declare const prisma: { $queryRawUnsafe: (sql: string) => Promise<unknown[]> };

/**
 * Inside `infrastructure/persistence` every other Prisma ban is lifted, which is exactly why this
 * one has to hold here too: the unsafe raw variants take a string, so the tenant predicate and the
 * bound values are whatever the caller concatenated.
 */
export const findTeamsNamed = (name: string): Promise<unknown[]> =>
  prisma.$queryRawUnsafe(`SELECT * FROM teams WHERE name = '${name}'`);

declare const prisma: { user: { findMany: () => Promise<unknown[]> } };

export const health = async (): Promise<unknown[]> => prisma.user.findMany();

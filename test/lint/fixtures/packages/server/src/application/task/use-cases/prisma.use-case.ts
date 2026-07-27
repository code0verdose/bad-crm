declare const prisma: { task: { findMany: () => Promise<unknown[]> } };

export const listTasks = async (): Promise<unknown[]> => prisma.task.findMany();

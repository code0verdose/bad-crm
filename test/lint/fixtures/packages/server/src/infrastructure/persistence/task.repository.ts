declare const prisma: { task: { findMany: () => Promise<unknown[]> } };

export const findTasks = async (): Promise<unknown[]> => prisma.task.findMany();

import { prismaClient } from '@/infrastructure/persistence/prisma.client';

export const run = (): unknown => prismaClient;

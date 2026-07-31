import { PrismaClient } from '@prisma/client';
import { config } from './config';

let prisma: PrismaClient | null = null;

export function hasDb(): boolean {
  return !!config.databaseUrl;
}

export function getPrisma(): PrismaClient {
  if (!hasDb()) throw new Error('DATABASE_URL не задан');
  if (!prisma) prisma = new PrismaClient();
  return prisma;
}

export async function disconnectDb(): Promise<void> {
  if (prisma) await prisma.$disconnect();
}

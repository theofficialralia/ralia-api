import { PrismaClient } from '@prisma/client';
import * as dotenv from 'dotenv';

dotenv.config();

/** A Prisma client bound to the test database, never the dev one. */
export function testPrisma(): PrismaClient {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set');
  return new PrismaClient({ datasources: { db: { url } } });
}

/** Wipes ledger state between tests. Ledger tables are append-only in the app; the test suite is the one exception. */
export async function resetLedger(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE ledger_entries, ledger_transactions, accounts RESTART IDENTITY CASCADE');
}

import { execSync } from 'node:child_process';

import { PrismaClient } from '@prisma/client';

import {
  adminDatabaseUrl,
  testDatabaseName,
  testDatabaseUrl,
} from './test-db-url';

/**
 * Runs once for the whole test run:
 *   1. create the `oxeio_test` database (if missing)
 *   2. apply all migrations to it
 *
 * The seed is deliberately not run: each test sets up its own fixtures,
 * otherwise changing the seed would break tests.
 */
export default async function setup(): Promise<void> {
  const dbName = testDatabaseName();

  const admin = new PrismaClient({
    datasources: { db: { url: adminDatabaseUrl() } },
  });

  try {
    const existing = await admin.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM pg_database WHERE datname = '${dbName}'`,
    );
    if (Number(existing[0]?.count ?? 0) === 0) {
      // CREATE DATABASE cannot run inside a transaction, hence $executeRawUnsafe
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await admin.$disconnect();
  }

  // Not execFileSync: on Windows, spawning a `.cmd` directly gives Node EINVAL
  // (a security change in Node 20+). execSync uses a shell, so it is safe.
  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
  });
}

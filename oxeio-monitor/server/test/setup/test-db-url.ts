/**
 * Tests never touch the dev database: they run in a separate `*_test`
 * database on the same Postgres instance.
 *
 * Note: [02-Workflow §9](../../../docs/02-Workflow.md) mentions Testcontainers.
 * It was deliberately not adopted: Postgres already runs in docker compose,
 * and starting a fresh container per run costs 30+ seconds and a dependency
 * for nothing. With a service container in CI, this same code works.
 */
export function testDatabaseUrl(): string {
  const base = process.env.DATABASE_URL;
  if (!base) {
    throw new Error(
      'DATABASE_URL is not set — run the tests with `npm test` (it loads ../.env)',
    );
  }

  const url = new URL(base);
  const dbName = url.pathname.replace(/^\//, '') || 'oxeio';
  if (dbName.endsWith('_test')) return base;

  url.pathname = `/${dbName}_test`;
  return url.toString();
}

/** To run `CREATE DATABASE` you have to connect to a different database */
export function adminDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL as string);
  url.pathname = '/postgres';
  return url.toString();
}

export function testDatabaseName(): string {
  return new URL(testDatabaseUrl()).pathname.replace(/^\//, '');
}

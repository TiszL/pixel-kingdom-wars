/**
 * Test database wiring. Tests run against the dockerized Postgres from
 * infra/docker-compose.yml (host port 5433) using a DEDICATED database that
 * global-setup drops and recreates per run — never the dev database.
 */
/** Connect outside the disposable target so global setup can drop/recreate it.
 * `postgres` is the built-in maintenance database in both the local Compose
 * image and GitHub's clean Postgres service; the development `shardkeep` DB is
 * not guaranteed to exist in CI. */
export const ADMIN_DATABASE_URL =
  process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://shardkeep:shardkeep@localhost:5433/postgres';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://shardkeep:shardkeep@localhost:5433/shardkeep_test';

export function testDbName(): string {
  const name = new URL(TEST_DATABASE_URL).pathname.slice(1);
  if (!name.endsWith('_test')) {
    throw new Error(`refusing to manage test db '${name}': name must end with _test`);
  }
  return name;
}

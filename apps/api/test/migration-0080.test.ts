/**
 * The opaque avatar endpoint resolves a UUID without exposing a wallet. The
 * database must make that lookup indexed and unambiguous while still allowing
 * every avatar-less player to keep a NULL generation.
 */
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_PREFIX = 'shardkeep_migration_0080_';

function assertDisposableDbName(name: string): void {
  if (!new RegExp(`^${DB_PREFIX}[0-9a-f]{32}_test$`).test(name)) {
    throw new Error(`refusing to manage unexpected database name: ${name}`);
  }
}

describe('migration 0080 avatar generation identity', () => {
  it('allows many NULL pointers but rejects an ambiguous opaque generation', async () => {
    const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
    assertDisposableDbName(databaseName);
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const databaseUrl = new URL(ADMIN_DATABASE_URL);
    databaseUrl.pathname = `/${databaseName}`;
    let conn: ReturnType<typeof createDb> | undefined;

    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      conn = createDb(databaseUrl.toString(), { max: 1 });
      await migrate(conn.db, { migrationsFolder: MIGRATIONS });

      const [index] = await conn.sql<{ indexdef: string }[]>`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'players'
          AND indexname = 'players_avatar_generation_uq'
      `;
      expect(index?.indexdef).toContain('UNIQUE INDEX');
      expect(index?.indexdef).toContain('(avatar_generation)');
      expect(index?.indexdef).toContain('WHERE (avatar_generation IS NOT NULL)');

      await conn.sql`
        INSERT INTO players (wallet) VALUES ('avatar-null-a'), ('avatar-null-b')
      `;
      const generation = randomUUID();
      const hash = 'a'.repeat(64);
      await conn.sql`
        UPDATE players
        SET avatar_hash = ${hash}, avatar_generation = ${generation}
        WHERE wallet = 'avatar-null-a'
      `;
      await expect(conn.sql`
        UPDATE players
        SET avatar_hash = ${hash}, avatar_generation = ${generation}
        WHERE wallet = 'avatar-null-b'
      `).rejects.toMatchObject({ code: '23505' });
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

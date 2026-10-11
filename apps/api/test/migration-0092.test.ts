import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_PREFIX = 'shardkeep_migration_0092_';

describe('migration 0092 standalone invite batches', () => {
  it('creates the atomic/idempotent audit schema and enforces its bounds', async () => {
    const databaseName = `${DB_PREFIX}${randomUUID().replaceAll('-', '')}_test`;
    if (!new RegExp(`^${DB_PREFIX}[0-9a-f]{32}_test$`).test(databaseName)) throw new Error('unsafe database name');
    const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
    const databaseUrl = new URL(ADMIN_DATABASE_URL);
    databaseUrl.pathname = `/${databaseName}`;
    let conn: ReturnType<typeof createDb> | undefined;
    try {
      await admin.unsafe(`CREATE DATABASE ${databaseName}`);
      conn = createDb(databaseUrl.toString(), { max: 1 });
      await migrate(conn.db, { migrationsFolder: MIGRATIONS });

      const indexes = await conn.sql<{ indexname: string }[]>`
        select indexname from pg_indexes where schemaname = 'public'
          and indexname in (
            'alpha_invite_batches_creator_idem_uq',
            'alpha_invite_codes_batch_ordinal_uq',
            'alpha_invite_codes_code_unique'
          ) order by indexname
      `;
      expect(indexes.map(({ indexname }) => indexname)).toEqual([
        'alpha_invite_batches_creator_idem_uq',
        'alpha_invite_codes_batch_ordinal_uq',
        'alpha_invite_codes_code_unique',
      ]);

      const key = randomUUID();
      const [batch] = await conn.sql<{ id: string }[]>`
        insert into alpha_invite_batches (idempotency_key, created_by_wallet, requested_count)
        values (${key}, 'admin-wallet', 1) returning id
      `;
      await conn.sql`
        insert into alpha_invite_codes (batch_id, code, ordinal)
        values (${batch!.id}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 0)
      `;
      await expect(conn.sql`
        insert into alpha_invite_batches (idempotency_key, created_by_wallet, requested_count)
        values (${randomUUID()}, 'admin-wallet', 101)
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'alpha_invite_batches_count_ck' });
      await expect(conn.sql`
        insert into alpha_invite_batches (idempotency_key, created_by_wallet, requested_count)
        values (${key}, 'admin-wallet', 1)
      `).rejects.toMatchObject({ code: '23505', constraint_name: 'alpha_invite_batches_creator_idem_uq' });
      await expect(conn.sql`
        insert into alpha_invite_codes (batch_id, code, ordinal)
        values (${batch!.id}, 'not-a-valid-code', 1)
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'alpha_invite_codes_shape_ck' });
      await expect(conn.sql`
        update alpha_invite_codes set redeemed_wallet = 'wallet-without-time'
        where batch_id = ${batch!.id}
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'alpha_invite_codes_redemption_pair_ck' });
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

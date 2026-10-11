import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_PREFIX = 'shardkeep_migration_0083_';

describe('migration 0083 M22 mail/trap persistence', () => {
  it('creates additive enums, trap state, private mail integrity and system-only escrows', async () => {
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
      const enumRows = await conn.sql<{ enumlabel: string }[]>`
        select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
        where (t.typname = 'account_kind' and e.enumlabel in ('mail_keep_escrow','mail_shards_escrow'))
           or (t.typname = 'building_type' and e.enumlabel in ('airdefence','powdermine','pitfall','airmine','clanhall'))
           or (t.typname = 'builder_job_kind' and e.enumlabel = 'repair')
      `;
      expect(enumRows.map((row) => row.enumlabel).sort()).toEqual([
        'airdefence', 'airmine', 'clanhall', 'mail_keep_escrow', 'mail_shards_escrow', 'pitfall', 'powdermine', 'repair',
      ]);
      const columns = await conn.sql<{ table_name: string; column_name: string }[]>`
        select table_name, column_name from information_schema.columns
        where table_schema = 'public' and (
          (table_name = 'buildings' and column_name = 'trap_spent_at')
          or (table_name = 'mail_messages' and column_name in ('recipient_wallet','reward_state','expires_at'))
          or (table_name = 'mail_attachments' and column_name in ('message_id','kind','amount','qty'))
        )
      `;
      expect(columns).toHaveLength(8);
      const constraints = await conn.sql<{ conname: string }[]>`
        select conname from pg_constraint where conname in (
          'mail_messages_sender_ck','mail_messages_lifecycle_ck','mail_attachments_payload_ck',
          'mail_messages_recipient_dedupe_uq','accounts_owner_scope_ck'
        ) order by conname
      `;
      expect(constraints.map((row) => row.conname)).toEqual([
        'accounts_owner_scope_ck', 'mail_attachments_payload_ck', 'mail_messages_lifecycle_ck',
        'mail_messages_recipient_dedupe_uq', 'mail_messages_sender_ck',
      ]);

      const wallet = '11111111111111111111111111111111';
      await conn.sql`insert into players (wallet) values (${wallet})`;
      await expect(conn.sql`
        insert into accounts (owner_wallet, kind, currency) values (${wallet}, 'mail_keep_escrow', 'KEEP')
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'accounts_owner_scope_ck' });
      await expect(conn.sql`
        insert into mail_messages
          (recipient_wallet,sender_kind,sender_wallet,kind,dedupe_key,subject,body)
        values (${wallet},'system',${wallet},'info','bad-sender','x','x')
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'mail_messages_sender_ck' });
      await expect(conn.sql`
        insert into mail_messages
          (recipient_wallet,sender_kind,kind,dedupe_key,subject,body,reward_state,expires_at,claimed_at)
        values (${wallet},'system','reward','bad-state','x','x','pending',now(),now())
      `).rejects.toMatchObject({ code: '23514', constraint_name: 'mail_messages_lifecycle_ck' });
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

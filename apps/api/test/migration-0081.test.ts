import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runMigrations as migrate } from '../src/db/migrate';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';

const MIGRATIONS = fileURLToPath(new URL('../drizzle', import.meta.url));
const DB_PREFIX = 'shardkeep_migration_0081_';

describe('migrations 0081–0082 global chat', () => {
  it('creates the complete runtime schema and integrity constraints', async () => {
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
            'global_chat_messages_author_client_uq', 'global_chat_reports_message_reporter_uq',
            'global_chat_reports_retention_idx', 'global_chat_rate_limits_retention_idx'
          )
      `;
      expect(indexes.map((row) => row.indexname).sort()).toEqual([
        'global_chat_messages_author_client_uq', 'global_chat_rate_limits_retention_idx',
        'global_chat_reports_message_reporter_uq', 'global_chat_reports_retention_idx',
      ]);
      const columns = await conn.sql<{ table_name: string; column_name: string; is_nullable: string; column_default: string | null }[]>`
        select table_name, column_name, is_nullable, column_default
        from information_schema.columns
        where table_schema = 'public' and (
          (table_name = 'global_chat_messages' and column_name in
            ('author_name_at_send', 'author_seeker_verified_at_send'))
          or (table_name = 'global_chat_reports' and column_name in
            ('evidence_author_name', 'evidence_seeker_verified', 'resolved_at', 'resolved_by', 'resolution'))
          or (table_name = 'game_config' and column_name = 'global_chat_enabled')
        )
      `;
      expect(columns).toHaveLength(8);
      expect(columns.find((row) => row.column_name === 'global_chat_enabled'))
        .toMatchObject({ is_nullable: 'NO', column_default: 'true' });
      expect(columns.filter((row) => [
        'author_name_at_send', 'author_seeker_verified_at_send',
        'evidence_author_name', 'evidence_seeker_verified',
      ].includes(row.column_name)).every((row) => row.is_nullable === 'NO')).toBe(true);
      const constraints = await conn.sql<{ conname: string }[]>`
        select conname from pg_constraint where conname in (
          'global_chat_blocks_not_self_ck', 'global_chat_events_kind_ck',
          'global_chat_reports_resolution_ck', 'global_chat_moderation_audit_action_ck'
        ) order by conname
      `;
      expect(constraints.map((row) => row.conname)).toEqual([
        'global_chat_blocks_not_self_ck', 'global_chat_events_kind_ck',
        'global_chat_moderation_audit_action_ck', 'global_chat_reports_resolution_ck',
      ]);
    } finally {
      await conn?.sql.end();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});

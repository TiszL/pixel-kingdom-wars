import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { ADMIN_DATABASE_URL } from './db-url';

it('replays replay-safe M42 migrations and preserves canonically applied 0146 history and paid guards', async () => {
  const name = `m42_repeat_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    conn = createDb(url.toString(), { max: 1 });
    const { db, sql } = conn;
    await runMigrations(db);
    const wallet = `m42_repeat_${randomUUID()}`;
    await sql`INSERT INTO players (wallet) VALUES (${wallet})`;
    const [base] = await sql`INSERT INTO bases (owner_wallet) VALUES (${wallet}) RETURNING id`;
    const operation = randomUUID();
    await sql.begin(async tx => {
      await tx`INSERT INTO resource_stock_operations (id, kind, base_id, resource_id, quantity, custody_wallet)
        VALUES (${operation}, 'reserve', ${base!.id}, 'crown_iron_ore', 2, ${wallet})`;
      await tx`INSERT INTO resource_stock_entries (operation_id, bucket, delta)
        VALUES (${operation}, 'available', -2), (${operation}, 'reserved', 2)`;
      await tx`INSERT INTO resource_stocks (base_id, resource_id, available, reserved)
        VALUES (${base!.id}, 'crown_iron_ore', 7, 2)`;
    });
    const snapshot = async () => ({
      stock: await sql`SELECT * FROM resource_stocks ORDER BY base_id, resource_id`,
      operations: await sql`SELECT * FROM resource_stock_operations ORDER BY id`,
      entries: await sql`SELECT * FROM resource_stock_entries ORDER BY operation_id, bucket`,
      journal: await sql`SELECT * FROM drizzle.__drizzle_migrations ORDER BY id`,
      functions: await sql`SELECT oid::text, proname, proacl, obj_description(oid, 'pg_proc') AS comment, pg_get_functiondef(oid) AS definition
        FROM pg_catalog.pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'
        ORDER BY oid`,
      constraints: await sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition
        FROM pg_catalog.pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY oid`,
      triggers: await sql`SELECT t.oid::text, t.tgname, t.tgenabled, pg_get_triggerdef(t.oid) AS definition
        FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
        WHERE c.relnamespace='public'::regnamespace ORDER BY t.oid`,
      relations: await sql`SELECT oid::text, relname, relfilenode::text, relacl
        FROM pg_catalog.pg_class WHERE relnamespace='public'::regnamespace AND relkind IN ('r','i') ORDER BY oid`,
    });
    const before = await snapshot();
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: Array<{ tag: string; when: number }>;
    };
    const m42Tags = journal.entries.map(entry => entry.tag).filter(tag => /^01(3[9]|4[0-9]|5[0-3])_/.test(tag));
    expect(m42Tags).toHaveLength(15);
    // Production applied ORIGINAL 0146. A QA database rebuilt from edited 0146
    // needs separately authorized recreation; never rewrite its journal. Applied
    // bytes are immutable: the canonical migrator compares hashes and never re-executes a file
    // (src/db/migrate.ts:46-47,50). Direct replay after 0185 is forbidden because
    // it reinstalls the earlier body. Keep every other per-file replay below.
    // The dedicated migration-0146-history-repair.fixture.ts additionally starts
    // with an ORIGINAL-0146 database and proves canonical upgrade through head.
    const original0146 = journal.entries.find(entry => entry.tag === '0146_starter_common_access');
    expect(original0146).toBeDefined();
    expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=${original0146!.when}`)
      .toEqual([{ hash: 'b1aec76ffa99064fba9c360674f5dd2be600b540292ad8a7ce7174fb629d6fcb' }]);
    const paidSql = await readFile(new URL('../drizzle/0185_starter_paid_access.sql', import.meta.url), 'utf8');
    const paidBodyStart = paidSql.indexOf('AS $$');
    const paidBodyEnd = paidSql.indexOf('$$;', paidBodyStart + 5);
    expect(paidBodyStart).toBeGreaterThanOrEqual(0);
    expect(paidBodyEnd).toBeGreaterThan(paidBodyStart);
    const paidBody = paidSql.slice(paidBodyStart + 5, paidBodyEnd);
    expect(paidBody.trim().length).toBeGreaterThan(0);
    expect(await sql`SELECT prosrc AS body, obj_description(oid, 'pg_proc') AS comment
      FROM pg_proc WHERE oid=to_regprocedure('public.shardkeep_starter_expedition_insert_guard()')`)
      .toEqual([{ body: paidBody, comment: 'phase-e:starter-expedition-guard:paid-access-v1' }]);
    // 2026-10-10 (CI 37503885235): 0267 (ordinary kits, 7191719af, 2026-09-30) replaced the 0147 crafting
    // guard and proof bodies with the v2-kit versions, so a direct 0147 replay now reinstalls the v1-only
    // guard — the same earlier-body hazard as 0146 after 0185. Pin the applied 0147 bytes and the 0267 head
    // bodies instead; every other M42 file keeps its per-file replay below.
    const crafting = journal.entries.find(entry => entry.tag === '0147_ordinary_crafting');
    expect(crafting).toBeDefined();
    const craftingSql = await readFile(new URL('../drizzle/0147_ordinary_crafting.sql', import.meta.url), 'utf8');
    expect(await sql`SELECT hash FROM drizzle.__drizzle_migrations WHERE created_at=${crafting!.when}`)
      .toEqual([{ hash: createHash('sha256').update(craftingSql).digest('hex') }]);
    const kitsSql = await readFile(new URL('../drizzle/0267_ordinary_kits.sql', import.meta.url), 'utf8');
    for (const fn of ['shardkeep_ordinary_crafting_guard', 'shardkeep_ordinary_crafting_proof']) {
      const start = kitsSql.indexOf('AS $$', kitsSql.indexOf(`FUNCTION public.${fn}()`));
      const end = kitsSql.indexOf('$$;', start + 5);
      expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
      expect(await sql`SELECT prosrc FROM pg_proc WHERE oid=to_regprocedure(${`public.${fn}()`})`)
        .toEqual([{ prosrc: kitsSql.slice(start + 5, end) }]);
    }
    const tags = m42Tags.filter(tag => tag !== '0146_starter_common_access' && tag !== '0147_ordinary_crafting');
    expect(tags).toHaveLength(13);
    await sql`SET lock_timeout = '321ms'`;
    for (const tag of tags) {
      const migration = await readFile(new URL(`../drizzle/${tag}.sql`, import.meta.url), 'utf8');
      await sql.begin(async tx => {
        for (const statement of migration.split('--> statement-breakpoint')) {
          if (statement.trim()) await tx.unsafe(statement);
        }
      });
      // Compare after EACH commit: replaying an early migration must not
      // briefly restore its weaker function before a later file repairs it.
      expect(await snapshot(), tag).toEqual(before);
      expect(await sql`SHOW lock_timeout`).toEqual([{ lock_timeout: '321ms' }]);
    }
    await expect(sql`UPDATE resource_stock_operations SET quantity=3 WHERE id=${operation}`)
      .rejects.toThrow('raw stock operation evidence is immutable');
    await expect(sql`DELETE FROM resource_stock_entries WHERE operation_id=${operation}`)
      .rejects.toThrow('raw stock operation evidence is immutable');
    await expect(sql.begin(async tx => {
      await tx`INSERT INTO resource_stock_operations (id, kind, base_id, resource_id, quantity, custody_wallet)
        VALUES (${randomUUID()}, 'reserve', ${base!.id}, 'crown_iron_ore', 2, ${wallet})`;
    })).rejects.toThrow('raw stock proof must have exact balanced entries');
    // Refuse an old experimental schema rather than dropping its stricter
    // CHECK behind an operator's back. The fixture alteration rolls back.
    const raidMigration = await readFile(new URL('../drizzle/0144_raw_raid_stock.sql', import.meta.url), 'utf8');
    await expect(sql.begin(async tx => {
      await tx`ALTER TABLE resource_stock_entries DROP CONSTRAINT resource_stock_entries_delta_ck`;
      await tx`ALTER TABLE resource_stock_entries ADD CONSTRAINT resource_stock_entries_delta_ck
        CHECK (delta <> 0 AND delta >= -9223372036854775807)`;
      for (const statement of raidMigration.split('--> statement-breakpoint')) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    })).rejects.toThrow('experimental raw entry nonzero constraint requires operator review');
    await runMigrations(db);
    expect(await snapshot()).toEqual(before);
  } finally {
    await conn?.sql.end();
    try { await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); }
    finally { await admin.end(); }
  }
}, 120_000);

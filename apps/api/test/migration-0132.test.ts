/** A wider legal expansion index must never grant land, move saved coordinates,
 * rewrite replay history or reprice a payment already in flight. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPS } from '@shardkeep/shared';
import postgres from 'postgres';
import { runMigrations as migrate } from '../src/db/migrate';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';

it('0132 preserves historical rows and widens only the legal base expansion range', async () => {
  const name = `expansion_upgrade_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0132-'));
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await cp(fileURLToPath(new URL('../drizzle/', import.meta.url)), dir, { recursive: true });
    const journalPath = path.join(dir, 'meta/_journal.json');
    const complete = await readFile(journalPath, 'utf8');
    const journal = JSON.parse(complete) as { entries: Array<{ tag: string }> };
    const index = journal.entries.findIndex(e => e.tag === '0132_base_expansions_50');
    expect(index).toBe(132);
    journal.entries = journal.entries.slice(0, index);
    await writeFile(journalPath, JSON.stringify(journal));
    conn = createDb(url.toString(), { max: 4 });
    await migrate(conn.db, { migrationsFolder: dir });
    const sql = conn.sql;
    const wallet = `expansion-history-${randomUUID()}`;
    await sql`INSERT INTO players(wallet, expansions) VALUES(${wallet},6)`;
    for (let expansions = 0; expansions <= 6; expansions++) {
      const [base] = await sql`INSERT INTO bases(owner_wallet, expansions, keep_level, land_paid_at)
        VALUES(${wallet},${expansions},20,'2026-09-15T00:00:00Z') RETURNING id`;
      await sql`INSERT INTO buildings(player_wallet,base_id,type,level,tx,ty)
        VALUES(${wallet},${base!.id},'keep',20,14,14)`;
    }
    await sql`INSERT INTO raids(attacker_wallet,seed,snapshot,army_snapshot,orders_deadline_at)
      VALUES(${wallet},17,'{"buildings":[{"type":"keep","tx":14,"ty":14}],"claimMin":2,"claimMax":28}'::jsonb,
        '{"counts":{"bowman":3}}'::jsonb,'2026-09-15T00:00:00Z')`;
    await sql`INSERT INTO deposits(player_wallet,kind,reference,payload)
      VALUES(${wallet},'expansion',${randomUUID()},'{"expectedExpansions":5,"amountLamports":1500000000}'::jsonb)`;
    const rows = async () => ({
      players: await sql`SELECT to_jsonb(r)::text AS row FROM players r ORDER BY wallet`,
      bases: await sql`SELECT to_jsonb(r)::text AS row FROM bases r ORDER BY id`,
      buildings: await sql`SELECT to_jsonb(r)::text AS row FROM buildings r ORDER BY id`,
      raids: await sql`SELECT to_jsonb(r)::text AS row FROM raids r ORDER BY id`,
      deposits: await sql`SELECT to_jsonb(r)::text AS row FROM deposits r ORDER BY id`,
    });
    const before = await rows();
    const [target] = await sql`SELECT id FROM bases ORDER BY id LIMIT 1`;
    await expect(sql`UPDATE bases SET expansions=7 WHERE id=${target!.id}`).rejects.toMatchObject({ code: '23514' });
    await writeFile(journalPath, complete);
    await migrate(conn.db, { migrationsFolder: dir });
    expect(await rows()).toEqual(before);
    await migrate(conn.db, { migrationsFolder: dir });
    expect(await rows()).toEqual(before);
    for (let expansions = 0; expansions <= CAPS.expansionsMax; expansions++) {
      await sql`UPDATE bases SET expansions=${expansions} WHERE id=${target!.id}`;
    }
    for (const expansions of [-1, CAPS.expansionsMax + 1]) {
      await expect(sql`UPDATE bases SET expansions=${expansions} WHERE id=${target!.id}`).rejects.toMatchObject({ code: '23514' });
    }
  } finally {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}, FRESH_DB_CASE_MS);

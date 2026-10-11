/** Full-world art must widen presentation compatibility without repainting
 * existing raid history or changing any frozen simulator input. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations as migrate } from '../src/db/migrate';
import { expect, it } from 'vitest';
import { CURRENT_BASE_VISUAL, DEFAULT_BASE_VISUAL, REALM_IDS } from '@shardkeep/shared/baseVisual';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';

it('0122 preserves complete historical rows and only admits known numeric art versions', async () => {
  const name = `terrain_upgrade_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0122-'));
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await cp(fileURLToPath(new URL('../drizzle/', import.meta.url)), dir, { recursive: true });
    const journalPath = path.join(dir, 'meta/_journal.json');
    const complete = await readFile(journalPath, 'utf8');
    const journal = JSON.parse(complete) as { entries: Array<{ tag: string }> };
    const index = journal.entries.findIndex(e => e.tag === '0122_full_world_ground');
    expect(index).toBe(122);
    journal.entries = journal.entries.slice(0, index);
    await writeFile(journalPath, JSON.stringify(journal));
    conn = createDb(url.toString(), { max: 4 });
    await migrate(conn.db, { migrationsFolder: dir });
    const sql = conn.sql;
    const wallet = `terrain-history-${randomUUID()}`;
    await sql`INSERT INTO players(wallet) VALUES(${wallet})`;
    const historic = [null, ...REALM_IDS.map(realmId => ({ ...DEFAULT_BASE_VISUAL, realmId }))];
    for (const context of historic) {
      await sql`INSERT INTO raids(attacker_wallet,seed,snapshot,army_snapshot,orders_deadline_at,visual_context)
        VALUES(${wallet},17,'{"buildings":[{"type":"keep","tx":12,"ty":12}]}'::jsonb,
          '{"counts":{"bowman":3}}'::jsonb,'2026-09-10T00:00:00Z',
          ${context === null ? null : JSON.stringify(context)}::jsonb)`;
    }
    const rowsBefore = await sql`SELECT to_jsonb(r)::text AS row FROM raids r ORDER BY id`;
    const [target] = await sql`SELECT id FROM raids ORDER BY id LIMIT 1`;
    await expect(sql`UPDATE raids SET visual_context=${JSON.stringify(CURRENT_BASE_VISUAL)}::jsonb
      WHERE id=${target!.id}`).rejects.toMatchObject({ code: '23514' });
    await writeFile(journalPath, complete);
    await migrate(conn.db, { migrationsFolder: dir });
    expect(await sql`SELECT to_jsonb(r)::text AS row FROM raids r ORDER BY id`).toEqual(rowsBefore);
    await migrate(conn.db, { migrationsFolder: dir });
    expect(await sql`SELECT to_jsonb(r)::text AS row FROM raids r ORDER BY id`).toEqual(rowsBefore);

    for (const artVersion of [1, 2]) for (const realmId of REALM_IDS) {
      await sql`UPDATE raids SET visual_context=${JSON.stringify({ version: 1, realmId, artVersion })}::jsonb
        WHERE id=${target!.id}`;
    }
    for (const invalid of [null, {}, [], '2', { ...CURRENT_BASE_VISUAL, version: 2 },
      { ...CURRENT_BASE_VISUAL, realmId: 'unknown' }, { ...CURRENT_BASE_VISUAL, artVersion: 3 },
      { ...CURRENT_BASE_VISUAL, artVersion: '2' }, { ...CURRENT_BASE_VISUAL, artVersion: null },
      { ...CURRENT_BASE_VISUAL, artVersion: 1.5 }, { version: 1, realmId: 'crownlands' }]) {
      await expect(sql`UPDATE raids SET visual_context=${JSON.stringify(invalid)}::jsonb
        WHERE id=${target!.id}`).rejects.toMatchObject({ code: '23514' });
    }
    await sql`UPDATE raids SET visual_context=NULL WHERE id=${target!.id}`;
  } finally {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}, FRESH_DB_CASE_MS);

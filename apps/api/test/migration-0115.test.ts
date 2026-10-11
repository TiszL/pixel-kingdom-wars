/** A correction may replace a draft projection, never erase the first receipt
 * or silently rewrite a campaign that has already been scheduled/closed. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { runMigrations as migrate } from '../src/db/migrate';
import { expect, it } from 'vitest';
import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { createDb } from '../src/db/client';
import { ADMIN_DATABASE_URL } from './db-url';
import { FRESH_DB_CASE_MS } from './freshDbCaseBudgets';
import { snapshotPlaytestFounders } from '../src/game/playtestCampaigns';

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const oldAt = '2026-09-08T06:40:29.113Z';
async function priorDatabase(run: (conn: ReturnType<typeof createDb>, upgrade: () => Promise<void>, repair: string) => Promise<void>) {
  const name = `founder_upgrade_${randomUUID().replaceAll('-', '')}_test`;
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${name}`;
  const dir = await mkdtemp(path.join(tmpdir(), 'shardkeep-0115-'));
  let conn: ReturnType<typeof createDb> | undefined;
  try {
    await admin.unsafe(`CREATE DATABASE ${name}`);
    await cp(migrations, dir, { recursive: true });
    const journalPath = path.join(dir, 'meta/_journal.json');
    const complete = await readFile(journalPath, 'utf8');
    const journal = JSON.parse(complete) as { entries: Array<{ tag: string }> };
    const index = journal.entries.findIndex(e => e.tag === '0115_founding_player_eligibility');
    expect(index).toBe(115);
    journal.entries = journal.entries.slice(0, index);
    await writeFile(journalPath, JSON.stringify(journal));
    conn = createDb(url.toString(), { max: 4 });
    await migrate(conn.db, { migrationsFolder: dir });
    const sql = await readFile(path.join(dir, '0115_founding_player_eligibility.sql'), 'utf8');
    await run(conn, async () => {
      await writeFile(journalPath, complete);
      await migrate(conn!.db, { migrationsFolder: dir });
    }, sql.slice(sql.indexOf('DO $$')));
  } finally {
    await conn?.sql.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}

async function v1(conn: ReturnType<typeof createDb>) {
  await conn.sql`insert into playtest_campaigns(id,kind,snapshot_at,revision)
    values(${RULES.foundingId},'founding',${oldAt},2)`;
  for (let i = 0; i < RULES.founderSpots; i++) {
    const asset = `original-asset-${i}`;
    const wallet = `collection-original-${i}`;
    await conn.sql`insert into playtest_mint_evidence(asset_id,original_wallet,confirmed_at,slot,transaction_index,signature,verified_at)
      values(${asset},${wallet},${oldAt},${String(i)},0,${`sig-${i}`},${oldAt})`;
    await conn.sql`insert into playtest_founders(wallet,position,username,asset_id,evidence,snapshot_at)
      values(${wallet},${i + 1},${i % 2 ? '' : 'Original name'},${asset},${JSON.stringify({ signature: `sig-${i}`, slot: String(i) })}::jsonb,${oldAt})`;
  }
  await conn.sql`insert into playtest_mint_inventory values('land-deeds','1000',${RULES.founderSpots},${oldAt})`;
  await conn.sql`insert into playtest_campaign_audit(campaign_id,request_id,actor,action,request_hash,revision,detail,result,created_at)
    values(${RULES.foundingId},'system:founder-snapshot-v1','system','founder-snapshot','original-hash',2,'{}','{}',${oldAt})`;
}

it('fresh install adds exact durable owner exclusions without fabricating a snapshot', async () => {
  await priorDatabase(async (conn, upgrade) => {
    await upgrade();
    const rows = await conn.sql`select * from playtest_internal_wallets`;
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.evidence.displayNameAtVerification).sort()).toEqual(['Gokhan', 'Tisz', 'Torqueond']);
    expect(rows.every(r => r.evidence.fullSession && r.evidence.originalMintSignature)).toBe(true);
    expect(await conn.sql`select * from playtest_founders`).toHaveLength(0);
    expect(await conn.sql`select * from playtest_campaign_audit`).toHaveLength(0);
    await upgrade();
    expect(await conn.sql`select * from playtest_internal_wallets`).toHaveLength(3);
  });
}, FRESH_DB_CASE_MS);

it('archives every v1 row and original receipt, clears only draft projection, and is idempotent', async () => {
  await priorDatabase(async (conn, upgrade, repair) => {
    await v1(conn);
    const [prior] = await conn.sql`select jsonb_agg(to_jsonb(f) order by position) as rows from playtest_founders f`;
    const [campaign] = await conn.sql`select to_jsonb(c) as row from playtest_campaigns c`;
    await upgrade();
    const [receipt] = await conn.sql`select * from playtest_campaign_audit where action='founder-snapshot-superseded'`;
    expect(receipt!.detail.previousFounders).toEqual(prior!.rows);
    expect(receipt!.detail.previousCampaign).toEqual(campaign!.row);
    expect(receipt!.revision).toBe(3);
    expect(receipt!.request_hash).toMatch(/^[a-f0-9]{64}$/);
    expect((await conn.sql`select request_hash from playtest_campaign_audit where request_id='system:founder-snapshot-v1'`)[0]!.request_hash).toBe('original-hash');
    expect(await conn.sql`select * from playtest_founders`).toHaveLength(0);
    expect(await conn.sql`select * from playtest_mint_evidence`).toHaveLength(RULES.founderSpots);
    expect(await conn.sql`select * from playtest_mint_inventory`).toHaveLength(1);
    expect((await conn.sql`select snapshot_at,revision from playtest_campaigns`)[0]).toMatchObject({ snapshot_at: null, revision: 3 });
    await conn.sql.unsafe(repair);
    await upgrade();
    expect(await conn.sql`select * from playtest_campaign_audit`).toHaveLength(2);
    // The corrected 50th actual game minter can freeze exactly once under the
    // new key, even while two workers race; v1 history remains unchanged.
    for (let i = 0; i < RULES.founderSpots; i++) {
      const wallet = `real-game-original-${i}`; const asset = `real-game-asset-${i}`;
      await conn.sql`insert into players(wallet) values(${wallet})`;
      await conn.sql`insert into sessions(wallet,expires_at) values(${wallet},${oldAt})`;
      await conn.sql`insert into bases(owner_wallet,deed_asset_id) values(${wallet},${asset})`;
      await conn.sql`insert into playtest_mint_evidence(asset_id,original_wallet,confirmed_at,slot,transaction_index,signature,verified_at)
        values(${asset},${wallet},${oldAt},${String(100 + i)},0,${`real-sig-${i}`},${oldAt})`;
    }
    await conn.sql`update playtest_mint_inventory set asset_count=${RULES.founderSpots * 2}`;
    await Promise.all([snapshotPlaytestFounders(conn.db, [], new Date(oldAt)), snapshotPlaytestFounders(conn.db, [], new Date(oldAt))]);
    expect(await conn.sql`select * from playtest_founders`).toHaveLength(RULES.founderSpots);
    expect(await conn.sql`select * from playtest_campaign_audit where request_id='system:founder-snapshot-v2'`).toHaveLength(1);
    await conn.sql.unsafe(repair);
    expect(await conn.sql`select * from playtest_founders`).toHaveLength(RULES.founderSpots);
    expect((await conn.sql`select detail from playtest_campaign_audit where action='founder-snapshot-superseded'`)[0]!.detail.previousFounders).toEqual(prior!.rows);
  });
}, FRESH_DB_CASE_MS);

it.each(['scheduled', 'finalized', 'cancelled'] as const)('refuses to supersede a %s v1 campaign and rolls back the migration', async (phase) => {
  await priorDatabase(async (conn, upgrade) => {
    await v1(conn);
    if (phase === 'scheduled') await conn.sql`update playtest_campaigns set start_at='2040-01-01',end_at='2040-01-15'`;
    if (phase === 'finalized') await conn.sql`update playtest_campaigns set finalized_at=${oldAt}`;
    if (phase === 'cancelled') await conn.sql`update playtest_campaigns set cancelled_at=${oldAt}`;
    await expect(upgrade()).rejects.toThrow();
    expect(await conn.sql`select * from playtest_founders`).toHaveLength(RULES.founderSpots);
    expect(await conn.sql`select * from playtest_campaign_audit`).toHaveLength(1);
    expect((await conn.sql`select revision from playtest_campaigns`)[0]!.revision).toBe(2);
    expect((await conn.sql`select to_regclass('public.playtest_internal_wallets') as table`)[0]!.table).toBeNull();
  });
}, FRESH_DB_CASE_MS);

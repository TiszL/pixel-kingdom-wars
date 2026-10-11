import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount, postTransaction } from '../../src/ledger';
import { initializeFreeCohortCoverage } from '../../src/mining/freeCohort';
import { initializeGemsFlowEvidence, readGemsFlowEvidence } from '../../src/mining/gemsFlowEvidence';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createMigratedDatabase } from '../migratedTemplate';
export const migration = readFileSync(new URL('../../drizzle/0179_mining_gems_flow_evidence.sql', import.meta.url), 'utf8').replaceAll('--> statement-breakpoint', '');
export async function withGemsFlow(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, initialized = true) {
 const f = await setup(initialized); try { await run(f); } finally { vi.unstubAllEnvs(); await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.name} with (force)`); await f.admin.end(); }
}
async function setup(initialized: boolean) {
 const name = `gems_flow_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
 if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('local fixture required');
 url.pathname = `/${name}`; const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
 await createMigratedDatabase(admin, name); const conn = createDb(url.toString(), { max: 4 });
 try {
  await runMigrations(conn.db); await conn.sql.unsafe(migration); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true'); vi.stubEnv('GEMS_ENABLED', 'true');
  const clock = async (at: string) => { if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(at)) throw new Error('fixture clock'); await conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '${at}'::timestamptz $$`); };
  await clock('2035-01-01T00:00:00Z'); await initializeFreeCohortCoverage(conn.db); if (initialized) await initializeGemsFlowEvidence(conn.db);
  const wallet = Keypair.generate().publicKey.toBase58(); await conn.sql`insert into players(wallet,created_at) values(${wallet},'2035-01-01T00:00:00Z')`;
  const sys = await bootstrapSystemAccounts(conn.db), gems = await getOrCreatePlayerAccount(conn.db, wallet, 'player_gems'), keep = await getOrCreatePlayerAccount(conn.db, wallet, 'player_keep');
  await postTransaction(conn.db, { idempotencyKey: randomUUID(), type: 'fixture.keep', entries: [{ account: sys.keep_genesis, delta: -1000n }, { account: keep.id, delta: 1000n }] });
  const close = () => clock('2035-01-02T00:00:00Z');
  const read = () => readGemsFlowEvidence(conn.db, { wallet, day: '2035-01-01' });
  return { name, url, admin, conn, wallet, sys, gems, keep, clock, close, read };
 } catch (error) { vi.unstubAllEnvs(); await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); throw error; }
}

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import postgres from 'postgres';
import { vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { initializeFreeCohortCoverage } from '../../src/mining/freeCohort';
import { initializeMiningSeekerLinkHistory } from '../../src/mining/seekerLinkHistory';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createMigratedDatabase } from '../migratedTemplate';

type Options = { coverageAt?: string; birthAt?: string; observedBirthAt?: string; preCoverageBirth?: boolean; markerAt?: string; beforeMarkerBirth?: boolean; marker?: boolean };
export async function withSeekerLinkHistoryFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: Options = {}) {
 const f = await setup(options);
 try { await run(f); } finally { vi.unstubAllEnvs(); await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.name} with (force)`); await f.admin.end(); }
}
async function setup(options: Options) {
 const name = `seeker_history_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
 if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('fixture host required');
 url.pathname = `/${name}`; const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
 await createMigratedDatabase(admin, name); const conn = createDb(url.toString(), { max: 4 });
 try {
  await runMigrations(conn.db);
  const migrate = async () => { for (const statement of readFileSync(new URL('../../drizzle/0180_mining_seeker_link_coverage.sql', import.meta.url), 'utf8').split('--> statement-breakpoint')) if (statement.trim()) await conn.sql.unsafe(statement); };
  await migrate(); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  const key = () => Keypair.generate().publicKey.toBase58();
  const wallet = key(), buyer = key(), seekerWallet = key(), sgtMint = key();
  const clock = async (value: string) => {
   if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) throw new Error('fixture clock');
   await conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);
  };
  const born = options.birthAt ?? '2020-01-01T01:00:00Z';
  const birth = async () => { await clock(options.observedBirthAt ?? born); await conn.sql`insert into players(wallet,created_at) values(${wallet},${born}),(${buyer},${born})`; };
  if (options.preCoverageBirth) await birth();
  await clock(options.coverageAt ?? '2020-01-01T00:00:00Z'); await initializeFreeCohortCoverage(conn.db);
  if (options.beforeMarkerBirth && !options.preCoverageBirth) await birth();
  const initialize = () => initializeMiningSeekerLinkHistory(conn.db);
  await clock(options.markerAt ?? options.coverageAt ?? '2020-01-01T00:00:00Z');
  if (options.marker !== false) await initialize();
  if (!options.preCoverageBirth && !options.beforeMarkerBirth) await birth();
  const link = async (actor = wallet, mint = sgtMint, seeker = seekerWallet) => {
   await conn.sql`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${actor},${seeker},${mint})`;
  };
  const close = () => clock('2020-01-04T00:00:00Z');
  return { name, admin, conn, wallet, buyer, seekerWallet, sgtMint, key, clock, link, close, initialize, migrate, request: { wallet, day: '2020-01-02', policyVersion: 1 } };
 } catch (error) { vi.unstubAllEnvs(); await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); throw error; }
}

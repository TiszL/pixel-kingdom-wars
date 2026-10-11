import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Keypair } from '@solana/web3.js';
import { vi } from 'vitest';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { initializeFreeCohortCoverage } from '../../src/mining/freeCohort';
import { collectMiningActivityEvidence } from '../../src/mining/activityEvidence';
import { collectMiningWalletExperience } from '../../src/mining/walletExperience';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createMigratedDatabase } from '../migratedTemplate';

type Options = { identityCoverageAt?: string; activityCoverageAt?: string; birthAt?: string; observedBirthAt?: string; birthBeforeInitialization?: boolean };
export async function withWalletActivityFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>, options: Options = {}) {
 const f = await setup(options);
 try { await run(f); } finally { vi.unstubAllEnvs(); await f.conn.sql.end(); await f.admin.unsafe(`drop database ${f.name} with (force)`); await f.admin.end(); }
}
async function setup(options: Options) {
 const name = `wallet_activity_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
 if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('fixture host required');
 url.pathname = `/${name}`; const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
 await createMigratedDatabase(admin, name); const conn = createDb(url.toString(), { max: 4 });
 try {
  await runMigrations(conn.db); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  const clock = async (value: string) => {
   if (!/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/.test(value)) throw new Error('fixture clock');
   await conn.sql.unsafe(`create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);
  };
  const wallet = Keypair.generate().publicKey.toBase58(), buyer = Keypair.generate().publicKey.toBase58();
  const birthAt = options.birthAt ?? '2020-01-01T00:00:00Z', observedBirthAt = options.observedBirthAt ?? birthAt;
  const birth = async () => { await clock(observedBirthAt); await conn.sql`insert into players(wallet,created_at) values(${wallet},${birthAt}),(${buyer},${birthAt})`; };
  if (options.birthBeforeInitialization) await birth();
  await clock(options.identityCoverageAt ?? '2019-12-31T00:00:00Z'); await initializeFreeCohortCoverage(conn.db);
  await conn.sql`update playtest_activity_coverage set started_at=${options.activityCoverageAt ?? '2019-12-31T00:00:00Z'} where key='authoritative-v1'`;
  if (!options.birthBeforeInitialization) await birth();
  const bases = [randomUUID(), randomUUID()];
  for (const id of bases) {
   const asset = Keypair.generate().publicKey.toBase58();
   await conn.sql`insert into bases(id,owner_wallet,land_paid_at,deed_asset_id,deed_mint_asset_id) values(${id},${wallet},${birthAt},${asset},${asset})`;
  }
  const raid = async (day: string, options: { baseId?: string; at?: string; stars?: number; retreated?: boolean } = {}) => {
   const id = randomUUID(), baseId = options.baseId ?? bases[0]!, at = options.at ?? `${day}T12:00:00.000Z`, resolved = new Date(Date.parse(at) + 1000).toISOString();
   await clock(at);
   await conn.sql`insert into raids(id,attacker_wallet,attacker_base_id,campaign_stage,seed,snapshot,army_snapshot,orders,orders_deadline_at,status,bulk_deployment_accepted_at,created_at)
    values(${id},${wallet},${baseId},1,1,'{}','{}','{"deploys":[{}]}',${at},'resolving',${at},${new Date(Date.parse(at) - 1000).toISOString()})`;
   await conn.sql`update player_action_events set occurred_at=${at} where source_id=${id} and source_key='battle_fought'`;
   await conn.sql`update raids set status='resolved',result=${JSON.stringify({ stars: options.stars ?? 1, retreated: options.retreated ?? false })}::jsonb,resolved_at=${resolved} where id=${id}`;
   await conn.sql`update player_action_events set occurred_at=${resolved} where source_id=${id} and source_key='pve_battle'`;
   return { id, baseId, at };
  };
  const redeploy = async (raidId: string, at: string) => {
   const [command] = await conn.sql`insert into raid_commands(raid_id,sequence,client_command_id,kind,payload,server_offset_ms,payload_hash,accepted_at)
    values(${raidId},(select coalesce(max(sequence),0)+1 from raid_commands where raid_id=${raidId}),${randomUUID()},'deploy','{}',1,'fixture',${at}) returning id::text`;
   await conn.sql`update player_action_events set occurred_at=${at} where source_table='raid_commands' and source_id=${command!.id}`;
  };
  const activity = (day: string) => collectMiningActivityEvidence(conn.db, { day, policyVersion: 'battle-evidence-v1' });
  const seal = async (day: string) => { await activity(day); return collectMiningWalletExperience(conn.db, { day, policyVersion: 1 }); };
  const close = () => clock('2020-02-01T00:00:00Z');
  const request = (day = '2020-01-01') => ({ wallet, day, policyVersion: 1 });
  return { name, admin, conn, wallet, buyer, bases, clock, birthAt, observedBirthAt, raid, redeploy, activity, seal, close, request };
 } catch (error) { vi.unstubAllEnvs(); await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); throw error; }
}

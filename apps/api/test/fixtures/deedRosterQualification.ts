/** Bounded disposable DB + serialized Core history. No RPC, balances or earning shortcuts. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { Keypair, PublicKey } from '@solana/web3.js';
import { vi } from 'vitest';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import { fixture as walletFixture, tx, other } from '../../../../packages/chain/src/testFixtures/deedMiningWallet';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { initializeMiningRosterHistory } from '../../src/mining/rosterHistory';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createMigratedDatabase } from '../migratedTemplate';

export const rosterDay = '2035-01-02';
export type DeedScenario = 'continuous' | 'other-owner' | 'exact-start-mint' | 'exact-start-acquisition' | 'out-back' | 'transfer-at-end';
export interface RegisteredDeed { baseId: string; assetId: string }
export async function withDeedRosterQualificationFixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
 const f = await setup();
 try { await run(f); } finally {
  vi.unstubAllEnvs(); await f.conn.sql.end();
  await f.admin.unsafe(`drop database ${f.name} with (force)`); await f.admin.end();
 }
}
async function setup() {
 const name = `deed_roster_${randomUUID().replaceAll('-', '')}_test`, url = new URL(ADMIN_DATABASE_URL);
 if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('fixture host required');
 url.pathname = `/${name}`;
 const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
 await createMigratedDatabase(admin, name);
 const conn = createDb(url.toString(), { max: 4 });
 try {
  await runMigrations(conn.db); vi.stubEnv('PHASE_E_MINING_ENABLED', 'true');
  const clock = async (value: string) => {
   if (!/^2035-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{6})?Z$/.test(value)) throw new Error('fixture clock');
   await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${value}'::timestamptz $$`);
  };
  await clock('2035-01-01T12:00:00Z');
  const wallet = Keypair.generate().publicKey.toBase58(), buyer = Keypair.generate().publicKey.toBase58();
  await conn.sql`insert into players(wallet) values(${wallet}),(${buyer})`;
  const registered: RegisteredDeed[] = [];
  const add = async (slot: number | null, state: 'deed' | 'pending' | 'free' = 'deed') => {
   const deed = { baseId: randomUUID(), assetId: Keypair.generate().publicKey.toBase58() };
   await conn.sql`insert into bases(id,owner_wallet,status,land_paid_at,deed_asset_id,deed_mint_asset_id) values(${deed.baseId},${wallet},${slot === null ? 'inactive' : 'active'},${state === 'free' ? null : '2035-01-01T00:00:00Z'},${state === 'deed' ? deed.assetId : null},${state === 'free' ? null : deed.assetId})`;
   if (slot !== null) await conn.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},${slot},${deed.baseId})`;
   registered.push(deed); return deed;
  };
  const init = () => initializeMiningRosterHistory(conn.db, wallet);
  const close = () => clock('2035-01-03T00:00:00Z');
  const chain = (options: { scenarios?: Record<string, DeedScenario>; extraHeld?: string[]; omit?: string[] } = {}) => {
   const target = new PublicKey(wallet), start = Date.parse(`${rosterDay}T00:00:00Z`) / 1000, end = Date.parse('2035-01-03T00:00:00Z') / 1000;
   const times: Record<number, number> = { 1: start - 100, 10: start - 1, 11: start, 12: start + 100, 13: start + 200, 19: end, 20: end + 1, 21: end + 2, 25: end + 3 };
   const transactions = [tx('collection', 1)], assets: { id: PublicKey; owner: PublicKey }[] = [];
   for (const assetId of [...registered.map(x => x.assetId), ...(options.extraHeld ?? [])]) {
    if (options.omit?.includes(assetId)) continue;
    const id = new PublicKey(assetId), scenario = options.scenarios?.[assetId] ?? 'continuous';
    const original = scenario === 'other-owner' || scenario === 'exact-start-acquisition' ? other : target;
    transactions.push(tx('mint', scenario === 'exact-start-mint' ? 11 : 10, original, id));
    let owner = original;
    if (scenario === 'exact-start-acquisition') { transactions.push(tx('transfer', 11, target, id, other)); owner = target; }
    if (scenario === 'out-back') transactions.push(tx('transfer', 12, other, id, target), tx('transfer', 13, target, id, other));
    if (scenario === 'transfer-at-end') { transactions.push(tx('transfer', 19, other, id, target)); owner = other; }
    assets.push({ id, owner });
   }
   transactions.sort((a, b) => a.slot - b.slot);
   for (const item of transactions) item.blockTime = times[item.slot]!;
   const f = walletFixture(transactions, assets);
   f.reader.getBlockTime.mockImplementation(async slot => times[slot] ?? null);
   f.reader.getBlockSignatures.mockImplementation(async slot => ({ blockTime: times[slot]!, signatures: transactions.filter(t => t.slot === slot).map(t => t.transaction.signatures[0]) }));
   return { ...f, deps: { source: f.reader as unknown as DeedMiningWalletReader, collection: f.input.collection, expectedGenesisHash: f.input.expectedGenesisHash } };
  };
  return { name, admin, conn, wallet, buyer, registered, clock, add, init, close, chain, request: { wallet, day: rosterDay, policyVersion: 1 } };
 } catch (error) {
  vi.unstubAllEnvs(); await conn.sql.end(); await admin.unsafe(`drop database ${name} with (force)`); await admin.end(); throw error;
 }
}

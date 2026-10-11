/** Controlled pre0095 opening state; its ledger funding is a fixture source,
 * not a claimed historical production funding producer. No triggers are disabled.
 * Original allocator/payer shape: social.ts + spend.ts at 467de51673902bbd2b479c3ddeb0ca4f1104b992. */
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Keypair } from '@solana/web3.js';
import postgres from 'postgres';
import { createDb } from '../../src/db/client';
import { captureFixtureLeagueSources } from '../../src/db/keepCustodyLeague';
import { applyFixtureL1Retirement, type FixtureRetirementRequest } from '../../src/db/keepCustodyJournal';
import { runMigrations } from '../../src/db/migrate';
import { bootstrapSystemAccounts } from '../../src/ledger/accounts';
import { ADMIN_DATABASE_URL } from '../db-url';

const MIGRATIONS = fileURLToPath(new URL('../../drizzle', import.meta.url));
const BRIDGE_SQL = '0224_keep_custody_league_bridge.sql';
export const WEEKS = ['2026-08-17', '2026-08-24'] as const;
export function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
export function leaf(error: unknown): { code?: string; message?: string } {
  let current = error as { cause?: unknown; code?: string; message?: string };
  while (current?.cause) current = current.cause as typeof current;
  return current;
}

// Execute the frozen pre0095 ledger shape against actual rows/caches. Current
// postTransaction intentionally requires a later custody SQL function, so it
// cannot be used before0095. This helper never turns fixture headers into trust.
async function oldPost(tx: postgres.TransactionSql, key: string, type: string,
  metadata: Record<string, unknown>, legs: { account: string; delta: bigint }[]) {
  const [header] = await tx<{ id: string }[]>`insert into ledger_transactions(idempotency_key,type,metadata)
    values(${key},${type},${JSON.stringify(metadata)}::jsonb) returning id`;
  await tx`select id from accounts where id in ${tx(legs.map(leg => leg.account))} order by id for update`;
  for (const leg of legs) {
    const [balance] = await tx<{ balance: string }[]>`update accounts set balance=balance+${leg.delta.toString()}::bigint
      where id=${leg.account} returning balance::text`;
    await tx`insert into ledger_entries(txn_id,account_id,delta,balance_after)
      values(${header!.id},${leg.account},${leg.delta.toString()}::bigint,${balance!.balance}::bigint)`;
  }
  return header!.id;
}

export async function custodyLeagueFixture() {
  const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('local fixture required');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  const folder = await mkdtemp(path.join(tmpdir(), 'shardkeep-league-prefix-'));
  await admin.unsafe(`create database ${database}`);
  const conn = createDb(url.toString(), { max: 6 });
  const dispose = async () => {
    await conn.sql.end();
    await admin.unsafe(`drop database if exists ${database} with (force)`);
    await admin.end(); await rm(folder, { recursive: true, force: true });
  };
  try {
    await cp(MIGRATIONS, folder, { recursive: true });
    const journalPath = path.join(folder, 'meta/_journal.json');
    const fullJournal = await readFile(journalPath, 'utf8');
    const prefix = JSON.parse(fullJournal) as { entries: { idx: number; tag: string }[] };
    prefix.entries = prefix.entries.filter(entry => entry.idx <= 94);
    if (prefix.entries.at(-1)?.tag !== '0094_tutorial_guide_skip') throw Error('wrong historical frontier');
    await writeFile(journalPath, JSON.stringify(prefix));
    await runMigrations(conn.db, { migrationsFolder: folder });
    const seller = Keypair.generate().publicKey.toBase58();
    const buyer = Keypair.generate().publicKey.toBase58();
    const bronze = Keypair.generate().publicKey.toBase58();
    const deed = Keypair.generate().publicKey.toBase58();
    await conn.sql`insert into players(wallet) values(${seller}),(${buyer}),(${bronze})`;
    const [base] = await conn.sql<{ id: string }[]>`insert into bases(owner_wallet,deed_asset_id,land_paid_at,status)
      values(${seller},${deed},'2026-08-01T00:00:00Z','active') returning id`;
    const [zeroBase] = await conn.sql<{ id: string }[]>`insert into bases(owner_wallet,deed_asset_id,land_paid_at,status)
      values(${bronze},${Keypair.generate().publicKey.toBase58()},'2026-08-01T00:00:00Z','active') returning id`;
    const sys = await bootstrapSystemAccounts(conn.db);
    const [paidAccount] = await conn.sql<{ id: string }[]>`insert into accounts(owner_wallet,kind,currency)
      values(${seller},'player_keep','KEEP') returning id`;
    await conn.sql.begin(async tx => {
      await oldPost(tx, `fixture:league-pool:${database}`, 'test.fixture.league_pool_fund',
        { purpose: 'controlled pre0095 fixture opening; no production source asserted' }, [
          { account: sys.keep_genesis, delta: -1000n }, { account: sys.league_pool, delta: 1000n },
        ]);
      // Historical Sol-only allocation: 60% of 1000, then 60% of the remaining
      // 400. Bronze rows are retained in each reserve's entitlements count.
      for (const [index, week] of WEEKS.entries()) {
        const amount = index === 0 ? 600n : 240n;
        await tx`insert into base_league_entitlements(week,base_id,tier,trophies,keep_amount,paid_at,created_at)
          values(${week},${base!.id},'sol',1300,${amount.toString()}::bigint,null,${week + 'T00:00:00.123456Z'}),
          (${week},${zeroBase!.id},'bronze',0,0,${week + 'T00:00:00Z'},${week + 'T00:00:00.654321Z'})`;
        await oldPost(tx, `league-entitlements:${week}`, 'league.weekly_reserve', { week, entitlements: 2 }, [
          { account: sys.league_pool, delta: -amount }, { account: sys.league_entitlement_escrow, delta: amount },
        ]);
        if (index === 0) {
          await oldPost(tx, `league:${week}:${base!.id}`, 'league.weekly_prize',
            { wallet: seller, tier: 'sol', baseId: base!.id, week }, [
              { account: sys.league_entitlement_escrow, delta: -amount }, { account: paidAccount!.id, delta: amount },
            ]);
          await tx`update base_league_entitlements set paid_at=${week + 'T00:01:00Z'}
            where week=${week} and base_id=${base!.id}`;
        }
      }
    });
    const originalWeeks = await conn.sql`select week::text,jsonb_agg(to_jsonb(e) order by base_id) as original_rows
      from base_league_entitlements e group by week order by week`;
    const historicalGraph = async () => JSON.stringify(await conn.sql`select
      (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t
        where type in ('league.weekly_reserve','league.weekly_prize')) headers,
      (select jsonb_agg(to_jsonb(e) order by e.id) from ledger_entries e join ledger_transactions t on t.id=e.txn_id
        where t.type in ('league.weekly_reserve','league.weekly_prize')) entries`);
    const originalGraph = await historicalGraph();
    async function installBridge() {
      const ddl = await readFile(path.join(MIGRATIONS, BRIDGE_SQL), 'utf8');
      // Do not create a fake out-of-order Drizzle migration record.
      await conn.sql.begin(async tx => {
        for (const statement of ddl.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      });
    }
    await installBridge();
    const bridgeId = randomUUID();
    const env = { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() };
    const capture = () => captureFixtureLeagueSources({ fixtureId: bridgeId }, env);
    async function migrateAll() {
      await writeFile(journalPath, fullJournal);
      await runMigrations(conn.db, { migrationsFolder: folder });
      await bootstrapSystemAccounts(conn.db);
    }
    async function balance(kind: string, wallet: string | null = null) {
      const [row] = await conn.sql<{ total: string }[]>`select coalesce(sum(balance),0)::text as total
        from accounts where kind::text=${kind} and owner_wallet is not distinct from ${wallet}::text`;
      return BigInt(row!.total);
    }
    const money = async () => JSON.stringify(await conn.sql`select
      (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
      (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) headers,
      (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries`);
    async function payPreviouslySelected() {
      return conn.sql.begin(async tx => {
        await oldPost(tx, `league:${WEEKS[1]}:${base!.id}`, 'league.weekly_prize',
          { wallet: seller, tier: 'sol', baseId: base!.id, week: WEEKS[1] }, [
            { account: sys.league_entitlement_escrow, delta: -240n }, { account: paidAccount!.id, delta: 240n },
          ]);
        await tx`update base_league_entitlements set paid_at=now() where week=${WEEKS[1]} and base_id=${base!.id}`;
      });
    }
    async function authorizeBuyer(asOf: string) {
      // A controlled finalized ownership observation, not a permission flag.
      await conn.sql`update bases set owner_wallet=${buyer} where id=${base!.id}`;
      await conn.sql`insert into deed_ownership_observations(base_id,asset_id,owner,slot,checked_at,source,status,audit_hash)
        values(${base!.id},${deed},${buyer},100,${asOf},'fixture-finalized','owned','fixture-league-current-owner')`;
    }
    async function closeCustody() {
      await conn.sql`select shardkeep_advance_keep_custody_phase('open','fenced')`;
      await conn.sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`;
    }
    const retirementRequest = (asOf: string): FixtureRetirementRequest => ({
      fixtureId: randomUUID(), asOf, players: [{ wallet: seller, keep: '600', internal: false }],
      league: [{ week: WEEKS[1], baseId: base!.id, wallet: buyer, keep: '240', internal: false }],
    });
    const apply = (request: FixtureRetirementRequest): ReturnType<typeof applyFixtureL1Retirement> => applyFixtureL1Retirement(request, env);
    return { ...conn, database, seller, buyer, bronze, deed, baseId: base!.id, zeroBaseId: zeroBase!.id,
      sys, env, bridgeId, originalWeeks, originalGraph, historicalGraph, capture, migrateAll, installBridge,
      balance, money, payPreviouslySelected, authorizeBuyer, closeCustody, retirementRequest, apply, dispose };
  } catch (error) { await dispose(); throw error; }
}
export type CustodyLeagueFixture = Awaited<ReturnType<typeof custodyLeagueFixture>>;

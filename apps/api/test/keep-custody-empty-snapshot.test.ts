/** Empty post-retirement observations have no Merkle root or chain side effect. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { buildWeeklySnapshot, epochForDate, getInclusionProof } from '../src/money/snapshot';
import { createTestPlayer, fundTestKeep } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';

const at = new Date('2042-01-06T00:00:00.000Z');
const kinds = ['player_keep','withdrawal_escrow','forge_payout_escrow','league_entitlement_escrow','mail_keep_escrow'] as const;

async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup();
  try { await run(f); } finally {
    await f.conn.sql.end();
    await f.admin.unsafe(`drop database ${f.database} with (force)`);
    await f.admin.end();
  }
}
async function setup() {
  const database = `custody_snapshot_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('unsafe fixture host');
  const admin = postgres(ADMIN_DATABASE_URL, { max:1, onnotice:()=>{} });
  await admin.unsafe(`create database ${database}`);
  const conn = createDb(url.toString(), { max:3 });
  await runMigrations(conn.db);
  await bootstrapSystemAccounts(conn.db);
  const player = await createTestPlayer(conn.db);
  await getOrCreatePlayerAccount(conn.db, player.wallet, 'player_keep');
  const advance = (from:string,to:string) => conn.sql`select shardkeep_advance_keep_custody_phase(${from},${to})`;
  const freeze = async () => {
    await advance('open','fenced'); await advance('fenced','withdrawals_closed'); await advance('withdrawals_closed','frozen');
  };
  const stored = async () => JSON.stringify(await conn.sql`select
    (select jsonb_agg(to_jsonb(s) order by epoch) from merkle_snapshots s) snapshots,
    (select jsonb_agg(to_jsonb(l) order by epoch,leaf_index) from merkle_leaves l) leaves,
    (select jsonb_agg(to_jsonb(o) order by id) from outbox o) outbox`);
  // Corrupt-state fixtures exercise the reader's refusal independently of the
  // production write fences. Only this generated database is ever modified.
  const injectPhase = async (phase:string|null) => conn.sql.begin(async tx => {
    await tx`alter table keep_custody_cutover_state disable trigger keep_custody_state_forward_only`;
    if (phase === null) await tx`delete from keep_custody_cutover_state`;
    else await tx`update keep_custody_cutover_state set phase=${phase}`;
    await tx`alter table keep_custody_cutover_state enable trigger keep_custody_state_forward_only`;
  });
  const injectBalances = async (values:Partial<Record<typeof kinds[number],number>>) => conn.sql.begin(async tx => {
    await tx`alter table accounts disable trigger user`;
    for (const kind of kinds) await tx`update accounts set balance=${values[kind] ?? 0} where kind=${kind}`;
    await tx`alter table accounts enable trigger user`;
  });
  return {database,admin,conn,player,advance,freeze,stored,injectPhase,injectBalances};
}

describe('post-freeze empty weekly snapshot', () => {
  it('returns an explicit no-root observation without persisting or enqueueing anything', async () => fixture(async f => {
    await f.freeze();
    const before = await f.stored();
    const expected = {kind:'no_liabilities',phase:'frozen',epoch:epochForDate(at),root:null,totalBalance:0n,leafCount:0,alreadyExisted:false};
    expect(await buildWeeklySnapshot(f.conn.db,at)).toEqual(expected);
    expect(await buildWeeklySnapshot(f.conn.db,at)).toEqual(expected);
    expect(await f.stored()).toBe(before);
    await expect(getInclusionProof(f.conn.db,f.player.wallet)).rejects.toMatchObject({statusCode:404});
    await f.injectPhase('retired');
    expect(await buildWeeklySnapshot(f.conn.db,at)).toEqual({...expected,phase:'retired'});
    expect(await f.stored()).toBe(before);
  }),30_000);

  it('refuses empty pre-freeze, missing, malformed and unreadable phase evidence', async () => fixture(async f => {
    const before=await f.stored();
    for (const [from,to] of [[null,'open'],['open','fenced'],['fenced','withdrawals_closed']] as const) {
      if (from) await f.advance(from,to);
      await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toMatchObject({statusCode:422});
    }
    await f.conn.sql`alter table keep_custody_cutover_state drop constraint keep_custody_cutover_state_phase_check`;
    await f.injectPhase('unknown');
    await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toMatchObject({statusCode:422});
    await f.injectPhase(null);
    await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toMatchObject({statusCode:422});
    await f.conn.sql`alter table keep_custody_cutover_state rename to unavailable_custody_state`;
    await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toThrow();
    expect(await f.stored()).toBe(before);
  }),30_000);

  it('never treats individual negative or unattributed escrow residues as zero, even when they cancel', async () => fixture(async f => {
    await f.freeze(); const before=await f.stored();
    for (const kind of kinds) {
      await f.injectBalances({[kind]:-1});
      await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toMatchObject({statusCode:422});
      if (kind !== 'player_keep') {
        await f.injectBalances({[kind]:1});
        await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toMatchObject({statusCode:422});
      }
    }
    await f.injectBalances({withdrawal_escrow:1,forge_payout_escrow:-1});
    await expect(buildWeeklySnapshot(f.conn.db,at)).rejects.toMatchObject({statusCode:422});
    expect(await f.stored()).toBe(before);
  }),30_000);

  it('preserves positive snapshots, original epoch roots and historical inclusion proofs', async () => fixture(async f => {
    await fundTestKeep(f.conn.db,f.player.wallet,7n,'test.snapshot',randomUUID());
    const original=await buildWeeklySnapshot(f.conn.db,at), proof=await getInclusionProof(f.conn.db,f.player.wallet);
    expect(original.totalBalance).toBe(7n); expect('kind' in original).toBe(false);
    const before=await f.stored();
    await f.injectBalances({}); await f.injectPhase('frozen');
    expect(await buildWeeklySnapshot(f.conn.db,at)).toEqual({...original,alreadyExisted:true});
    expect(await buildWeeklySnapshot(f.conn.db,new Date('2042-01-13T00:00:00.000Z'))).toMatchObject({kind:'no_liabilities',root:null});
    expect(await getInclusionProof(f.conn.db,f.player.wallet)).toEqual(proof);
    expect(await f.stored()).toBe(before);
    await f.injectPhase(null);
    expect(await buildWeeklySnapshot(f.conn.db,at)).toEqual({...original,alreadyExisted:true});
  }),30_000);

  it('retains ordinary positive-liability behavior even with a post-freeze phase', async () => fixture(async f => {
    await fundTestKeep(f.conn.db,f.player.wallet,7n,'test.snapshot',randomUUID());
    await f.injectPhase('frozen');
    const result=await buildWeeklySnapshot(f.conn.db,at);
    expect('kind' in result).toBe(false); expect(result.totalBalance).toBe(7n); expect(result.leafCount).toBe(1);
    expect((await f.conn.sql`select count(*)::int n from outbox where kind='post_root'`)[0]!.n).toBe(1);
  }),30_000);

  it('observes the phase and liabilities from the same repeatable-read snapshot', async () => fixture(async f => {
    await f.conn.sql`alter table keep_custody_cutover_state disable trigger keep_custody_state_forward_only`;
    let ready!:()=>void, release!:()=>void;
    const observed=new Promise<void>(resolve=>{ready=resolve}), proceed=new Promise<void>(resolve=>{release=resolve});
    const db=new Proxy(f.conn.db,{get(target,property){
      if(property==='transaction') return (run:Parameters<Db['transaction']>[0],options:Parameters<Db['transaction']>[1]) => target.transaction(async tx=>{
        // Establish the real MVCC snapshot before the concurrent transition.
        await tx.execute(sql`select phase from keep_custody_cutover_state`);
        ready(); await proceed; return run(tx);
      },options);
      const value=Reflect.get(target,property,target); return typeof value==='function'?value.bind(target):value;
    }});
    const pending=buildWeeklySnapshot(db,at);
    try {
      await observed;
      // A row update needs no relation barrier here: this is controlled fixture
      // authority, avoiding a test deadlock with the reader's AccessShare lock.
      await f.conn.sql`update keep_custody_cutover_state set phase='frozen'`; release();
      await expect(pending).rejects.toMatchObject({statusCode:422});
      expect(await buildWeeklySnapshot(f.conn.db,at)).toMatchObject({kind:'no_liabilities',phase:'frozen'});
    } finally {
      release(); await Promise.allSettled([pending]);
      await f.conn.sql`alter table keep_custody_cutover_state enable trigger keep_custody_state_forward_only`;
    }
  }),30_000);
});

/** A generated DB owns the one-way custody latch; no shared suite is frozen. */
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { FORGE } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { createDb, type Db } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { bases, baseForgePositions, forgeContributions } from '../src/db/schema';
import { bootstrapSystemAccounts, postTransaction } from '../src/ledger';
import { claimForgeDaysAfterSettlement, expireDueForgeAllocations, type ForgeStableBaseContext } from '../src/game/forge';
import { createTestPlayer } from './helpers';
import { ADMIN_DATABASE_URL } from './db-url';
import { createMigratedDatabase } from './migratedTemplate';

const settledAt = new Date('2035-01-01T00:00:00.000Z');
const dueAt = new Date(settledAt.getTime() + FORGE.claimWindowDays * 86_400_000);
const day = '2034-12-31';
type Kind = 'legacy' | 'base';
async function fixture(kind: Kind, run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const f = await setup(kind);
  try { await run(f); } finally {
    await f.conn.sql.end();
    await f.admin.unsafe(`drop database if exists ${f.database} with (force)`);
    await f.admin.end();
  }
}
async function setup(kind: Kind) {
  const database = `forge_expiry_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('unsafe fixture host');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await createMigratedDatabase(admin, database);
  const conn = createDb(url.toString(), { max: 5 }); await runMigrations(conn.db);
  const player = await createTestPlayer(conn.db), sys = await bootstrapSystemAccounts(conn.db);
  const [base] = await conn.db.insert(bases).values({ ownerWallet: player.wallet, status:'active',landPaidAt:settledAt }).returning();
  const funded = await postTransaction(conn.db,{ idempotencyKey:randomUUID(),type:'test.forge.expiry.allocate',entries:[
    {account:sys.keep_genesis,delta:-7n},{account:sys.forge_payout_escrow,delta:7n}] });
  if (kind === 'legacy') await conn.db.insert(forgeContributions).values({day,playerWallet:player.wallet,shards:1n,settledAt,keepPaid:7n,keepEscrowTxnId:funded.transaction.id});
  else await conn.db.insert(baseForgePositions).values({day,baseId:base!.id,settledAt,keepPaid:7n,countedShards:0n,shardsRefunded:0n,
    settlementOwnerWallet:player.wallet,keepEscrowTxnId:funded.transaction.id});
  const key = kind==='legacy' ? `forge-expire:${day}:${player.wallet}` : `forge-expire:base:${day}:${base!.id}`;
  const advance = (from:string,to:string) => conn.sql`select shardkeep_advance_keep_custody_phase(${from},${to})`;
  const snapshot = async () => JSON.stringify(await conn.sql`select
    (select jsonb_agg(to_jsonb(t) order by id) from forge_contributions t) legacy,
    (select jsonb_agg(to_jsonb(t) order by id) from base_forge_positions t) positions,
    (select jsonb_agg(to_jsonb(t) order by id) from accounts t) accounts,
    (select jsonb_agg(to_jsonb(t) order by id) from ledger_entries t) entries,
    (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions`);
  const authority: ForgeStableBaseContext = {baseId:base!.id,assertActiveAuthority:async(tx,wallet)=>
    tx.select({id:bases.id,landPaidAt:bases.landPaidAt}).from(bases).where(eq(bases.ownerWallet,wallet)).for('update')};
  return {database,admin,conn,player,base:base!,kind,key,advance,snapshot,authority};
}

describe('Forge expiry respects the custody closing latch', () => {
  it.each(['legacy','base'] as const)('keeps ordinary open %s expiry markers, exact receipt and one-time escrow return', async kind => fixture(kind,async f=>{
    expect(await expireDueForgeAllocations(f.conn.db,new Date(dueAt.getTime()-1))).toBe(0);
    expect(await expireDueForgeAllocations(f.conn.db,dueAt)).toBe(1);
    const entries=await f.conn.sql`select a.kind,a.currency,e.delta::text,t.id from ledger_transactions t
      join ledger_entries e on e.txn_id=t.id join accounts a on a.id=e.account_id where t.idempotency_key=${f.key} order by a.kind::text`;
    expect(entries.map(e=>[e.kind,e.currency,e.delta])).toEqual([['emission_pool','KEEP','7'],['forge_payout_escrow','KEEP','-7']]);
    const rows=kind==='legacy'?await f.conn.db.select().from(forgeContributions):await f.conn.db.select().from(baseForgePositions);
    expect(rows[0]!.expiredAt).toEqual(dueAt); expect(rows[0]!.claimedAt).toBeNull();
    if(kind==='base') expect((rows[0] as typeof baseForgePositions.$inferSelect).expireTxnId).toBe(entries[0]!.id);
    const after=await f.snapshot(); expect(await expireDueForgeAllocations(f.conn.db,dueAt)).toBe(0); expect(await f.snapshot()).toBe(after);
  }),30_000);

  it.each(['legacy','base'] as const)('pauses overdue %s rows in fenced and withdrawals_closed with workers disabled', async kind => fixture(kind,async f=>{
    vi.stubEnv('ENABLE_WORKERS','false');
    try {
      await f.advance('open','fenced'); const before=await f.snapshot();
      expect(await expireDueForgeAllocations(f.conn.db,dueAt)).toBe(0); expect(await f.snapshot()).toBe(before);
      await f.advance('fenced','withdrawals_closed');
      expect(await expireDueForgeAllocations(f.conn.db,new Date(dueAt.getTime()+1))).toBe(0); expect(await f.snapshot()).toBe(before);
    } finally { vi.unstubAllEnvs(); }
  }),30_000);

  it.each(['legacy','base'] as const)('rechecks the latch after selecting %s candidates but before writing', async kind => fixture(kind,async f=>{
    let release!:()=>void, selected!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve}), ready=new Promise<void>(resolve=>{selected=resolve});
    let first=true;
    const paused=new Proxy(f.conn.db,{get(target,property){
      if(property==='transaction') return async (...args:Parameters<Db['transaction']>)=>{
        if(first){first=false;selected();await gate;}
        return target.transaction(...args);
      };
      const value=Reflect.get(target,property,target); return typeof value==='function'?value.bind(target):value;
    }});
    const expiry=expireDueForgeAllocations(paused,dueAt);
    try {
      await ready; await f.advance('open','fenced'); const before=await f.snapshot(); release();
      expect(await expiry).toBe(0); expect(await f.snapshot()).toBe(before);
    } finally { release(); await Promise.allSettled([expiry]); }
  }),30_000);

  it.each(['legacy','base'] as const)('lets a committed normal %s claim win once against an already-selected expiry', async kind => fixture(kind,async f=>{
    let release!:()=>void, claimed!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve}), ready=new Promise<void>(resolve=>{claimed=resolve});
    const claim=f.conn.db.transaction(async tx=>{
      const result=await claimForgeDaysAfterSettlement(tx,f.player.wallet,day,new Date(dueAt.getTime()-1),kind==='base'?f.base.id:undefined,kind==='base'?f.authority:undefined);
      claimed(); await gate; return result;
    });
    let expiry:Promise<number>|undefined;
    try {
      await ready; expiry=expireDueForgeAllocations(f.conn.db,dueAt);
      await expect.poll(async()=>Number((await f.conn.sql`select count(*) n from pg_stat_activity where datname=current_database() and cardinality(pg_blocking_pids(pid))>0`)[0]!.n)).toBeGreaterThan(0);
      // A closing operator refuses NOWAIT while a domain/ledger writer owns its
      // locks; it cannot seize the latch first and deadlock the writer.
      await expect(f.advance('open','fenced')).rejects.toMatchObject({code:'55P03'});
      release(); expect((await claim).totalKeep).toBe('7'); expect(await expiry).toBe(0);
      expect((await f.conn.sql`select count(*)::int n from ledger_transactions where idempotency_key=${f.key}`)[0]!.n).toBe(0);
      expect((await claimForgeDaysAfterSettlement(f.conn.db,f.player.wallet,day,new Date(dueAt.getTime()-1),kind==='base'?f.base.id:undefined,kind==='base'?f.authority:undefined)).totalKeep).toBe('0');
    } finally { release(); await Promise.allSettled([claim,...(expiry?[expiry]:[])]); }
  }),30_000);

  it.each(['legacy','base'] as const)('fails closed without a latch for %s expiry and rolls every row back', async kind => fixture(kind,async f=>{
    await f.conn.sql`alter table keep_custody_cutover_state disable trigger keep_custody_state_forward_only`;
    await f.conn.sql`delete from keep_custody_cutover_state`;
    await f.conn.sql`alter table keep_custody_cutover_state enable trigger keep_custody_state_forward_only`;
    const before=await f.snapshot(); await expect(expireDueForgeAllocations(f.conn.db,dueAt)).rejects.toThrow(); expect(await f.snapshot()).toBe(before);
  }),30_000);
});

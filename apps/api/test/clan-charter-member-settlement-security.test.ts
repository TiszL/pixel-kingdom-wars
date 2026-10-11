import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {transferStableBase} from '../src/game/baseOwnership';
import {createClanCharterMemberSettlement,type ClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {ADMIN_DATABASE_URL} from './db-url';
import {memberSettlementFixture,type MemberSettlementFixture} from './fixtures/clanCharterMemberSettlement';
let f:MemberSettlementFixture|undefined;
beforeEach(async()=>{f=await memberSettlementFixture();},120_000);
afterEach(async()=>{try{await f?.close();}finally{f=undefined;vi.restoreAllMocks();vi.unstubAllEnvs();}},120_000);
const held=(suffix:string)=>({code:'CLAN_CHARTER_MEMBER_SETTLEMENT_'+suffix});
function gate(){let arrived!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>arrived=r),waiting=new Promise<void>(r=>release=r);
 return {entered,release,wait:async()=>{arrived();await waiting;}};}

it('waits for actual COMMIT and rolls back payout, receipt and zero chest on a reached deferred failure',async()=>{
 const c=f!,s=await c.source(),service=c.service();expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 const before=await c.snapshot();
 await c.sql.unsafe(`create sequence public.b6u_deferred_reached;
  create function public.b6u_deferred_fault() returns trigger language plpgsql as $$begin
   if NEW.id='${s.clan.id}' and OLD.chest_shards>0 and NEW.chest_shards=0 then
    if not exists(select 1 from ledger_transactions where type='clan.charter.member_settlement') then raise exception 'FIXTURE_POST_NOT_REACHED';end if;
    perform nextval('public.b6u_deferred_reached');raise exception 'FIXTURE_DEFERRED_PAYMENT_FAILURE';
   end if;return NULL;end$$;
  create constraint trigger zzz_b6u_deferred_fault after update on clans deferrable initially deferred
   for each row execute function public.b6u_deferred_fault()`);
 try{await expect(service.settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('HELD'));}
 finally{await c.sql`drop trigger zzz_b6u_deferred_fault on clans`;}
 expect((await c.sql`select is_called from public.b6u_deferred_reached`)[0]!.is_called).toBe(true);
 expect(await c.snapshot()).toBe(before);expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 expect((await service.settle(s.leader.wallet,s.fence.fenceId)).ledgerTransactionId).not.toBeNull();
});

it('refuses correct-looking ledger entries when either pooled or receiver balance-cache movement is suppressed',async()=>{
 const c=f!,s=await c.source(),service=c.service();expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 await c.sql`create sequence public.b6u_cache_reached`;
 for(const kind of ['clan_chest','base_shards']){
  const before=await c.snapshot();await c.sql`alter sequence public.b6u_cache_reached restart with 1`;
  await c.sql.unsafe(`create or replace function public.b6u_cache_fault() returns trigger language plpgsql as $$begin
   if OLD.kind::text='${kind}' and exists(select 1 from ledger_transactions where type='clan.charter.member_settlement') then
    perform nextval('public.b6u_cache_reached');return NULL;end if;return NEW;end$$;
   create trigger aaa_b6u_cache_fault before update on accounts for each row execute function public.b6u_cache_fault()`);
  try{await expect(service.settle(s.leader.wallet,s.fence.fenceId)).rejects.toThrow();}
  finally{await c.sql`drop trigger aaa_b6u_cache_fault on accounts`;}
  expect((await c.sql`select is_called from public.b6u_cache_reached`)[0]!.is_called).toBe(true);
  expect(await c.snapshot()).toBe(before);expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 }
 expect((await service.settle(s.leader.wallet,s.fence.fenceId)).ledgerTransactionId).not.toBeNull();
});

it('refuses foreign originals and over-granted nonowner sessions before any finalized destination lookup',async()=>{
 const c=f!,s=await c.source(),service=c.service();expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 const before=await c.snapshot(),foreign=s.roster[1]!.wallet;c.reader.mockClear();
 const noCollection=createClanCharterMemberSettlement(c.db,{finalizedDeedReader:c.reader,deedCollection:null});
 await expect(noCollection.settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('DESTINATION'));
 for(const [actor,id] of [[foreign,s.fence.fenceId],[s.leader.wallet,randomUUID()]] as const){
  await expect(service.read(actor,id)).rejects.toMatchObject(held('NOT_FOUND'));await expect(service.settle(actor,id)).rejects.toMatchObject(held('NOT_FOUND'));
 }
 const role='b6u_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await c.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{
  await c.sql.unsafe(`grant usage on schema public to ${role};grant all on all tables in schema public to ${role};
   grant usage,select on all sequences in schema public to ${role};grant execute on all functions in schema public to ${role}`);
  const [database]=await c.sql<{name:string}[]>`select current_database() name`,url=new URL(ADMIN_DATABASE_URL);url.pathname='/'+database!.name;url.username=role;url.password=password;
  runtime=createDb(url.toString());const denied=createClanCharterMemberSettlement(runtime.db,{finalizedDeedReader:c.reader,deedCollection:c.collection});
  await expect(denied.read(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('OWNER'));
  await expect(denied.settle(s.leader.wallet,s.fence.fenceId)).rejects.toMatchObject(held('OWNER'));
 }finally{await runtime?.sql.end();await c.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 expect(c.reader).not.toHaveBeenCalled();expect(await c.snapshot()).toBe(before);
});

it('keeps finalized RPC outside payout locks and refuses a real destination transfer that wins during the read',async()=>{
 const c=f!,s=await c.source(),service=c.service();expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 const target=c.receivers[1]!,buyer=await c.funded(),rpc=gate();let before=await c.snapshot();c.enabled();
 c.reader.mockImplementation(async asset=>{const proof=c.proofs.get(asset)??null;if(asset===target.deed)await rpc.wait();return proof;});
 const pending=service.settle(s.leader.wallet,s.fence.fenceId).then(value=>({kind:'success' as const,value}),error=>({kind:'failure' as const,error}));
 try{
  expect(await Promise.race([rpc.entered.then(()=> 'reading'),pending.then(()=> 'completed before read')])).toBe('reading');
  await c.sql.begin(async tx=>{await tx`select wallet from players where wallet=${target.wallet} for update nowait`;
   await tx`select id from bases where id=${target.baseId} for update nowait`;});
  const proof={owner:buyer.wallet,collection:c.collection,frozen:false as const,delegate:null,slot:101};
  await transferStableBase(c.db,target.baseId,target.wallet,buyer.wallet,target.deed,{...proof,observedAtMs:Date.now()});c.proofs.set(target.deed,proof);
  before=await c.snapshot();
 }finally{rpc.release();}
 const result=await pending;expect(result.kind).toBe('failure');if(result.kind==='failure')expect(result.error).toMatchObject(held('DESTINATION'));
 expect(await c.snapshot()).toBe(before);expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
});

it('requires intact canonical source hooks and preserves actual source and completed payment evidence',async()=>{
 const c=f!,s=await c.source(),service=c.service();expect(await service.read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 const before=await c.snapshot();c.reader.mockClear();
 await c.sql`alter table ledger_entries disable trigger ledger_entries_clan_charter_raid_chest`;
 try{await expect(service.settle(s.leader.wallet,s.fence.fenceId)).rejects.toThrow();}
 finally{await c.sql`alter table ledger_entries enable trigger ledger_entries_clan_charter_raid_chest`;}
 expect(c.reader).not.toHaveBeenCalled();expect(await c.snapshot()).toBe(before);
 const [loot]=await c.sql`select id from ledger_transactions where idempotency_key=${'raid:'+s.raid!.id+':loot'}`;
 await expect(c.sql`update ledger_entries set balance_after=balance_after+1 where txn_id=${loot!.id}`).rejects.toThrow();
 expect(await c.snapshot()).toBe(before);const paid=await service.settle(s.leader.wallet,s.fence.fenceId),after=await c.snapshot();
 await expect(c.sql`update ledger_transactions set metadata=metadata where id=${paid.ledgerTransactionId}`).rejects.toThrow();
 await expect(c.sql`delete from ledger_entries where txn_id=${paid.ledgerTransactionId}`).rejects.toThrow();
 await expect(c.sql`truncate ledger_transactions cascade`).rejects.toThrow();
 expect(await service.read(s.leader.wallet,s.fence.fenceId)).toEqual(paid);expect(await c.snapshot()).toBe(after);
});

it.each(['entry','receiver','attribution'] as const)('rejects a late %s change after complete early validation has already succeeded in the same transaction',async change=>{
 const c=f!,other=change==='attribution'?await c.clan((await c.funded()).wallet):null,s=await c.source();
 expect(await c.service().read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 const before=await c.snapshot();await c.sql`create sequence public.b6u_early_validation_reached`;
 const transaction=c.db.transaction.bind(c.db);
 const db=new Proxy(c.db,{get(target,key){
  if(key!=='transaction'){const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}
  return (callback:Parameters<Db['transaction']>[0],config?:Parameters<Db['transaction']>[1])=>transaction(async tx=>{
   const result=await callback(tx);
   if(result&&typeof result==='object'&&'ledgerTransactionId'in result&&typeof result.ledgerTransactionId==='string'){
    const paid=result as ClanCharterMemberSettlement,target=paid.allocations.find(allocation=>allocation.shards!=='0')!;
    // This runs after service source/ledger/head validation and chest zeroing,
    // but before its outer transaction actually commits. The marker proves the
    // real deferred checks passed; only the later financial/custody change is bad.
    await tx.execute(sql`set constraints all immediate`);
    await tx.execute(sql`select nextval('public.b6u_early_validation_reached')`);
    if(change==='entry')await tx.execute(sql`insert into public.ledger_entries(txn_id,account_id,delta,balance_after)
     select ${paid.ledgerTransactionId}::uuid,id,1,balance+1 from public.accounts where id=${target.accountId}::uuid`);
    else if(change==='receiver')await tx.execute(sql`update public.bases
     set owner_wallet=${paid.allocations.find(allocation=>allocation.wallet!==target.wallet)!.wallet} where id=${target.baseId}::uuid`);
    else await tx.execute(sql`update public.clans set chest_shards=chest_shards+1 where id=${other!.id}::uuid`);
   }
   return result;
  },config);
 }});
 const attacked=createClanCharterMemberSettlement(db,{finalizedDeedReader:c.reader,deedCollection:c.collection});
 await expect(attacked.settle(s.leader.wallet,s.fence.fenceId)).rejects.toThrow();
 expect((await c.sql`select is_called from public.b6u_early_validation_reached`)[0]!.is_called).toBe(true);
 expect(await c.snapshot()).toBe(before);expect(await c.service().read(s.leader.wallet,s.fence.fenceId)).toBeNull();
 expect((await c.service().settle(s.leader.wallet,s.fence.fenceId)).ledgerTransactionId).not.toBeNull();
});

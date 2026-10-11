/** Actual enrolled birth/fence/member payment. The positive gross-loot adapter
 * is explicitly the accepted source fixture, not a combat-execution claim. */
import {randomUUID} from 'node:crypto';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {createDb} from '../src/db/client';
import {createRaid} from '../src/game/raids';
import {charterSalesFixture,type CharterSalesFixture} from './fixtures/charterSales';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';
import {postgresLeaf} from './fixtures/charterPermitInventory';
let f:CharterSalesFixture|undefined;
beforeEach(async()=>{f=await charterSalesFixture();},120000);
afterEach(async()=>{const c=f;f=undefined;try{await c?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
async function paid(options:{late?:boolean;positive?:boolean}={}){
 const c=f!;if(!options.late)await c.initialize();const birth=await c.birth();if(options.late)await c.initialize();
 let raidId:string|null=null,cut=0n;
 if(options.positive){await setupCharterSaleRaidActor(c,birth.actor.wallet);const defender=await c.actor();vi.stubEnv('MULTI_BASE_ENABLED','false');
  const raid=await createRaid(c.db,birth.actor.wallet,{defenderWallet:defender.wallet,idempotencyKey:randomUUID()});raidId=raid.id;
  cut=(await settleCharterSaleFixtureGross(c.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints))).chestCut;
 }
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');await birth.actor.refresh();
 const fence=await createClanCharterMemberFences(c.db).begin(birth.actor.wallet,{clanId:birth.consent.clanId,idempotencyKey:randomUUID()});
 const settlement=createClanCharterMemberSettlement(c.db,{deedCollection:birth.actor.collection,finalizedDeedReader:async asset=>asset===birth.actor.deed?birth.actor.proof():null});
 const payment=await settlement.settle(birth.actor.wallet,fence.fenceId),input={fenceId:fence.fenceId,idempotencyKey:randomUUID()},store=createClanCharterRetirementsStore(c.db);
 return {birth,fence,payment,input,store,cut,raidId};
}
it('captures a fully backed positive member payout and every original retained ante without a sale or fabricated clearance',async()=>{
 const c=f!,p=await paid({positive:true});expect(p.cut).toBeGreaterThan(0n);expect(p.payment.totalShards).toBe(p.cut.toString());
 const before=await c.salesSnapshot(),state=await p.store.create(p.birth.actor.wallet,p.input);
 expect(state).toMatchObject({status:'cleared',memberPayment:{id:p.payment.id,totalShards:p.cut.toString()},original:{retirement:{clanId:p.birth.consent.clanId,fenceId:p.fence.fenceId,leader:p.birth.actor.wallet,expectedRevision:0}},inventory:{count:0,messages:[]}});
 expect((state.source as {raids:Array<{classification:string}>}).raids).toHaveLength(1);expect((state.source as {raids:Array<{classification:string}>}).raids[0]!.classification).toBe('resolved-retained');
 expect(await c.sql`select * from charter_sales`).toHaveLength(0);expect(await c.salesSnapshot()).toBe(before);
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const offline=createClanCharterRetirementsStore(c.db);expect(await offline.create(p.birth.actor.wallet,p.input)).toEqual(state);expect(await offline.read(p.birth.actor.wallet,state.original.retirement.id)).toEqual(state);expect(await c.salesSnapshot()).toBe(before);
 await expect(p.store.create(p.birth.actor.wallet,{...p.input,idempotencyKey:randomUUID()})).rejects.toThrow();
},120000);
it('holds an unpaid genuine fence and later accepts the same source only after its actual payout',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),fence=await createClanCharterMemberFences(c.db).begin(birth.actor.wallet,{clanId:birth.consent.clanId,idempotencyKey:randomUUID()}),store=createClanCharterRetirementsStore(c.db),input={fenceId:fence.fenceId,idempotencyKey:randomUUID()};
 await expect(store.create(birth.actor.wallet,input)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_UNPAID'});expect(await c.sql`select * from charter_retirements`).toHaveLength(0);
 await c.memberSettlement().settle(birth.actor.wallet,fence.fenceId);expect((await store.create(birth.actor.wallet,input)).status).toBe('cleared');
},120000);
it('refuses pending sale drafts and any member fence already owned by a real sale',async()=>{
 const c=f!;await c.initialize();const birth=await c.birth(),draft=await c.draft(birth),accepted=await c.store().accept(c.buyer.wallet,draft.state.original.id,{termsHash:draft.state.original.termsHash,buyerBaseId:c.buyer.baseId});
 await c.memberSettlement().settle(birth.actor.wallet,accepted.fenceId!);await expect(createClanCharterRetirementsStore(c.db).create(birth.actor.wallet,{fenceId:accepted.fenceId!,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_HELD'});
 expect(await c.sql`select * from charter_retirements`).toHaveLength(0);
},120000);
it('keeps the paid source and identity immutable, rejects caller source fields, and blocks later sales',async()=>{
 const c=f!,p=await paid(),state=await p.store.create(p.birth.actor.wallet,p.input),before=await c.salesSnapshot();
 await expect(p.store.create(p.birth.actor.wallet,{...p.input,clearanceHash:'00'.repeat(32)} as typeof p.input)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_INPUT'});
 await expect(p.store.read(c.buyer.wallet,state.original.retirement.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_NOT_FOUND'});
 for(const command of ['update charter_retirements set original=original','delete from charter_retirements','truncate charter_retirements cascade'])await expect(c.sql.unsafe(command)).rejects.toMatchObject({message:'CLAN_CHARTER_RETIREMENT_IMMUTABLE'});
 await expect(c.draft(p.birth)).rejects.toThrow();expect(await c.salesSnapshot()).toBe(before);expect(await p.store.read(p.birth.actor.wallet,state.original.retirement.id)).toEqual(state);
},120000);
it('rejects a disabled authority hook or a substituted source function even when all saved rows are unchanged',async()=>{
 const c=f!,p=await paid(),state=await p.store.create(p.birth.actor.wallet,p.input);
 // 2026-10-10 (CI 37503885235): 0264 (existing-clan migrations, f080124dc) re-sealed the retirement source fingerprint
 // inside charter_migration_contract, so shardkeep_charter_retirement_source() now reports a changed source as
 // CLAN_CHARTER_MIGRATION_SOURCE (0281 keeps that chain). The tamper must still be refused before any write.
 for(const command of ['alter table charter_sales disable trigger charter_sales_retirement_barrier',`create or replace function public.shardkeep_charter_sale_birth(cid uuid) returns jsonb language sql set search_path=pg_catalog,public,pg_temp set TimeZone='UTC' as $$select '{}'::jsonb$$`]){
  const error=await c.sql.begin(async tx=>{await tx.unsafe(command);await tx`select shardkeep_charter_retirement_read(${p.birth.actor.wallet},${state.original.retirement.id}::uuid)`;}).then(()=>null,error=>error);
  expect(postgresLeaf(error)?.message).toBe('CLAN_CHARTER_MIGRATION_SOURCE');
 }
 expect(await p.store.read(p.birth.actor.wallet,state.original.retirement.id)).toEqual(state);
},120000);
it('requires the original READ COMMITTED barrier and keeps a concurrent source insertion all-or-nothing',async()=>{
 const c=f!,p=await paid(),other=await c.dedicatedOwner();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
 const work=other.sql.begin(async tx=>{await tx`lock table public.charter_sales in share row exclusive mode`;entered();await gate;});
 try{await ready;await expect(p.store.create(p.birth.actor.wallet,p.input)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_BUSY'});expect(await c.sql`select * from charter_retirements`).toHaveLength(0);}
 finally{release();await work;await other.sql.end();}
 const state=await p.store.create(p.birth.actor.wallet,p.input),error=await c.sql.begin('isolation level repeatable read',tx=>tx`select shardkeep_charter_retirement_read(${p.birth.actor.wallet},${state.original.retirement.id}::uuid)`).then(()=>null,error=>error);
 expect(postgresLeaf(error)?.message).toBe('CLAN_CHARTER_RETIREMENT_READ_COMMITTED');
},120000);
it('requires a private owner connection and gives an ordinary LOGIN no source tables or command grants',async()=>{
 const c=f!,p=await paid(),state=await p.store.create(p.birth.actor.wallet,p.input),role='retire_runtime_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
 await c.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
 try{await c.sql.unsafe(`grant usage on schema public to ${role}`);const url=await c.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
  await expect(createClanCharterRetirementsStore(runtime.db).read(p.birth.actor.wallet,state.original.retirement.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_OWNER'});
  await expect(runtime.sql`select * from public.charter_retirements`).rejects.toMatchObject({code:'42501'});
  expect(await p.store.read(p.birth.actor.wallet,state.original.retirement.id)).toEqual(state);
 }finally{await runtime?.sql.end();await c.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
},120000);

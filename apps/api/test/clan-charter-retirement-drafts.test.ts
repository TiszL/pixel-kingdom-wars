/** A reviewable original must exist before any payout or external lookup. */
import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createClanCharterRetirementDraftsStore} from '../src/db/charterRetirementDrafts';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {joinClan} from '../src/game/clans';
import {createRaid} from '../src/game/raids';
import {charterSalesWorkflowFixture} from './fixtures/charterSalesWorkflow';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';
import {postgresLeaf} from './fixtures/charterPermitInventory';
type Fixture=Awaited<ReturnType<typeof charterSalesWorkflowFixture>>;
async function positive(f:Fixture){await setupCharterSaleRaidActor(f,f.source.wallet);vi.stubEnv('MULTI_BASE_ENABLED','false');const raid=await createRaid(f.db,f.source.wallet,{defenderWallet:f.buyer.wallet,idempotencyKey:randomUUID()});const amount=(await settleCharterSaleFixtureGross(f.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints))).chestCut;vi.stubEnv('MULTI_BASE_ENABLED','true');await f.source.refresh();return amount;}
async function close(f:Fixture){try{await f.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}}
const request=(f:Fixture)=>({clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()});
const settlement=(f:Fixture)=>createClanCharterMemberSettlement(f.db,{deedCollection:f.source.collection,finalizedDeedReader:f.reader});

it('atomically captures a reviewable conserved positive payout and replays the draft before flags or providers',async()=>{
 const f=await charterSalesWorkflowFixture();try{
  const cut=await positive(f),store=createClanCharterRetirementDraftsStore(f.db),input=request(f),before=await f.salesSnapshot();
  const draft=await store.create(f.source.wallet,input);expect(draft).toMatchObject({request:input,memberPayment:null,retirementId:null,cancelled:false,totalShards:cut.toString(),shares:[{wallet:f.source.wallet,shards:cut.toString()}]});
  expect(await f.salesSnapshot()).toBe(before);expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(1);expect(await f.sql`select * from charter_retirement_drafts`).toHaveLength(1);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');f.setOnline(false);expect(await store.create(f.source.wallet,input)).toEqual(draft);expect(await store.readByKey(f.source.wallet,input.idempotencyKey)).toEqual(draft);
  expect(await store.readByKey(f.buyer.wallet,input.idempotencyKey)).toBeNull();await expect(store.read(f.buyer.wallet,draft.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_DRAFT_NOT_FOUND'});
  await expect(store.create(f.source.wallet,{...input,clanId:randomUUID()})).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_DRAFT_CONFLICT'});
 }finally{await close(f);}
},120000);

it('cancels an unpaid original without moving chest funds and permanently prevents a late payment while its old fence remains readable',async()=>{
 const f=await charterSalesWorkflowFixture();try{
  await positive(f);const store=createClanCharterRetirementDraftsStore(f.db),draft=await store.create(f.source.wallet,request(f)),fence=await createClanCharterMemberFences(f.db).read(draft.fenceId),before=await f.salesSnapshot();
  const cancelled=await store.cancel(f.source.wallet,draft.id);expect(cancelled).toEqual({...draft,cancelled:true});expect(await f.salesSnapshot()).toBe(before);
  await expect(settlement(f).settle(f.source.wallet,draft.fenceId)).rejects.toThrow();expect(await f.sql`select * from clan_charter_member_payments`).toHaveLength(0);
  await joinClan(f.db,f.buyer.wallet,f.birth.consent.clanId);expect(await createClanCharterMemberFences(f.db).read(draft.fenceId)).toEqual(fence);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');f.setOnline(false);expect(await store.cancel(f.source.wallet,draft.id)).toEqual(cancelled);expect(await store.read(f.source.wallet,draft.id)).toEqual(cancelled);
 }finally{await close(f);}
},120000);

it('keeps a real completed payout after draft cancellation and survives a later clan sale without refunding members',async()=>{
 const f=await charterSalesWorkflowFixture();try{
  await positive(f);const store=createClanCharterRetirementDraftsStore(f.db),draft=await store.create(f.source.wallet,request(f)),paid=await settlement(f).settle(f.source.wallet,draft.fenceId);
  const before=await f.salesSnapshot(),cancelled=await store.cancel(f.source.wallet,draft.id);expect(cancelled.memberPayment).toEqual({id:paid.id,totalShards:paid.totalShards});expect(await f.salesSnapshot()).toBe(before);
  const app=await f.open(),sale=await f.prepared(app),url='/clans/charter/sales/'+sale.state.id;
  const signed=await f.post(app,url+'/signed',f.signed(sale.state).body);expect(signed.statusCode,signed.body).toBe(200);await f.finalize(sale.state.id);const completed=await f.post(app,url+'/recover');expect(completed.statusCode,completed.body).toBe(200);expect(completed.json().status).toBe('completed');
  expect(await store.read(f.source.wallet,draft.id)).toEqual(cancelled);expect(await settlement(f).read(f.source.wallet,draft.fenceId)).toEqual(paid);
 }finally{await close(f);}
},120000);

it('hands a paid original to the permanent retirement workflow and never cancels its fence through the draft endpoint',async()=>{
 const f=await charterSalesWorkflowFixture();try{
  const store=createClanCharterRetirementDraftsStore(f.db),draft=await store.create(f.source.wallet,request(f)),paid=await settlement(f).settle(f.source.wallet,draft.fenceId);
  const other=await f.dedicatedOwner();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),work=other.sql.begin(async tx=>{await tx`lock table charter_retirements in share row exclusive mode`;entered();await gate;});
  try{await ready;await expect(store.cancel(f.source.wallet,draft.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_DRAFT_BUSY'});}finally{release();await work;await other.sql.end();}
  const original=await createClanCharterRetirementsStore(f.db).create(f.source.wallet,{fenceId:draft.fenceId,idempotencyKey:randomUUID()});
  const linked=await store.cancel(f.source.wallet,draft.id);expect(linked).toMatchObject({retirementId:original.original.retirement.id,cancelled:false,memberPayment:{id:paid.id,totalShards:paid.totalShards}});
  expect(await f.sql`select * from charter_retirement_draft_cancellations`).toHaveLength(0);await expect(joinClan(f.db,f.buyer.wallet,f.birth.consent.clanId)).rejects.toThrow();
 }finally{await close(f);}
},120000);

it('rolls back both draft and fence for unsettled raids and rejects RR or tampered hooks',async()=>{
 const f=await charterSalesWorkflowFixture();try{
  await setupCharterSaleRaidActor(f,f.source.wallet);vi.stubEnv('MULTI_BASE_ENABLED','false');await createRaid(f.db,f.source.wallet,{defenderWallet:f.buyer.wallet,idempotencyKey:randomUUID()});vi.stubEnv('MULTI_BASE_ENABLED','true');
  const store=createClanCharterRetirementDraftsStore(f.db),input=request(f);await expect(store.create(f.source.wallet,input)).rejects.toThrow();
  expect(await f.sql`select * from charter_retirement_drafts`).toHaveLength(0);expect(await f.sql`select * from clan_charter_member_fences`).toHaveLength(0);
  const rr=await f.sql.begin('isolation level repeatable read',tx=>tx`select shardkeep_charter_retirement_draft_create(${f.source.wallet},${input.clanId}::uuid,${input.idempotencyKey}::uuid)`).then(()=>null,e=>e);expect(postgresLeaf(rr).message).toBe('CLAN_CHARTER_RETIREMENT_READ_COMMITTED');
  // 2026-10-10 (CI 37503885235): 0264 (existing-clan migrations, f080124dc) re-sealed the retirement source fingerprint
  // inside charter_migration_contract, so shardkeep_charter_retirement_source() now reports a changed source as
  // CLAN_CHARTER_MIGRATION_SOURCE (0281 keeps that chain). The tamper must still be refused before any write.
  const changed=await f.sql.begin(async tx=>{await tx`alter table charter_retirement_drafts disable trigger charter_retirement_drafts_guard`;await tx`select shardkeep_charter_retirement_draft_create(${f.source.wallet},${input.clanId}::uuid,${input.idempotencyKey}::uuid)`;}).then(()=>null,e=>e);expect(postgresLeaf(changed).message).toBe('CLAN_CHARTER_MIGRATION_SOURCE');
 }finally{await close(f);}
},120000);

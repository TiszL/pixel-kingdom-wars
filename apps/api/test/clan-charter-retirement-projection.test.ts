/** Actual source, paid ledger and SQL effects. Finalized Solana envelopes are
 * explicitly simulated transport fixtures consumed by the real chain readers. */
import {randomUUID} from 'node:crypto';
import {VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {joinClan} from '../src/game/clans';
import {createRaid} from '../src/game/raids';
import {createDb} from '../src/db/client';
import {charterRetirementWorkflowFixture} from './fixtures/charterRetirementWorkflow';
import {salesPath} from './fixtures/charterSalesWorkflow';
import {setupCharterSaleRaidActor} from './fixtures/charterSalesRaid';
import {settleCharterSaleFixtureGross} from './fixtures/charterSalesRaidPayout';
import {postgresLeaf} from './fixtures/charterPermitInventory';
type Fixture=Awaited<ReturnType<typeof charterRetirementWorkflowFixture>>;
async function money(f:Fixture){return JSON.stringify(await f.sql`select (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,(select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) transactions,(select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries`);}
async function proof(f:Fixture){await f.preparedSigned();await f.finalizeRetirement();return f.readEvidence(f.cleared.id,undefined);}

it('projects the real paid original once, retains exact deletion effects and old creation/payment/fence history, and forbids resurrection',async()=>{
 const f=await charterRetirementWorkflowFixture({positive:true});try{
  const evidence=await proof(f),before=await money(f),clanId=f.birth.consent.clanId,oldFence=await createClanCharterMemberFences(f.db).read(f.fence.fenceId);
  const [clan]=await f.sql`select to_jsonb(c) value from clans c where id=${clanId}`,head=await f.sql`select * from charter_sale_heads where clan_id=${clanId}`;
  const state=await f.store.complete(f.actor,f.cleared.id,evidence);
  expect(state).toMatchObject({status:'completed',terminal:{outcome:'completed',record:evidence}});expect(await money(f)).toBe(before);
  expect(await f.sql`select * from clans where id=${clanId}`).toHaveLength(0);expect(await f.sql`select * from clan_members where clan_id=${clanId}`).toHaveLength(0);
  expect(await f.sql`select clan_state from clan_charter_raid_chest_heads where clan_id=${clanId}`).toEqual([{clan_state:null}]);expect(await f.sql`select * from charter_sale_heads where clan_id=${clanId}`).toEqual(head);
  expect(await f.sql`select kind,count(*)::int n from charter_retirement_effects group by kind order by kind`).toEqual([{kind:'clan_charter_raid_chest_heads',n:1},{kind:'clan_members',n:oldFence.members.length},{kind:'clans',n:1}]);
  expect(await createClanCharterMemberFences(f.db).read(f.fence.fenceId)).toEqual(oldFence);expect(await createClanCharterMemberSettlement(f.db).read(f.actor,f.fence.fenceId)).toEqual(f.payment);
  expect(await f.sql`select shardkeep_charter_sale_birth(${clanId}::uuid) value`).toEqual([{value:state.original.creation}]);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');f.setOnline(false);
  expect(await f.store.complete(f.actor,f.cleared.id,null)).toEqual(state);expect(await f.store.cancel(f.actor,f.cleared.id,null)).toEqual(state);expect(await f.store.create(f.actor,f.input)).toEqual(state);
  await expect(f.sql`insert into clans select * from jsonb_populate_record(null::clans,${JSON.stringify(clan!.value)}::jsonb)`).rejects.toMatchObject({message:'CLAN_CHARTER_RETIREMENT_TOMBSTONE'});
  await expect(f.sql`insert into clan_members(player_wallet,clan_id) values(${f.actor},${clanId})`).rejects.toMatchObject({code:'P0001'});
  for(const table of ['charter_retirement_terminals','charter_retirement_completions','charter_retirement_effects']){
   await expect(f.sql.unsafe(`delete from ${table}`)).rejects.toMatchObject({message:'CLAN_CHARTER_RETIREMENT_IMMUTABLE'});
  }
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(state);expect(await money(f)).toBe(before);
 }finally{await f.close();}
},120000);

it('cancels zero exposure with finalized original absence, permits later membership/raid/chest activity and preserves the old paid prefix',async()=>{
 const f=await charterRetirementWorkflowFixture();try{
  const before=await money(f),observation=await f.cancellationProof(f.cleared.id,undefined),state=await f.store.cancel(f.actor,f.cleared.id,observation);
  expect(state.status).toBe('cancelled');expect(await money(f)).toBe(before);expect(await f.sql`select * from charter_retirement_effects`).toHaveLength(0);
  await joinClan(f.db,f.buyer.wallet,f.birth.consent.clanId);await setupCharterSaleRaidActor(f,f.actor);vi.stubEnv('MULTI_BASE_ENABLED','false');
  const raid=await createRaid(f.db,f.actor,{defenderWallet:f.buyer.wallet,idempotencyKey:randomUUID()});
  const routed=await settleCharterSaleFixtureGross(f.db,raid.id,BigInt(PHASE_E_POLICY.basisPoints));expect(routed.chestCut).toBeGreaterThan(0n);
  expect(await createClanCharterMemberSettlement(f.db).read(f.actor,f.fence.fenceId)).toEqual(f.payment);
  expect(await createClanCharterMemberFences(f.db).read(f.fence.fenceId)).toEqual(f.fence);
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(state);
  vi.stubEnv('MULTI_BASE_ENABLED','true');await f.source.refresh();await f.buyer.refresh();
  const fence=await createClanCharterMemberFences(f.db).begin(f.actor,{clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()});
  const payment=await createClanCharterMemberSettlement(f.db,{deedCollection:f.source.collection,finalizedDeedReader:f.reader}).settle(f.actor,fence.fenceId);
  expect(payment.totalShards).toBe(routed.chestCut.toString());
  const next=await f.store.create(f.actor,{fenceId:fence.fenceId,idempotencyKey:randomUUID()});expect(next.original.retirement.id).not.toBe(f.cleared.id);expect(next.inventory.count).toBe(0);
  await f.preparedSigned(next.original.retirement.id);await f.finalizeRetirement(next.original.retirement.id);const evidence=await f.readEvidence(next.original.retirement.id,undefined);
  expect((await f.store.complete(f.actor,next.original.retirement.id,evidence)).status).toBe('completed');
  expect(await f.sql`select * from clan_members where clan_id=${f.birth.consent.clanId}`).toHaveLength(0);
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(state);expect(await createClanCharterMemberSettlement(f.db).read(f.actor,f.fence.fenceId)).toEqual(f.payment);
 }finally{await f.close();}
},120000);

it('requires expired complete exposure and preserves cancelled positive payment history after a genuine completed sale',async()=>{
 const f=await charterRetirementWorkflowFixture({positive:true});try{
  await f.preparedSigned();const issued=await f.store.read(f.actor,f.cleared.id),before=await money(f);
  await expect(f.cancellationProof(f.cleared.id,undefined)).rejects.toThrow();await f.expire();const observation=await f.cancellationProof(f.cleared.id,undefined);
  for(const changed of [{...observation,inventory:{version:1,revision:'0',count:0,messages:[]}},{...observation,original:{...observation.original,retirement:{...observation.original.retirement,id:randomUUID()}}}])await expect(f.store.cancel(f.actor,f.cleared.id,changed)).rejects.toThrow();
  expect(await f.sql`select * from charter_retirement_terminals`).toHaveLength(0);
  const state=await f.store.cancel(f.actor,f.cleared.id,observation);expect(state.inventory).toEqual(issued.inventory);expect(await money(f)).toBe(before);
  const app=await f.open(),sale=await f.prepared(app),wire=VersionedTransaction.deserialize(Buffer.from(sale.state.preparation!.packet.unsignedTransactionHex,'hex'));
  wire.sign([f.keys.get(sale.state.original.buyer)!,f.keys.get(sale.state.original.seller)!]);
  const retained=await f.post(app,`${salesPath}/${sale.state.id}/signed`,{signedTransaction:Buffer.from(wire.serialize()).toString('base64')});expect(retained.statusCode,retained.body).toBe(200);
  await f.finalize(sale.state.id);const completed=await f.post(app,`${salesPath}/${sale.state.id}/recover`);expect(completed.statusCode,completed.body).toBe(200);expect(completed.json().status).toBe('completed');
  expect(await f.sql`select leader_wallet from clans where id=${f.birth.consent.clanId}`).toEqual([{leader_wallet:f.buyer.wallet}]);
  expect(BigInt(f.payment.totalShards)).toBeGreaterThan(0n);expect(await createClanCharterMemberSettlement(f.db).read(f.actor,f.fence.fenceId)).toEqual(f.payment);
  expect(await createClanCharterMemberFences(f.db).read(f.fence.fenceId)).toEqual(f.fence);expect(await money(f)).toBe(before);
  expect(await f.store.beginAttempt(f.actor,f.cleared.id,null,{elapsedMs:NaN})).toEqual(state);expect(await f.store.read(f.actor,f.cleared.id)).toEqual(state);
 }finally{await f.close();}
},120000);

it('rejects wrong original/revision/signature, disabled hooks, nonowner/RR and concurrent source changes without a partial terminal',async()=>{
 const f=await charterRetirementWorkflowFixture();try{
  const evidence=await proof(f),before=await f.salesSnapshot();
  for(const changed of [{...evidence,signature:'1'.repeat(88)},{...evidence,revision:evidence.revision+1},{...evidence,original:{...evidence.original,retirement:{...evidence.original.retirement,clearanceHash:'00'.repeat(32)}}}])await expect(f.store.complete(f.actor,f.cleared.id,changed)).rejects.toThrow();
  // 2026-10-10 (CI 37503885235): 0264 (existing-clan migrations, f080124dc) re-sealed the retirement source fingerprint
  // inside charter_migration_contract, so shardkeep_charter_retirement_source() now reports a changed source as
  // CLAN_CHARTER_MIGRATION_SOURCE (0281 keeps that chain). The tamper must still be refused before any write.
  const tamper=await f.sql.begin(async tx=>{await tx`alter table clans disable trigger clans_retirement_effect`;await tx`select shardkeep_charter_retirement_terminal(${f.actor},${f.cleared.id}::uuid,'completed',${JSON.stringify(evidence)}::jsonb)`;}).then(()=>null,e=>e);expect(postgresLeaf(tamper).message).toBe('CLAN_CHARTER_MIGRATION_SOURCE');
  const repeatable=await f.sql.begin('isolation level repeatable read',tx=>tx`select shardkeep_charter_retirement_terminal(${f.actor},${f.cleared.id}::uuid,'completed',${JSON.stringify(evidence)}::jsonb)`).then(()=>null,e=>e);expect(postgresLeaf(repeatable).message).toBe('CLAN_CHARTER_RETIREMENT_READ_COMMITTED');
  const role='retirement_projection_'+randomUUID().replaceAll('-',''),password=randomUUID();let runtime:ReturnType<typeof createDb>|undefined;
  await f.sql.unsafe(`create role ${role} login password '${password}' nosuperuser nocreatedb nocreaterole noinherit`);
  try{await f.sql.unsafe(`grant usage on schema public to ${role}`);const url=await f.ownerUrl();url.username=role;url.password=password;runtime=createDb(url.toString());
   await expect(createClanCharterRetirementsStore(runtime.db).complete(f.actor,f.cleared.id,evidence)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_OWNER'});
   await expect(runtime.sql`select shardkeep_charter_retirement_terminal(${f.actor},${f.cleared.id}::uuid,'completed',${JSON.stringify(evidence)}::jsonb)`).rejects.toMatchObject({code:'42501'});
  }finally{await runtime?.sql.end();await f.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
  const other=await f.dedicatedOwner();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r),work=other.sql.begin(async tx=>{await tx`lock table charter_sales in share row exclusive mode`;entered();await gate;});
  try{await ready;await expect(f.store.complete(f.actor,f.cleared.id,evidence)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_BUSY'});}finally{release();await work;await other.sql.end();}
  expect(await f.sql`select * from charter_retirement_terminals`).toHaveLength(0);expect(await f.salesSnapshot()).toBe(before);
 }finally{await f.close();}
},120000);

it('completes with constraints already immediate and rejects later writes even after the completion check was flushed',async()=>{
 const f=await charterRetirementWorkflowFixture();try{
  const evidence=await proof(f);
  const [unrelated]=await f.sql`insert into clans(name,tag,leader_wallet) values('Unrelated legacy clan','ULC',${f.buyer.wallet}) returning id`;await f.sql`insert into clan_members(player_wallet,clan_id) values(${f.buyer.wallet},${unrelated!.id})`;
  const before=await f.salesSnapshot();
  const error=await f.sql.begin(async tx=>{await tx`set constraints all immediate`;await tx`select shardkeep_charter_retirement_terminal(${f.actor},${f.cleared.id}::uuid,'completed',${JSON.stringify(evidence)}::jsonb)`;
   await tx`set constraints all immediate`;await tx`delete from clan_members where clan_id=${unrelated!.id}`;}).then(()=>null,e=>e);
  expect(postgresLeaf(error).message).toBe('CLAN_CHARTER_RETIREMENT_ORIGIN');expect(await f.salesSnapshot()).toBe(before);expect(await f.sql`select * from charter_retirement_terminals`).toHaveLength(0);
  const rows=await f.sql.begin(async tx=>{await tx`set constraints all immediate`;return tx`select shardkeep_charter_retirement_terminal(${f.actor},${f.cleared.id}::uuid,'completed',${JSON.stringify(evidence)}::jsonb) value`;});expect(rows[0]!.value.status).toBe('completed');
  expect((await f.store.read(f.actor,f.cleared.id)).status).toBe('completed');
 }finally{await f.close();}
},120000);

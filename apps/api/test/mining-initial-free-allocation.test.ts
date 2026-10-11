/** Whole-epoch discovery and fail-closed source authority use actual paid stock. */
import { randomUUID,createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY,KEEP_MINING_FLOOR,FORGE_INGOT,BUILD_COSTS } from '@shardkeep/shared';
import { buildPublishMiningInstruction } from '@shardkeep/chain/mining-program';
import { rewardBaseShards } from '../src/game/baseEconomy';
import { abortPendingMiningEpoch } from '../src/game/miningIngotReservations';
import { describe,expect,it } from 'vitest';
import { createInitialFreeAllocationPlanner } from '../src/mining/initialFreeAllocation';
import { withInitialFreeMiningFixture as fixture } from './fixtures/initialFreeMining';
import { INITIAL_FREE_PUBLICATION_DAY as day,prepareInitialFreePublication as prepare,createInitialFreeQualificationFixture as qualification,createInitialFreePublicationSources as funded } from './fixtures/initialFreePublication';
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
async function untouched(f:Fixture){for(const table of ['mining_publication_attempts','mining_ingot_releases'])expect((await f.conn.sql.unsafe(`select count(*)::int n from ${table}`))[0]!.n).toBe(0);}
describe('initial-free whole epoch allocation plan',()=>{
 it('rejects caller-selected actors, funding and scores before any evidence read',async()=>fixture(async f=>{
  const input=await prepare(f),q=qualification(f.wallet),plan=createInitialFreeAllocationPlanner(f.conn.db,{qualification:q.source});
  for(const extra of [{wallets:[f.wallet]},{budgetGross:'98000000000000'},{weight:'10000'},{previousPublication:null},{taxCommitment:'0'.repeat(64)}])
   await expect(plan({...input,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(q.chain.reader.getProgramAccounts).not.toHaveBeenCalled();await untouched(f);
 },{roster:true}));
 it('requires the exact named closed epoch and never treats another epoch as the day source',async()=>fixture(async f=>{
  const input=await prepare(f),q=qualification(f.wallet),plan=createInitialFreeAllocationPlanner(f.conn.db,{qualification:q.source});
  await expect(plan({...input,day:'2020-01-02'})).rejects.toMatchObject({code:'EPOCH_SCOPE_INVALID'});
  await expect(plan({...input,epochId:randomUUID()})).rejects.toMatchObject({code:'EPOCH_UNAVAILABLE'});
  expect(q.chain.reader.getProgramAccounts).not.toHaveBeenCalled();await untouched(f);
 },{roster:true}));
 it('refuses missing authenticated backing instead of fabricating a funded budget for qualified play',async()=>fixture(async f=>{
  const input=await prepare(f),q=qualification(f.wallet),plan=createInitialFreeAllocationPlanner(f.conn.db,{qualification:q.source});
  await expect(plan(input)).rejects.toMatchObject({code:'PUBLICATION_SOURCE_UNAVAILABLE'});await untouched(f);
 },{roster:true}));
});

describe('initial-free verified backing and frozen original tax term',()=>{
 it('plans the paid ingots against the participation floor, preserves original stock and binds the real publication instruction',async()=>fixture(async f=>{
  const reservations=[];for(let i=0;i<3;i++)reservations.push((await f.reserve(day)).receipt);
  await f.battle(day);await f.clock(null);await f.collect('2019-12-31');await f.collect(day);
  const input={epochId:reservations[0]!.epochId,day,policyVersion:1},h=await funded(f),plan=await h.plan(input);
  expect(plan).toMatchObject({projection:'READY',publicationAuthorized:false,consumptionAuthorized:false,renownAuthorized:false});
  if(!plan.publication)throw Error('funded player must get a root');const p=plan.publication,manifest=JSON.parse(plan.manifestJson);
  expect(plan.sourceHash).toBe(createHash('sha256').update(plan.manifestJson).digest('hex'));
  const freeBudget=p.budgetGross*BigInt(PHASE_E_POLICY.mining.freePoolBps)/BigInt(PHASE_E_POLICY.basisPoints),weight=BigInt(manifest.participants[0].weight);
  expect(p.freeGross).toBe(freeBudget*weight/(BigInt(KEEP_MINING_FLOOR.minUnitsPerPool)*BigInt(PHASE_E_POLICY.basisPoints)));
  expect(p.playerNet+p.tax+p.recycle).toBe(p.freeGross);expect(p.total).toBe(p.playerNet);expect(p.playerNet>0n).toBe(true);
  expect(p.leaves).toEqual([{wallet:f.wallet,sequence:1n,cumulativeKeep:p.playerNet,cumulativeRenown:0n,cumulativeDays:0n}]);
  expect(plan.reservations.map(r=>r.reservationId)).toEqual(reservations.map(r=>r.id).sort());expect(plan.reservations.map(r=>r.proposedConsumed)).toEqual([1,1,0]);expect(plan.reservations.map(r=>r.proposedReturned)).toEqual([0,0,1]);
  const ix=buildPublishMiningInstruction(h.backing.trust,{signer:new PublicKey(h.backing.model.publisher),args:{sequence:p.sequence,root:Buffer.from(p.root,'hex'),totalCumulative:p.total,leafCount:p.leafCount,kind:0,day:p.day,budgetGross:p.budgetGross,freeGross:p.freeGross,deedGross:p.deedGross,sourceHash:Buffer.from(plan.sourceHash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion}});
  expect(ix.data.includes(Buffer.from(plan.sourceHash,'hex'))).toBe(true);expect(ix.data.includes(Buffer.from(p.taxCommitment,'hex'))).toBe(true);
  expect(manifest.taxManifest.mode).toBe('original-term-no-beneficiary-hold');expect(manifest.taxManifest.source.auctions).toHaveLength(PHASE_E_POLICY.seekerIsland.totalSpots);expect(manifest.taxManifest.source.finality).toBeUndefined();
  expect((await f.conn.sql`select sum(qty)::int n from mining_ingot_reservations`)[0]!.n).toBe(3);await untouched(f);
 },{roster:true}));
 it('keeps the frozen original tax commitment stable across independent proof read times',async()=>fixture(async f=>{
  const input=await prepare(f),h=await funded(f),first=await h.plan(input),second=await h.plan(input);
  expect(first.publication?.taxCommitment).toBe(second.publication?.taxCommitment);expect(first.publication?.root).toBe(second.publication?.root);
  expect(JSON.parse(first.manifestJson).taxManifest).toEqual(JSON.parse(second.manifestJson).taxManifest);await untouched(f);
 },{roster:true}));
 it('projects a full abort and returns every nominated unit when a positive eligible contribution earns zero net',async()=>fixture(async f=>{
  const input=await prepare(f),h=await funded(f,1n),plan=await h.plan(input);
  expect(plan).toMatchObject({projection:'ABORT_NO_USEFUL_PLAYER_AWARD',publication:null,consumptionAuthorized:false});
  expect(plan.reservations.every(r=>r.proposedConsumed===0&&r.proposedReturned===r.reserved)).toBe(true);
  expect(JSON.parse(plan.manifestJson).participants[0].eligibleUnits).toBe(1);await untouched(f);
 },{roster:true}));
 it('refuses a non-virgin frontier or absent original tax provenance without fabricating prior rights',async()=>fixture(async f=>{
  const input=await prepare(f),h=await funded(f);
  h.backing.model.latest_sequence=1n;await h.backing.config();await expect(h.plan(input)).rejects.toMatchObject({code:'PRIOR_PUBLICATION_UNAVAILABLE'});
  h.backing.model.latest_sequence=0n;await h.backing.config();await expect(createInitialFreeAllocationPlanner(f.conn.db,{qualification:h.q.source,backing:h.sources.backing})(input)).rejects.toMatchObject({code:'TAX_SOURCE_UNAVAILABLE'});await untouched(f);
 },{roster:true}));
 it('refuses altered settlement provenance and unavailable finalized backing rather than yielding a funded plan',async()=>fixture(async f=>{
  const input=await prepare(f),h=await funded(f),first=h.term.bodies.values().next().value!;first.meta!.err={InstructionError:[0,{Custom:1}]};
  await expect(h.plan(input)).rejects.toMatchObject({code:'TAX_SOURCE_UNAVAILABLE'});first.meta!.err=null;
  h.backing.reader.getMultipleAccountsInfoAndContext=async()=>{throw Error('RPC unavailable');};await expect(h.plan(input)).rejects.toMatchObject({code:'PUBLICATION_SOURCE_UNAVAILABLE'});await untouched(f);
 },{roster:true}));
 it('discovers an additional original actor and refuses the whole plan when that actor lacks qualification coverage',async()=>fixture(async f=>{
  const input=await prepare(f),baseId=randomUUID();
  await f.conn.sql`insert into bases(id,owner_wallet,keep_level) values(${baseId},${f.buyer},${BUILD_COSTS.workshop.requiresKeepLevel})`;
  await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.buyer},1,${baseId})`;
  await f.conn.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values(${f.buyer},${baseId},'workshop',1,20,20)`;
  await rewardBaseShards(f.conn.db,baseId,BigInt(FORGE_INGOT.shardsPerIngot)*3n,'test.allocation.second-actor',randomUUID());
  await f.reserve(day,1,day,f.buyer,baseId);await f.clock(null);const h=await funded(f);
  await expect(h.plan(input)).rejects.toMatchObject({code:'SOURCE_QUALIFICATION_UNAVAILABLE'});await untouched(f);
 },{roster:true}));
 it('refuses reservations appended during external proof reads and lets ordinary pre-attempt abort return their stock',async()=>fixture(async f=>{
  const input=await prepare(f),h=await funded(f),original=h.backing.reader.getGenesisHash;let changed=false;
  h.backing.reader.getGenesisHash=async()=>{if(!changed){changed=true;await f.reserve(day);}return original();};
  await expect(h.plan(input)).rejects.toMatchObject({code:'SOURCE_CHANGED'});await untouched(f);
  await abortPendingMiningEpoch(f.conn.db,{epochId:input.epochId,decisionKey:randomUUID(),reason:'changed-unpublished-plan'});
  expect((await f.conn.sql`select sum(qty)::int n from base_items where item_id='forge_ingot'`)[0]!.n).toBe(2);
 },{roster:true}));
});

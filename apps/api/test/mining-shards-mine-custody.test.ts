/** Held Mine custody comes from historical registered facts and archival deeds,
 * never today's owner, a segment label or a caller-provided certificate. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {MINING,getMiningQuota} from '@shardkeep/shared';
import type {DeedMiningWalletReader} from '@shardkeep/chain/mining-wallet';
import {createMiningWalletFixture} from '../../../packages/chain/src/testFixtures/deedMiningWallet';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createTestPlayer} from './helpers';
import {bases,baseSlots,buildings,mineAccrualStates} from '../src/db/schema';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {initializePhysicalMineTaxEra} from '../src/mining/shardsTaxMineSources';
import {reanchorBaseMineAccrual,MINE_DAY_MS} from '../src/game/baseMining';
import {prefetchPhysicalMineCustody,hashPhysicalMineCustodyEvidence} from '../src/mining/shardsTaxMineCustody';

const day='2035-01-02',start=new Date(day+'T00:00:00.000Z');
// The archival fixture has one stable deed identity. Each case owns a fresh DB
// so another case's immutable deed reservation cannot contaminate its history.
let conn:ReturnType<typeof resourceClaimsDatabase>,db:ReturnType<typeof resourceClaimsDatabase>['db'];
beforeEach(async()=>{conn=resourceClaimsDatabase();db=conn.db;await conn.setup();});
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();await conn.close();});
async function clock(at:string){
 if(!/^2035-01-0[1-9]T\d\d:\d\d:\d\d(?:\.\d{6})?Z$/.test(at))throw Error('fixture clock');
 await conn.sql.unsafe(`create or replace function public.shardkeep_mining_roster_clock() returns timestamptz language sql volatile as $$ select '${at}'::timestamptz $$`);
}
async function fixture(options:{deeded?:boolean;baseline?:boolean;days?:number;anchor?:Date}={}){
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 await clock('2035-01-01T12:00:00Z');const player=await createTestPlayer(db),wallet=player.wallet;
 const chain=createMiningWalletFixture({targetWallet:wallet,startAt:start,endAt:new Date(+start+(options.days??1)*MINE_DAY_MS),scenario:'continuous'});
 const [base]=await db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,
  ...(options.deeded?{landPaidAt:new Date(+start-MINE_DAY_MS),deedAssetId:chain.assetId,deedMintAssetId:chain.assetId}:{})}).returning();
 await db.insert(baseSlots).values({wallet,slot:1,baseId:base!.id});
 const anchor=options.anchor??start;
 const [mine]=await db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:anchor,accruedShards:0n});
 if(options.baseline!==false)await initializeMiningRosterHistory(db,wallet);
 await initializePhysicalMineTaxEra(db,{mineId:mine!.id,baseId:base!.id,at:anchor,legacy:0n});
 const quota=BigInt(getMiningQuota(1,[1],0,MINING.EPOCH_RATE_BPS));
 const at=new Date(+anchor+Math.ceil(3*MINE_DAY_MS/Number(quota)));
 await db.transaction(tx=>reanchorBaseMineAccrual(tx,base!.id,at));
 const [segment]=await conn.sql`select id,starts_at,ends_at from shards_mine_segments where mine_id=${mine!.id}`;
 await clock('2035-01-03T00:00:00Z');
 return {wallet,base:base!,mine:mine!,segment:segment!,chain,source:{source:chain.reader as unknown as DeedMiningWalletReader,
  collection:chain.collection,expectedGenesisHash:chain.expectedGenesisHash}};
}
const state=async()=>({segments:await conn.sql`select to_jsonb(s) value from shards_mine_segments s order by id`,
 states:await conn.sql`select to_jsonb(s) value from mine_accrual_states s order by mine_building_id`,
 ledger:await conn.sql`select to_jsonb(t) value from ledger_transactions t order by id`});
function frozen(value:unknown):void{if(value&&typeof value==='object'){expect(Object.isFrozen(value)).toBe(true);expect(value).not.toBeInstanceOf(Date);for(const child of Object.values(value))frozen(child);}}

describe.sequential('historical held Mine custody',()=>{
 it('authenticates registered-free earning from a closed original roster while paused without a provider or money writes',async()=>{
  const f=await fixture(),before=await state();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const result=await prefetchPhysicalMineCustody(db,f.segment.id);
  expect(result).toMatchObject({version:1,purpose:'historical_physical_mine_custody',segment:{id:f.segment.id,wallet:f.wallet,baseId:f.base.id,gross:'3'},
   custody:{status:'confirmed',wallet:f.wallet,baseId:f.base.id,classification:'registered_free'},sourceVerified:true,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  expect(result.custody.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);expect(result.rosters).toHaveLength(1);frozen(result);expect(await state()).toEqual(before);
 });
 it('retains the complete evidence digest after actual JSONB key reordering without turning the digest into authority',async()=>{
  const f=await fixture({deeded:true}),result=await prefetchPhysicalMineCustody(db,f.segment.id,f.source);
  const payload={version:result.version,purpose:result.purpose,segment:result.segment,rosters:result.rosters,deeds:result.deeds};
  const [stored]=await conn.sql`select ${JSON.stringify(payload)}::jsonb evidence`;
  expect(hashPhysicalMineCustodyEvidence(stored!.evidence)).toBe(result.custody.evidenceSha256);
  const changed=structuredClone(stored!.evidence);changed.segment.quota=String(BigInt(changed.segment.quota)+1n);
  expect(hashPhysicalMineCustodyEvidence(changed)).not.toBe(result.custody.evidenceSha256);
  expect(result.postingAuthorized).toBe(false);expect(result.operatingAdmissionAuthorized).toBe(false);
 });
 it('authenticates the original deed using the actual archival wallet verifier',async()=>{
  const f=await fixture({deeded:true}),before=await state();const result=await prefetchPhysicalMineCustody(db,f.segment.id,f.source);
  expect(result.custody).toMatchObject({classification:'deeded',wallet:f.wallet,assetId:f.chain.assetId});
  expect(result.deeds).toMatchObject({targetWallet:f.wallet,continuouslyHeldAssetIds:[f.chain.assetId],evidence:{trust:'trusted-finalized-rpc'}});
  expect(f.chain.reader.getTransaction).toHaveBeenCalled();frozen(result);expect(await state()).toEqual(before);
 });
 it('preserves a proved seller interval after later registered custody changes',async()=>{
  const f=await fixture(),buyer=await createTestPlayer(db);
  await conn.sql`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;
  await conn.sql`delete from base_slots where base_id=${f.base.id}`;
  const result=await prefetchPhysicalMineCustody(db,f.segment.id);expect(result.custody.wallet).toBe(f.wallet);
 });
 it.each(['no baseline','open day','out and back','pending deed','unslotted'] as const)('requires original evidence for %s instead of promoting a copied confirmed label',async scenario=>{
  const f=await fixture({baseline:scenario!=='no baseline'});
  if(scenario==='open day')await clock('2035-01-02T23:59:59.999999Z');
  if(scenario==='out and back'||scenario==='pending deed'||scenario==='unslotted'){
   await clock('2035-01-02T01:00:00Z');
   if(scenario==='out and back'){await conn.sql`update bases set land_paid_at='2035-01-02T01:00:00Z' where id=${f.base.id}`;await conn.sql`update bases set land_paid_at=null where id=${f.base.id}`;}
   if(scenario==='pending deed')await conn.sql`update bases set deed_mint_asset_id=${Keypair.generate().publicKey.toBase58()} where id=${f.base.id}`;
   if(scenario==='unslotted')await conn.sql`update base_slots set active=false where base_id=${f.base.id}`;
   await clock('2035-01-03T00:00:00Z');
  }
  const before=await state();
  if(scenario==='open day'){
   // The calendar day remains open, but the captured unchanged baseline now
   // proves these already completed units through the new interval contract.
   const proof=await prefetchPhysicalMineCustody(db,f.segment.id);expect(proof.version).toBe(2);
   expect(proof.custody.endsAt).toBe(new Date(+new Date(f.segment.ends_at)+1).toISOString());
   expect(proof.rosters[0]!.observedAt).toBe('2035-01-02T23:59:59.999999Z');
  }else await expect(prefetchPhysicalMineCustody(db,f.segment.id)).rejects.toThrow();
  expect(await state()).toEqual(before);
 });
 it.each(['no provider','wrong collection','missing transaction','not continuous'] as const)('holds deed proof: %s',async scenario=>{
  const f=await fixture({deeded:true});
  if(scenario==='wrong collection')f.source.collection=Keypair.generate().publicKey.toBase58();
  if(scenario==='missing transaction')f.chain.reader.getTransaction.mockResolvedValue(null);
  if(scenario==='not continuous'){
   const changed=createMiningWalletFixture({targetWallet:f.wallet,startAt:start,endAt:new Date(+start+MINE_DAY_MS),scenario:'out-back'});
   f.source.source=changed.reader as unknown as DeedMiningWalletReader;
  }
  await expect(prefetchPhysicalMineCustody(db,f.segment.id,scenario==='no provider'?undefined:f.source)).rejects.toThrow();
 });
 it('refuses future earning beyond the read horizon and retains v1 proof once both original days close',async()=>{
  const quota=getMiningQuota(1,[1],0,MINING.EPOCH_RATE_BPS);
  const anchor=new Date(+start+MINE_DAY_MS-Math.ceil(2*MINE_DAY_MS/quota));
  const f=await fixture({anchor,days:2});
  await expect(prefetchPhysicalMineCustody(db,f.segment.id)).rejects.toThrow('DAY_OPEN');
  await clock('2035-01-04T00:00:00Z');const result=await prefetchPhysicalMineCustody(db,f.segment.id);
  if(result.version!==1)throw Error('Closed historical fixture must retain version1');
  expect(result.rosters.map(r=>r.day)).toEqual(['2035-01-02','2035-01-03']);expect(result.segment.gross).toBe('3');
 });
 it.each(['fractional timestamp','unit completion','source key'] as const)('refuses corrupted original %s instead of trusting immutable-table membership',async field=>{
  const f=await fixture();await conn.sql`alter table shards_mine_segments disable trigger shards_mine_segments_guard`;
  try{
   if(field==='fractional timestamp')await conn.sql`update shards_mine_segments set starts_at=starts_at+interval '1 microsecond' where id=${f.segment.id}`;
   if(field==='unit completion')await conn.sql`update shards_mine_segments set quota=quota+1 where id=${f.segment.id}`;
   if(field==='source key')await conn.sql`update shards_mine_segments set source_key='unrelated' where id=${f.segment.id}`;
  }finally{await conn.sql`alter table shards_mine_segments enable trigger shards_mine_segments_guard`;}
  await expect(prefetchPhysicalMineCustody(db,f.segment.id)).rejects.toThrow();
 });
 it('does not retain a caller transaction across archival provider work',async()=>{
  const f=await fixture({deeded:true});await db.transaction(async tx=>{
   await expect(prefetchPhysicalMineCustody(tx as unknown as typeof db,f.segment.id,f.source)).rejects.toThrow('top-level');
  });expect(f.chain.reader.getGenesisHash).not.toHaveBeenCalled();
 });
 it('does not accept unclassified legacy or an unknown segment as original Mine earning',async()=>{
  const f=await fixture();await expect(prefetchPhysicalMineCustody(db,randomUUID())).rejects.toThrow();
  const id=randomUUID();await conn.sql`insert into shards_mine_segments(id,mine_id,base_id,source_key,starts_at,ends_at,quota,gross,buffer)
   values(${id},${f.mine.id},${f.base.id},${'legacy-fixture:'+id},${start.toISOString()},${start.toISOString()},0,1,1)`;
  await expect(prefetchPhysicalMineCustody(db,id)).rejects.toThrow();
 });
 it('rechecks the immutable source after provider work without needing current ownership',async()=>{
  const f=await fixture({deeded:true}),original=f.chain.reader.getGenesisHash.getMockImplementation()!;
  f.chain.reader.getGenesisHash.mockImplementation(async()=>{
   await conn.sql`alter table shards_mine_segments disable trigger shards_mine_segments_guard`;
   try{await conn.sql`update shards_mine_segments set source_key=source_key||':corrupt' where id=${f.segment.id}`;}
   finally{await conn.sql`alter table shards_mine_segments enable trigger shards_mine_segments_guard`;}
   return original();
  });
  await expect(prefetchPhysicalMineCustody(db,f.segment.id,f.source)).rejects.toThrow();
 });
});

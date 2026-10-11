/** First-day Mine custody must come from captured facts, never from today's
 * owner or a transaction's first-mutation timestamp mistaken for commit time. */
import {sql} from 'drizzle-orm';
import {PublicKey} from '@solana/web3.js';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {DeedMiningWalletReader} from '@shardkeep/chain/mining-wallet';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,createBufferedMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {prefetchPhysicalMineCustody,hashPhysicalMineCustodyEvidence} from '../src/mining/shardsTaxMineCustody';
import {resolvePhysicalMineTaxSource} from '../src/mining/shardsTaxMineResolution';
import {readHistoricalMineTaxSource} from '../src/mining/shardsTaxMineRecoveryHistory';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
import {collectBaseMines,reanchorBaseMineAccrual} from '../src/game/baseMining';
import {tx as deedTransaction,asset as archivalAsset,other as archivalOther} from '../../../packages/chain/src/testFixtures/deedMiningWallet';
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
const first=new Date(+mineResolutionFixtureTimes.anchor+5*mineResolutionFixtureTimes.unit),end=new Date(+mineResolutionFixtureTimes.anchor+8*mineResolutionFixtureTimes.unit+1);
const baseline=new Date(+first-1).toISOString();
const archiveStart=new Date(Math.floor(+first/1000)*1000),archiveEnd=new Date(Math.ceil(+end/1000)*1000);
type Mutable<T>=T extends object?{-readonly [K in keyof T]:Mutable<T[K]>}:T;
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);
},120000);
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function source(paid=false,rosterBaselineAt=baseline){
 const f=await createBufferedMineResolutionFixture(conn,{deeded:paid,rosterBaselineAt,deedInterval:{startAt:archiveStart,endAt:archiveEnd}});
 const deedCustody=f.chain?{source:f.chain.reader as unknown as DeedMiningWalletReader,collection:f.chain.collection,expectedGenesisHash:f.chain.expectedGenesisHash}:undefined;
 return {...f,deedCustody,deps:{...fixture.deps,...(deedCustody?{deedCustody}:{})}};
}
const headers=()=>conn.sql`select * from shards_mine_resolutions`;
describe.sequential('original Mine interval custody',()=>{
 it('recovers production after a same-day baseline without pretending the whole first UTC day was covered',async()=>{
  const f=await source(),proof=await prefetchPhysicalMineCustody(conn.db,f.parent.id);
  expect(proof.version).toBe(2);expect(proof.custody.startsAt).toBe(first.toISOString());expect(proof.custody.endsAt).toBe(end.toISOString());
  const result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps);expect(result.header.custody.evidence).toEqual(proof);
  for(const child of result.children)expect((await readHistoricalMineTaxSource(conn.db,child.segment.id)).original.wallet).toBe(f.wallet);
  expect(result.children.map(c=>c.certificate.snapshot.source.round)).toEqual(['0','1']);
 });
 it('requires the actual archival verifier for a paid partial-day interval',async()=>{
  const f=await source(true),result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps),proof=result.header.custody.evidence;
  expect(proof.version).toBe(2);expect(proof.deeds?.startAt).toBe(archiveStart.toISOString());expect(proof.deeds?.endAt).toBe(archiveEnd.toISOString());
  expect(f.chain!.reader.getTransaction).toHaveBeenCalled();expect(proof.custody.assetId).toBe(f.chain!.assetId);
  for(const child of result.children)await expect(readHistoricalMineTaxSource(conn.db,child.segment.id)).resolves.toMatchObject({postingAuthorized:false});
 });
 it('refuses an actual paid out-and-back in the first earning boundary second',async()=>{
  const f=await source(true),chain=f.chain!,wallet=new PublicKey(f.wallet),time=+archiveStart/1000;
  const out=deedTransaction('transfer',12,archivalOther,archivalAsset,wallet),back=deedTransaction('transfer',13,wallet,archivalAsset,archivalOther);
  out.blockTime=time;back.blockTime=time;chain.transactions.push(out,back);
  const priorTime=chain.reader.getBlockTime.getMockImplementation()!,priorBlock=chain.reader.getBlockSignatures.getMockImplementation()!;
  chain.reader.getBlockTime.mockImplementation(async slot=>slot===12||slot===13?time:priorTime(slot));
  chain.reader.getBlockSignatures.mockImplementation(async slot=>{const block=await priorBlock(slot);return slot===12||slot===13?{...block,blockTime:time}:block;});
  expect(time*1000).toBeLessThan(+first);
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();expect(await headers()).toHaveLength(0);
  expect(chain.reader.getTransaction).toHaveBeenCalled();
 });
 it('holds a paid interval when archival proof fails and writes no partial recovery',async()=>{
  const f=await source(true);f.chain!.reader.getGenesisHash.mockRejectedValue(Error('archive unavailable'));
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();expect(await headers()).toHaveLength(0);
  expect(await conn.sql`select buffer,gross,resolved from shards_mine_segments where id=${f.parent.id}`).toEqual([{buffer:'4',gross:'4',resolved:'0'}]);
 });
 it('rejects a custody observation one microsecond after the server verification clock before committing any graph or term',async()=>{
  const f=await source(),before={segments:await conn.sql`select to_jsonb(s) value from shards_mine_segments s order by id`,terms:await conn.sql`select to_jsonb(t) value from expedition_term_snapshots t order by term_id`};
  await fixture.rosterClock(fixture.verified.toISOString().replace('Z','001Z'));
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow('custody observed after verification');
  expect(await headers()).toHaveLength(0);
  expect({segments:await conn.sql`select to_jsonb(s) value from shards_mine_segments s order by id`,terms:await conn.sql`select to_jsonb(t) value from expedition_term_snapshots t order by term_id`}).toEqual(before);
 });
 it.each([first.toISOString(),first.toISOString().replace('Z','001Z')])('refuses a baseline at or after first completion: %s',async at=>{
  const f=await source(false,at);await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();expect(await headers()).toHaveLength(0);
 });
 it('collects and independently replays mixed interval/closed-day proof versions with one conserved carry',async()=>{
  const f=await source();await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps);
  await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,f.base.id,fixture.verified));
  for(const p of await conn.sql`select id from shards_mine_segments where mine_id=${f.mine.id} and wallet=${f.wallet} and recovery_parent_id is null and buffer>0`)await resolvePhysicalMineTaxSource(conn.db,p.id,f.deps);
  expect((await headers()).map(h=>h.custody.evidence.version).sort()).toEqual([1,2]);
  const gross=BigInt(fixture.quota),tax=(gross-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints),context={baseId:f.base.id,assertAuthority:async()=>{}};
  expect((await collectBaseMines(conn.db,f.wallet,context,fixture.verified)).amount).toBe(gross-tax);
  const terms=await conn.sql`select distinct term_id,term_hash from shards_mine_resolution_terms`;let total=0n;
  for(const t of terms)total+=await readCompleteShardsTaxPool(conn.db,t.term_id,t.term_hash);expect(total).toBe(tax);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const reopened=conn.reopen();
  try{for(const t of terms)await expect(readCompleteShardsTaxPool(reopened.db,t.term_id,t.term_hash)).resolves.toBeGreaterThanOrEqual(0n);
   expect((await collectBaseMines(reopened.db,f.wallet,context,fixture.verified)).amount).toBe(0n);
  }finally{await reopened.sql.end();}
 });
 it.each(['baseline','observation','bounds'] as const)('refuses rehashed interval %s corruption from immutable stored JSONB',async field=>{
  const f=await source(),result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps),abort=Error('restore original fixture evidence');
  await expect(conn.db.transaction(async tx=>{
   await tx.execute(sql`set local session_replication_role='replica'`);
   const copy=structuredClone(result.header.custody) as Mutable<typeof result.header.custody>,r=copy.evidence.rosters[0] as unknown as {baseline:{observedAt:string};observedAt:string};
   if(field==='baseline')r.baseline.observedAt=first.toISOString().replace('Z','000Z');
   else if(field==='observation')r.observedAt=new Date(+fixture.verified+1).toISOString().replace('Z','000Z');
   else copy.evidence.custody.startsAt=new Date(+first+1).toISOString();
   copy.evidence.custody.evidenceSha256=hashPhysicalMineCustodyEvidence(copy.evidence);Object.assign(copy,copy.evidence.custody);
   await tx.execute(sql`update shards_mine_resolutions set custody=${JSON.stringify(copy)}::jsonb where parent_id=${f.parent.id}`);
   await expect(readHistoricalMineTaxSource(tx,result.children[0]!.segment.id)).rejects.toThrow();throw abort;
  })).rejects.toBe(abort);
  await expect(readHistoricalMineTaxSource(conn.db,result.children[0]!.segment.id)).resolves.toMatchObject({postingAuthorized:false});
 });
});

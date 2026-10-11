/** A later registered base needs a prior committed observation of its own.
 * Existing wallet enrollment cannot stand in for its original earning custody. */
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {PHASE_E_HARVESTER} from '@shardkeep/shared';
import type {DeedMiningWalletReader} from '@shardkeep/chain/mining-wallet';
import {createMiningWalletFixture} from '../../../packages/chain/src/testFixtures/deedMiningWallet';
import {createMiningTermFixture} from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import {buildApp} from '../src/app';
import {issueSessionJwt,SESSION_COOKIE,SESSION_TTL_SEC} from '../src/auth/session';
import {createMiningRosterEnrollmentProvider} from '../src/mining/rosterEnrollmentGameplay';
import {createPhysicalMineRecoveryProvider} from '../src/mining/shardsTaxMineRecoveryProvider';
import {readCompleteShardsTaxPool} from '../src/mining/shardsTaxHistory';
import {TEST_CONFIG} from './helpers';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {bases,baseSlots,buildings,mineAccrualStates,players,sessions} from '../src/db/schema';
import {initializeMiningRosterHistory} from '../src/mining/rosterHistory';
import {captureMiningRosterCheckpoint} from '../src/mining/rosterCheckpoints';
import {prefetchPhysicalMineCustody,hashPhysicalMineCustodyEvidence} from '../src/mining/shardsTaxMineCustody';
import {resolvePhysicalMineTaxSource} from '../src/mining/shardsTaxMineResolution';
import {readHistoricalMineTaxSource} from '../src/mining/shardsTaxMineRecoveryHistory';
import {reanchorBaseMineAccrual} from '../src/game/baseMining';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
const servers:FastifyInstance[]=[];
const first=new Date(+mineResolutionFixtureTimes.anchor+5*mineResolutionFixtureTimes.unit),end=new Date(+mineResolutionFixtureTimes.anchor+8*mineResolutionFixtureTimes.unit+1);
const archiveStart=new Date(Math.floor(+first/1000)*1000),archiveEnd=new Date(Math.ceil(+end/1000)*1000);
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);
},120000);
afterEach(async()=>{await Promise.all(servers.splice(0).map(app=>app.close()));vi.restoreAllMocks();vi.unstubAllEnvs();vi.useRealTimers();await conn.close();});
async function source(options:{paid?:boolean;checkpointAt?:string;recapture?:boolean;outback?:boolean;http?:boolean}={}){
 await fixture.rosterClock('2035-01-01T00:00:00Z');const wallet=Keypair.generate().publicKey.toBase58();await conn.db.insert(players).values({wallet});
 const [firstBase]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1}).returning();
 await conn.db.insert(baseSlots).values({wallet,slot:1,baseId:firstBase!.id});await initializeMiningRosterHistory(conn.db,wallet);
 const checkpointAt=options.checkpointAt??'2035-01-07T12:00:00.123456Z';await fixture.rosterClock(checkpointAt);
 const chain=options.paid?createMiningWalletFixture({targetWallet:wallet,startAt:archiveStart,endAt:archiveEnd,scenario:'continuous'}):null;
 const [base]=await conn.db.insert(bases).values({ownerWallet:wallet,status:'active',keepLevel:1,...(chain?{landPaidAt:new Date('2035-01-07T11:00:00Z'),deedAssetId:chain.assetId,deedMintAssetId:chain.assetId}:{})}).returning();
 await conn.db.insert(baseSlots).values({wallet,slot:2,baseId:base!.id});
 let app:FastifyInstance|undefined,cookies:Record<string,string>|undefined;
 if(options.http){
  vi.setSystemTime(new Date(checkpointAt));const [session]=await conn.db.insert(sessions).values({wallet,expiresAt:new Date(+fixture.verified+SESSION_TTL_SEC*1000)}).returning();
  cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};
  const old=fixture.bank.original,current=await createMiningTermFixture({day:'2035-01-16',round:2n,firstOperatingStart:BigInt(Date.parse('2035-01-01T00:00:00Z')/1000),
   genesisHash:old.policy.genesisHash,programId:old.policy.programId,mint:old.policy.mint,prizeOwner:old.policy.prizeOwner,programData:old.programData,programDataAddress:old.programDataAddress,upgradeAuthority:old.upgradeAuthority});
  vi.stubEnv('MULTI_BASE_ENABLED','false');try{app=await buildApp(TEST_CONFIG,conn.db,{miningRosterEnrollmentProvider:createMiningRosterEnrollmentProvider(conn.db),physicalMineSourceProvider:current,physicalMineRecoveryProvider:createPhysicalMineRecoveryProvider(conn.db,fixture.deps)});servers.push(app);await app.ready();}finally{vi.stubEnv('MULTI_BASE_ENABLED','true');}
  const response=await app.inject({method:'GET',url:'/base?baseId='+base!.id,cookies});expect(response.statusCode,response.body).toBe(200);
  expect(await conn.sql`select id from mining_roster_checkpoints where wallet=${wallet}`).toHaveLength(1);
 }else await captureMiningRosterCheckpoint(conn.db,wallet);
 if(options.outback){
  const buyer=Keypair.generate().publicKey.toBase58();await conn.db.insert(players).values({wallet:buyer});
  // Later IDs retain relevance even if the transaction clock moves backward.
  await fixture.rosterClock(options.recapture?'2035-01-07T13:00:00Z':'2035-01-07T11:30:00Z');
  await conn.sql.begin(async tx=>{await tx`delete from base_slots where base_id=${base!.id}`;await tx`update bases set owner_wallet=${buyer} where id=${base!.id}`;});
  await conn.sql.begin(async tx=>{await tx`update bases set owner_wallet=${wallet} where id=${base!.id}`;await tx`insert into base_slots(wallet,slot,base_id) values(${wallet},2,${base!.id})`;});
  if(options.recapture){await fixture.rosterClock('2035-01-07T14:00:00Z');await captureMiningRosterCheckpoint(conn.db,wallet);}
 }
 const [mine]=await conn.db.insert(buildings).values({playerWallet:wallet,baseId:base!.id,type:'mine',level:1,tx:1,ty:1}).returning();
 await conn.db.insert(mineAccrualStates).values({mineBuildingId:mine!.id,lastAccrualAt:fixture.anchor});
 await conn.db.transaction(tx=>reanchorBaseMineAccrual(tx,base!.id,new Date(+fixture.anchor+8*fixture.unit)));
 const [parent]=await conn.sql`select * from shards_mine_segments where mine_id=${mine!.id} and wallet=${wallet}`;
 expect(parent).toMatchObject({first_unit:'5',last_unit:'8'});await fixture.rosterClock(fixture.verified.toISOString());
 vi.setSystemTime(fixture.verified);
 if(options.http){const [session]=await conn.sql`select id from sessions where wallet=${wallet} order by id limit 1`;cookies={[SESSION_COOKIE]:await issueSessionJwt(TEST_CONFIG,wallet,session!.id)};}
 const deedCustody=chain?{source:chain.reader as unknown as DeedMiningWalletReader,collection:chain.collection,expectedGenesisHash:chain.expectedGenesisHash}:undefined;
 return {wallet,base:base!,mine:mine!,parent:parent!,chain,deps:{...fixture.deps,...(deedCustody?{deedCustody}:{})},deedCustody,app,cookies};
}
describe.sequential('Mine custody from prospective later-roster checkpoints',()=>{
 it('proves a later base across its first closed UTC day and independently replays the actual original terms',async()=>{
  const f=await source(),proof=await prefetchPhysicalMineCustody(conn.db,f.parent.id);
  expect(proof.version).toBe(3);expect(proof.custody.baseId).toBe(f.base.id);
  const result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,fixture.deps);expect(result.header.custody.evidence).toEqual(proof);
  expect(result.children.map(c=>c.certificate.snapshot.source.round)).toEqual(['0','1']);
  for(const child of result.children)expect((await readHistoricalMineTaxSource(conn.db,child.segment.id)).original.wallet).toBe(f.wallet);
 });
 it('requires the actual paid archive while allowing recorded ownership acquired after the first day opened',async()=>{
  const f=await source({paid:true}),result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps),proof=result.header.custody.evidence;
  expect(proof.version).toBe(3);expect(proof.deeds?.startAt).toBe(archiveStart.toISOString());expect(proof.deeds?.endAt).toBe(archiveEnd.toISOString());
  expect(f.chain!.reader.getTransaction).toHaveBeenCalled();expect(proof.custody.assetId).toBe(f.chain!.assetId);
  for(const child of result.children)await expect(readHistoricalMineTaxSource(conn.db,child.segment.id)).resolves.toMatchObject({postingAuthorized:false});
 });
 it('keeps paid provider failures as hard holds with no partial resolution',async()=>{
  const f=await source({paid:true});f.chain!.reader.getGenesisHash.mockRejectedValue(Error('archive unavailable'));
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();expect(f.chain!.reader.getGenesisHash).toHaveBeenCalledOnce();
  expect(await conn.sql`select * from shards_mine_resolutions`).toHaveLength(0);
  expect(await conn.sql`select buffer,gross,resolved from shards_mine_segments where id=${f.parent.id}`).toEqual([{buffer:'4',gross:'4',resolved:'0'}]);
 });
 it('rejects an out-and-back hidden behind a regressed transaction timestamp after the checkpoint frontier',async()=>{
  const f=await source({outback:true});await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();
  expect(await conn.sql`select * from shards_mine_resolutions`).toHaveLength(0);
 });
 it('uses a new pre-earning checkpoint after reacquisition without rewriting the original baseline or earlier snapshot',async()=>{
  const f=await source({outback:true,recapture:true}),rows=await conn.sql`select id from mining_roster_checkpoints where wallet=${f.wallet} order by observed_at`;
  expect(rows).toHaveLength(2);const result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps),proof=result.header.custody.evidence;
  if(proof.version!==3)throw Error('checkpoint proof required');expect(proof.rosters[0]!.checkpoint.id).toBe(rows[1]!.id);
  expect(await conn.sql`select jsonb_array_length(bases) count from mining_roster_baselines where wallet=${f.wallet}`).toEqual([{count:1}]);
  for(const child of result.children)await expect(readHistoricalMineTaxSource(conn.db,child.segment.id)).resolves.toMatchObject({postingAuthorized:false});
 });
 it.each([first.toISOString(),first.toISOString().replace('Z','001Z')])('cannot backdate a checkpoint at or after first earning: %s',async checkpointAt=>{
  const f=await source({checkpointAt});await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps)).rejects.toThrow();expect(await conn.sql`select * from shards_mine_resolutions`).toHaveLength(0);
 });
 it('enrolls a later base through normal HTTP then collects mixed checkpoint/closed-day history and survives paused reconnect',async()=>{
  vi.stubEnv('FREE_ONBOARDING','true');const f=await source({http:true});
  const response=await f.app!.inject({method:'POST',url:'/mine/collect',payload:{baseId:f.base.id},cookies:f.cookies!});expect(response.statusCode,response.body).toBe(200);
  const gross=BigInt(fixture.quota),tax=(gross-4n)*BigInt(PHASE_E_HARVESTER.v1.islandPoolBps)/BigInt(PHASE_E_HARVESTER.v1.taxBasisPoints);
  expect(response.json()).toEqual({amount:(gross-tax).toString()});
  expect((await conn.sql`select custody from shards_mine_resolutions`).map(r=>r.custody.evidence.version).sort()).toEqual([1,3]);
  const terms=await conn.sql`select distinct term_id,term_hash from shards_mine_resolution_terms`;let pool=0n;
  for(const t of terms)pool+=await readCompleteShardsTaxPool(conn.db,t.term_id,t.term_hash);expect(pool).toBe(tax);
  const before=await conn.sql`select id from ledger_transactions where type='mine.collect' and metadata->>'baseId'=${f.base.id}`;expect(before).toHaveLength(1);
  const reopened=conn.reopen();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  try{vi.stubEnv('MULTI_BASE_ENABLED','false');const app=await buildApp(TEST_CONFIG,reopened.db);servers.push(app);await app.ready();vi.stubEnv('MULTI_BASE_ENABLED','true');
   const retry=await app.inject({method:'POST',url:'/mine/collect',payload:{baseId:f.base.id},cookies:f.cookies!});expect(retry.statusCode,retry.body).toBe(200);expect(retry.json()).toEqual({amount:'0'});
   for(const t of terms)await expect(readCompleteShardsTaxPool(reopened.db,t.term_id,t.term_hash)).resolves.toBeGreaterThanOrEqual(0n);
   expect(await conn.sql`select id from ledger_transactions where type='mine.collect' and metadata->>'baseId'=${f.base.id}`).toEqual(before);await app.close();servers.splice(servers.indexOf(app),1);
  }finally{await reopened.sql.end();}
 });
 it.each(['capture','target','observation'] as const)('independently refuses rehashed checkpoint %s corruption',async field=>{
  const f=await source(),result=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps),abort=Error('restore original fixture');
  await expect(conn.db.transaction(async tx=>{
   await tx.execute(sql`set local session_replication_role='replica'`);
   const copy=JSON.parse(JSON.stringify(result.header.custody)) as typeof result.header.custody;
   if(copy.evidence.version!==3)throw Error('checkpoint proof required');const r=copy.evidence.rosters[0]!;
   if(field==='capture')r.checkpoint.observedAt=first.toISOString().replace('Z','000Z');
   else if(field==='target')r.checkpoint.bases=r.checkpoint.bases.filter(b=>b.id!==f.base.id);
   else r.observedAt=new Date(+fixture.verified+1).toISOString().replace('Z','000Z');
   // The immutable writer is bypassed only inside this rolled-back adversarial
   // fixture so independent replay must reject bad retained evidence itself.
   const hash=hashPhysicalMineCustodyEvidence(copy.evidence);Object.assign(copy.evidence.custody,{evidenceSha256:hash});Object.assign(copy,copy.evidence.custody);
   await tx.execute(sql`update shards_mine_resolutions set custody=${JSON.stringify(copy)}::jsonb where parent_id=${f.parent.id}`);
   await expect(readHistoricalMineTaxSource(tx,result.children[0]!.segment.id)).rejects.toThrow();throw abort;
  })).rejects.toBe(abort);
  await expect(readHistoricalMineTaxSource(conn.db,result.children[0]!.segment.id)).resolves.toMatchObject({postingAuthorized:false});
 });
});

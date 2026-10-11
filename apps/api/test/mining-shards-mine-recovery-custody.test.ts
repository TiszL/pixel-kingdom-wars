/** Paid historical repair must retain real closed archival custody; neither
 * today's owner nor a copied digest can replace the original evidence. */
import {Keypair,PublicKey} from '@solana/web3.js';
import {createMiningWalletFixture,tx as deedTransaction,asset as archivalAsset,other as archivalOther} from '../../../packages/chain/src/testFixtures/deedMiningWallet';
import {sql} from 'drizzle-orm';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {resourceClaimsDatabase} from './fixtures/resourceClaimsDatabase';
import {createHistoricalMineResolutionFixture,mineResolutionFixtureTimes} from './fixtures/historicalMineResolution';
import {createTestPlayer} from './helpers';
import {resolvePhysicalMineTaxSource} from '../src/mining/shardsTaxMineResolution';
import {readHistoricalMineTaxSource} from '../src/mining/shardsTaxMineRecoveryHistory';
import {hashPhysicalMineCustodyEvidence} from '../src/mining/shardsTaxMineCustody';
let conn:ReturnType<typeof resourceClaimsDatabase>,fixture:Awaited<ReturnType<typeof createHistoricalMineResolutionFixture>>;
beforeEach(async()=>{
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(mineResolutionFixtureTimes.verified);
 vi.stubEnv('MULTI_BASE_ENABLED','true');vi.stubEnv('PHASE_E_MINING_ENABLED','true');
 conn=resourceClaimsDatabase();await conn.setup();fixture=await createHistoricalMineResolutionFixture(conn);
},120000);
afterEach(async()=>{vi.unstubAllEnvs();vi.restoreAllMocks();vi.useRealTimers();await conn.close();});
const state=async(id:string)=>({parents:await conn.sql`select * from shards_mine_segments where id=${id}`,
 headers:await conn.sql`select * from shards_mine_resolutions where parent_id=${id}`,
 children:await conn.sql`select * from shards_mine_segments where recovery_parent_id=${id}`,
 assessments:await conn.sql`select * from shards_tax_assessments`});
type Mutable<T>=T extends object?{-readonly [K in keyof T]:Mutable<T[K]>}:T;
type Paid=Awaited<ReturnType<typeof fixture.createResolvedDeededSource>>;
async function corrupt(f:Paid,mutate:(proof:Mutable<typeof f.resolution.header.custody>)=>void,rehash:boolean){
 const abort=Error('rollback isolated stored-proof corruption');
 await expect(conn.db.transaction(async tx=>{
  await tx.execute(sql`set local session_replication_role='replica'`);
  const changed=structuredClone(f.resolution.header.custody) as Mutable<typeof f.resolution.header.custody>;mutate(changed);
  if(rehash){changed.evidence.custody.evidenceSha256=hashPhysicalMineCustodyEvidence(changed.evidence);changed.evidenceSha256=changed.evidence.custody.evidenceSha256;}
  await tx.execute(sql`update shards_mine_resolutions set custody=${JSON.stringify(changed)}::jsonb where parent_id=${f.parent.id}`);
  const held=await readHistoricalMineTaxSource(tx,f.resolution.children[0]!.segment.id).then(()=>false,()=>true);
  expect(held,'corrupted stored source must be held').toBe(true);throw abort;
 })).rejects.toBe(abort);
}
describe.sequential('paid original Mine recovery custody',()=>{
 it('resolves actual closed Jan7–Jan9 deed custody and independently reads both original terms',async()=>{
  const f=await fixture.createResolvedDeededSource(),proof=f.resolution.header.custody.evidence;
  if(proof.version!==1)throw Error('Closed historical fixture must retain version1');
  expect(proof.custody).toMatchObject({classification:'deeded',assetId:f.chain.assetId,wallet:f.wallet,startsAt:'2035-01-07T00:00:00.000Z',endsAt:'2035-01-09T00:00:00.000Z'});
  expect(proof.rosters.map(r=>r.day)).toEqual(['2035-01-07','2035-01-08']);
  expect(proof.deeds).toMatchObject({targetWallet:f.wallet,continuouslyHeldAssetIds:[f.chain.assetId],evidence:{trust:'trusted-finalized-rpc'}});
  expect(f.chain.reader.getTransaction).toHaveBeenCalled();
  for(const child of f.resolution.children){const source=await readHistoricalMineTaxSource(conn.db,child.segment.id);
   expect(source.original).toMatchObject({parentId:f.parent.id,childId:child.segment.id,wallet:f.wallet,baseId:f.base.id,custodyHash:proof.custody.evidenceSha256});
   expect(source.term).toEqual(child.certificate);expect(source).toMatchObject({postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  }
  expect((await state(f.parent.id)).assessments).toHaveLength(0);
 });
 it('preserves the original paid seller after a later transfer and reads stored proof paused without archival RPC',async()=>{
  const f=await fixture.createDeededSource(),buyer=await createTestPlayer(conn.db);
  await conn.sql`update bases set owner_wallet=${buyer.wallet} where id=${f.base.id}`;await conn.sql`delete from base_slots where base_id=${f.base.id}`;
  const resolution=await resolvePhysicalMineTaxSource(conn.db,f.parent.id,f.deps),before=await readHistoricalMineTaxSource(conn.db,resolution.children[0]!.segment.id);
  const reads=f.chain.reader.getTransaction.mock.calls.length;vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  f.chain.reader.getTransaction.mockRejectedValue(Error('archival source offline after original commit'));const reopened=conn.reopen();
  try{expect(await readHistoricalMineTaxSource(reopened.db,resolution.children[0]!.segment.id)).toEqual(before);}
  finally{await reopened.sql.end();}
  expect(before.original.wallet).toBe(f.wallet);expect(f.chain.reader.getTransaction).toHaveBeenCalledTimes(reads);
 });
 it.each(['missing','wrong collection','wrong genesis','missing transaction'] as const)('holds %s archival authority before changing original quantity',async kind=>{
  const f=await fixture.createDeededSource(),before=await state(f.parent.id),deps={...f.deps,deedCustody:{...f.deedCustody}};
  if(kind==='wrong collection')deps.deedCustody.collection=Keypair.generate().publicKey.toBase58();
  if(kind==='wrong genesis')deps.deedCustody.expectedGenesisHash=Keypair.generate().publicKey.toBase58();
  if(kind==='missing transaction')f.chain.reader.getTransaction.mockResolvedValue(null);
  const configured=kind==='missing'?fixture.deps:deps;
  await expect(resolvePhysicalMineTaxSource(conn.db,f.parent.id,configured)).rejects.toThrow();expect(await state(f.parent.id)).toEqual(before);
 });
 it.each(['archival owner','roster actor','inner digest'] as const)('rejects changed %s without trusting the outer receipt digest',async kind=>{
  const f=await fixture.createResolvedDeededSource();await corrupt(f,proof=>{
   if(kind==='archival owner')proof.evidence.deeds!.evidence.assets[0]!.ownerAtStart=Keypair.generate().publicKey.toBase58();
   if(kind==='roster actor'){
    if(proof.evidence.version!==1)throw Error('Closed historical fixture must retain version1');
    proof.evidence.rosters[0]!.open.slots[0]!.wallet=Keypair.generate().publicKey.toBase58();
   }
   if(kind==='inner digest')proof.evidence.custody.evidenceSha256='0'.repeat(64);
  },false);
 });
 it('rejects an internally coherent out-and-back archive even when declared continuity and outer digest are copied',async()=>{
  const f=await fixture.createResolvedDeededSource(),start=new Date('2035-01-07T00:00:00Z'),end=new Date('2035-01-09T00:00:00Z');
  const archive=createMiningWalletFixture({targetWallet:f.wallet,startAt:start,endAt:end,scenario:'continuous'}),wallet=new PublicKey(f.wallet);
  const out=deedTransaction('transfer',12,archivalOther,archivalAsset,wallet),back=deedTransaction('transfer',13,wallet,archivalAsset,archivalOther);
  out.blockTime=(+start+(+end-+start)/3)/1000;back.blockTime=(+start+2*(+end-+start)/3)/1000;archive.transactions.push(out,back);
  // The actual archival verifier accepts this coherent event history but denies
  // continuous ownership. The stored declaration must not overrule its events.
  const history=await archive.read();expect(history.continuouslyHeldAssetIds).toEqual([]);
  expect(history.evidence.assets[0]!.ownerAtStart).toBe(f.wallet);expect(history.evidence.assets[0]!.transactions).toHaveLength(2);
  await corrupt(f,proof=>{proof.evidence.deeds!.evidence.assets=JSON.parse(JSON.stringify(history.evidence.assets));},true);
 });
 it.each(['missing archival asset','contradictory original owner','future archival horizon'] as const)('rejects %s even when the complete payload digest is recomputed',async kind=>{
  const f=await fixture.createResolvedDeededSource();await corrupt(f,proof=>{
   if(kind==='missing archival asset')proof.evidence.deeds!.evidence.assets=[];
   if(kind==='contradictory original owner')proof.evidence.deeds!.evidence.assets[0]!.ownerAtStart=Keypair.generate().publicKey.toBase58();
   if(kind==='future archival horizon')proof.evidence.deeds!.throughBlockTime=Math.floor(+fixture.verified/1000)+1;
  },true);
 });
});

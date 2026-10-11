/** Historical metadata is persisted through a server reader, never promoted to issuance authority. */
import {randomUUID} from 'node:crypto';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {Keypair,PublicKey} from '@solana/web3.js';
import bs58 from 'bs58';
import {eq} from 'drizzle-orm';
import {afterAll,afterEach,describe,expect,it} from 'vitest';
import {expeditionTermSnapshots} from '../src/db/schema';
import {hashExpeditionTermSnapshot,parseExpeditionTermObservation,parseExpeditionTermSnapshot} from '../src/game/expeditionTerms';
import {pinHistoricalShardsTerm,pinOperatingExpeditionTerm,readStoredExpeditionTerm} from '../src/game/expeditionTermStore';
import {hashHistoricalShardsTermCertificate} from '../src/mining/shardsTaxObstacleEvidence';
import {connectTestDb} from './helpers';

const conn=connectTestDb(),db=conn.db;
afterAll(()=>conn.sql.end());
const current={...PHASE_E_POLICY.seekerIsland};
afterEach(()=>Object.assign(PHASE_E_POLICY.seekerIsland,current));
const start='2035-01-01T00:00:00.000Z',duration=current.operatingTermSec*1000;
const iso=(offset:number)=>new Date(Date.parse(start)+offset).toISOString();
const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
function fixture(){
 const snapshot={version:1 as const,termId:randomUUID(),startsAt:start,endsAt:iso(duration),
  source:{kind:'solana_auction_round' as const,genesisHash:key(201),programId:key(202),auctionConfig:Keypair.generate().publicKey.toBase58(),round:'1'},
  spots:Array.from({length:current.totalSpots},(_,spotId)=>({spotId,ownerWallet:spotId<2?key(204):null,
   auctionAccount:key(spotId+1),settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))};
 return {version:1 as const,purpose:'historical_shards_attribution' as const,snapshot,termHash:hashExpeditionTermSnapshot(snapshot),
  completedAt:iso(1000),completedSlot:String(99+current.totalSpots),
  deployment:{programDataAddress:key(205),programDataSha256:'cd'.repeat(32),deployedSlot:'99',upgradeAuthority:key(206) as string|null},
  finality:{commitment:'finalized' as const,contextSlot:'300',observedAt:iso(duration+1000)},operatingAdmissionAuthorized:false as const};
}
type Certificate=ReturnType<typeof fixture>;
const pin=(value:Certificate)=>pinHistoricalShardsTerm(db,{readHistoricalTerm:async()=>value});
const absent=async(t:Certificate)=>expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId,t.snapshot.termId))).toEqual([]);
const operating=(t:Certificate)=>pinOperatingExpeditionTerm(db,new Date(iso(2000)),{readOperatingTerm:async()=>({snapshot:t.snapshot,finality:{...t.finality,observedAt:iso(1000)}})});
function shift(t:Certificate,offset:number):Certificate{
 const changed=structuredClone(t);changed.snapshot.termId=randomUUID();changed.snapshot.source.round=String(BigInt(changed.snapshot.source.round)+1n);
 changed.snapshot.startsAt=iso(offset);changed.snapshot.endsAt=iso(duration+offset);changed.completedAt=iso(offset+1000);
 changed.finality.observedAt=iso(duration+offset+1000);changed.termHash=hashExpeditionTermSnapshot(changed.snapshot);return changed;
}

describe('historical-only term persistence shares the original snapshot identity',()=>{
 it('pins an expired certificate without changing its observation or granting operating/posting authority',async()=>{
  const t=fixture(),r=await pin(t);
  expect(r.snapshot).toEqual(t.snapshot);expect(r.hash).toBe(t.termHash);expect(r.certificate).toEqual(t);
  expect(r.historicalCertificateHash).toBe(hashHistoricalShardsTermCertificate(t));
  expect(r).toMatchObject({sourceVerified:false,postingAuthorized:false,payoutAuthorized:false,operatingAdmissionAuthorized:false});
  expect(await readStoredExpeditionTerm(db,t.snapshot.termId,t.termHash)).toEqual({snapshot:r.snapshot,hash:r.hash});
  expect(()=>parseExpeditionTermObservation({snapshot:t.snapshot,finality:t.finality},iso(2000))).toThrow('not observed');
 });
 it('shares one snapshot with operating pinning but preserves different historical certificates',async()=>{
  const t=fixture(),original=await operating(t),a=await pin(t),other=structuredClone(t);
  other.finality.contextSlot='400';other.finality.observedAt=iso(duration+2000);const b=await pin(other);
  expect(a.hash).toBe(original.hash);expect(b.hash).toBe(a.hash);expect(b.historicalCertificateHash).not.toBe(a.historicalCertificateHash);
  expect(a.certificate.finality.observedAt).toBe(t.finality.observedAt);
  expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId,t.snapshot.termId))).toHaveLength(1);
 });
 it('retains explicit all-unsold original winners without replacing missing reader evidence',async()=>{
  const t=fixture();t.snapshot.spots.forEach(s=>{s.ownerWallet=null;});t.termHash=hashExpeditionTermSnapshot(t.snapshot);
  expect((await pin(t)).snapshot.spots.every(s=>s.ownerWallet===null)).toBe(true);
  await expect(pinHistoricalShardsTerm(db)).rejects.toThrow('unavailable');
  await expect(pinHistoricalShardsTerm(db,{readHistoricalTerm:async()=>null})).rejects.toThrow('unavailable');
  await expect(pinHistoricalShardsTerm(db,{readHistoricalTerm:async()=>{throw Error('provider unavailable');}})).rejects.toThrow('provider unavailable');
 });
 it('does not accept raw certificate JSON in place of a server-owned reader',async()=>{
  const t=fixture();await expect(pinHistoricalShardsTerm(db,t as never)).rejects.toThrow();await absent(t);
 });
 it('validates full completion/deployment evidence before storing a snapshot',async()=>{
  for(const patch of ['hash','slot','time','admission'] as const){
   const t=fixture();if(patch==='hash')t.termHash='0'.repeat(64);if(patch==='slot')t.completedSlot='100';
   if(patch==='time')t.completedAt=iso(duration+2000);if(patch==='admission')Reflect.set(t,'operatingAdmissionAuthorized',true);
   await expect(pin(t)).rejects.toThrow();await absent(t);
  }
 });
 it('clones reader output before transaction waits so mutation cannot change the accepted certificate',async()=>{
  const t=fixture(),saved=structuredClone(t);let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),ready=new Promise<void>(r=>{entered=r;});
  const heldDb=Object.create(db) as typeof db;
  heldDb.transaction=async(callback,config)=>{entered();await gate;return db.transaction(callback,config);};
  const pending=pinHistoricalShardsTerm(heldDb,{readHistoricalTerm:async()=>t});await ready;
  try{t.snapshot.spots[0]!.ownerWallet=key(207);t.deployment.programDataSha256='ef'.repeat(32);t.finality.contextSlot='999';}
  finally{release();}
  const accepted=await pending;expect(accepted.certificate).toEqual(saved);expect(Object.isFrozen(accepted.certificate.deployment)).toBe(true);
 });
 it('serializes current and historical duplicates under the same source lock',async()=>{
  const t=fixture(),r=await Promise.all([pin(t),operating(t),pin(t)]);expect(r.every(p=>p.hash===t.termHash)).toBe(true);
 });
 it('refuses concurrent conflicting bodies even across different source locks',async()=>{
  const a=fixture(),b=fixture();b.snapshot.termId=a.snapshot.termId;b.termHash=hashExpeditionTermSnapshot(b.snapshot);
  const r=await Promise.allSettled([pin(a),pin(b)]);expect(r.filter(p=>p.status==='fulfilled')).toHaveLength(1);expect(r.filter(p=>p.status==='rejected')).toHaveLength(1);
 });
 it('refuses source-round aliases and overlapping historical/current intervals',async()=>{
  const t=fixture();await pin(t);const alias=structuredClone(t);alias.snapshot.termId=randomUUID();alias.termHash=hashExpeditionTermSnapshot(alias.snapshot);
  await expect(pin(alias)).rejects.toThrow('round');await absent(alias);
  const overlap=shift(t,duration/2);await expect(pinOperatingExpeditionTerm(db,new Date(overlap.completedAt),{readOperatingTerm:async()=>({snapshot:overlap.snapshot,finality:{...overlap.finality,observedAt:overlap.completedAt}})})).rejects.toThrow('overlap');
  await expect(pin(overlap)).rejects.toThrow('overlap');await absent(overlap);
  expect((await pin(shift(t,duration))).snapshot.startsAt).toBe(t.snapshot.endsAt);
 });
 it('rolls back historical pinning with an enclosing transaction and refuses repeatable-read',async()=>{
  const t=fixture();await expect(db.transaction(async tx=>{await pinHistoricalShardsTerm(tx,{readHistoricalTerm:async()=>t});throw Error('later work failed');})).rejects.toThrow('later work failed');await absent(t);
  await expect(db.transaction(tx=>pinHistoricalShardsTerm(tx,{readHistoricalTerm:async()=>t}),{isolationLevel:'repeatable read'})).rejects.toThrow('read committed');await absent(t);
 });
 it('keeps saved v1 decoding and historical ingestion independent of current term sizing while current admission holds',async()=>{
  const saved=fixture(),later=fixture();await pin(saved);
  Reflect.set(PHASE_E_POLICY.seekerIsland,'totalSpots',current.totalSpots+1);
  Reflect.set(PHASE_E_POLICY.seekerIsland,'operatingTermSec',current.operatingTermSec+1);
  expect(parseExpeditionTermSnapshot(saved.snapshot)).toEqual(saved.snapshot);
  expect((await readStoredExpeditionTerm(db,saved.snapshot.termId,saved.termHash))?.hash).toBe(saved.termHash);
  expect((await pin(later)).hash).toBe(later.termHash);
  await expect(operating(fixture())).rejects.toThrow('current');
  expect(parseExpeditionTermObservation({snapshot:saved.snapshot,finality:{...saved.finality,observedAt:saved.completedAt}},iso(2000)).snapshot).toEqual(saved.snapshot);
 });
});

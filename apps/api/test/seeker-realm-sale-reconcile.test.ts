/** Real durable consent plus encoded finalized quote fixtures; no public relay. */
import {randomUUID} from 'node:crypto';
import {Keypair,Message,VersionedTransaction} from '@solana/web3.js';
import {afterAll,afterEach,describe,expect,it,vi} from 'vitest';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {connectTestDb} from './helpers';
import {createRealmSalePreparer} from '../src/seeker/realmSalePreparation';
import {acceptRealmSaleSigned,getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
import {createRealmSaleReconciler,type RealmSaleTransport} from '../src/seeker/realmSaleReconcile';
import {createRealmSaleSettlement} from '../src/seeker/realmSaleSettlement';
import * as receipts from '../src/seeker/realmSaleSettlement';
import {retainRealmSaleSettlementFixture} from './fixtures/realmSaleSettlement';
const conn=connectTestDb(),db=conn.db;
afterAll(()=>conn.sql.end());afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function fixture(){
 vi.stubEnv('PHASE_E_SEEKER_ENABLED','true');const f=await realmSaleQuoteFixture(),admission={connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'relay-r1'}};
 const key={wallet:f.buyer.toBase58(),idempotencyKey:randomUUID()},p=await createRealmSalePreparer(db,admission).prepare(key.wallet,{idempotencyKey:key.idempotencyKey,spot:0,realm:0});
 const tx=new VersionedTransaction(Message.from(Buffer.from(p.quote.messageHex,'hex')));tx.sign([Keypair.fromSeed(Buffer.alloc(32,1))]);const bytes=Uint8Array.from(tx.serialize()),wire=await acceptRealmSaleSigned(db,{...key,signedTransaction:bytes});
 const sends:Array<{bytes:Uint8Array;options:unknown}>=[];let status:unknown={context:{slot:f.controls.slot},value:[null]};
 const rpc:RealmSaleTransport={getGenesisHash:async()=>f.controls.genesisHash,getSignatureStatuses:async()=>status,getBlockHeight:async()=>f.controls.blockHeight,
  sendRawTransaction:async(b,options)=>{sends.push({bytes:Uint8Array.from(b),options});return wire.signature;}};
 const sources={admission,transport:()=>rpc};return {f,key,p,wire,bytes,sends,rpc,sources,setStatus:(value:unknown)=>{status=value;}};
}
describe('saved realm purchase delivery',()=>{
 it('sends only the saved packet with finalized preflight; an acknowledgement is not success',async()=>{
  const x=await fixture(),step=createRealmSaleReconciler(db,x.sources);x.f.controls.now+=1n;x.f.controls.slot++;
  const result=await step(x.key);expect(result).toEqual({status:'submitted',...x.key,signature:x.wire.signature,wireSha256:x.wire.wireSha256,purchaseFinalized:false});
  expect(x.sends).toEqual([{bytes:x.bytes,options:{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:x.f.controls.slot}}]);
  expect((await getRealmSaleSigned(db,x.key))?.wire).toEqual(x.wire);expect(await receipts.getRealmSaleSettlement(db,x.key)).toBeNull();
  await step(x.key);expect(x.sends).toHaveLength(2);expect(x.sends[1]!.bytes).toEqual(x.bytes);
 });
 it('deduplicates concurrent calls and retains the original identity during uncertain send',async()=>{
  const x=await fixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});x.rpc.sendRawTransaction=async(b,o)=>{x.sends.push({bytes:Uint8Array.from(b),options:o});entered();await new Promise<void>(r=>{release=r;});throw Error('ack lost');};
  const step=createRealmSaleReconciler(db,x.sources),first=step(x.key);expect(step(x.key)).toBe(first);await ready;release();expect(await first).toMatchObject({status:'held',reason:'SEND_UNCERTAIN',signature:x.wire.signature});expect(x.sends).toHaveLength(1);expect((await getRealmSaleSigned(db,x.key))?.wire).toEqual(x.wire);
 });
 it.each(['wrong-ack','throw'] as const)('retains consent on %s',async kind=>{const x=await fixture();x.rpc.sendRawTransaction=async()=>{if(kind==='throw')throw Error('lost');return 'wrong';};expect(await createRealmSaleReconciler(db,x.sources)(x.key)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN',signature:x.wire.signature});expect((await getRealmSaleSigned(db,x.key))?.wire).toEqual(x.wire);});
 it.each(['processed','confirmed','finalized','failed'] as const)('holds observed %s until separate exact owner proof',async kind=>{
  const x=await fixture();x.setStatus({context:{slot:x.f.controls.slot},value:[{slot:x.f.controls.slot,confirmations:kind==='finalized'||kind==='failed'?null:1,confirmationStatus:kind==='failed'?'finalized':kind,err:kind==='failed'?{InstructionError:[0,'Custom']}:null}]});
  expect(await createRealmSaleReconciler(db,x.sources)(x.key)).toMatchObject({status:'held',reason:kind==='failed'?'FINALIZED_ERROR_UNVERIFIED':'OBSERVED_TRANSACTION',signature:x.wire.signature});expect(x.sends).toHaveLength(0);expect(await receipts.getRealmSaleSettlement(db,x.key)).toBeNull();
 });
 it.each(['old-bank','bad-shape','wrong-genesis','expired'] as const)('holds transport %s without releasing the journal',async kind=>{
  const x=await fixture();if(kind==='old-bank')x.setStatus({context:{slot:x.p.source.admissionSlot-1},value:[null]});if(kind==='bad-shape')x.setStatus({context:{slot:x.f.controls.slot},value:[]});if(kind==='wrong-genesis')x.rpc.getGenesisHash=async()=>x.f.seller.toBase58();if(kind==='expired')x.rpc.getBlockHeight=async()=>x.p.quote.lastValidBlockHeight+1;
  expect(await createRealmSaleReconciler(db,x.sources)(x.key)).toMatchObject({status:'held',reason:kind==='wrong-genesis'?'IDENTITY':kind==='expired'?'EXPIRED_UNRESOLVED':'TRANSPORT_UNAVAILABLE'});expect(x.sends).toHaveLength(0);expect((await getRealmSaleSigned(db,x.key))?.wire).toEqual(x.wire);
 });
 it.each(['pause','coverage','fee','clock','revision'] as const)('holds changed admission %s',async kind=>{
  const x=await fixture();if(kind==='pause')vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');if(kind==='coverage'){x.f.models.access.expires_at=x.f.controls.now+1n;await x.f.repack();}if(kind==='fee')x.f.controls.fee=Number(x.p.quote.feeLamports)+1;if(kind==='clock')x.f.controls.now=BigInt(x.p.terms.validUntil)+1n;if(kind==='revision')x.sources.admission.policy.revision='changed';
  expect(await createRealmSaleReconciler(db,x.sources)(x.key)).toMatchObject({status:'held',reason:kind==='pause'?'PAUSED':'ADMISSION_HELD'});expect(x.sends).toHaveLength(0);
 });
 it('checks pause again after successful admission and before delivery',async()=>{
  const x=await fixture();let n=0;const genesis=x.rpc.getGenesisHash;x.rpc.getGenesisHash=async()=>{if(++n===3)vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');return genesis();};expect(await createRealmSaleReconciler(db,x.sources)(x.key)).toMatchObject({status:'held',reason:'PAUSED'});expect(x.sends).toHaveLength(0);
 });
 it('does not send on receipt lookup failure or accept an injected owner writer',async()=>{
  const x=await fixture();expect(()=>createRealmSaleReconciler(db,{...x.sources,settlement:{}} as never)).toThrow();vi.spyOn(receipts,'getRealmSaleSettlement').mockRejectedValueOnce(Error('db unavailable'));
  expect(await createRealmSaleReconciler(db,x.sources)(x.key)).toMatchObject({status:'held',reason:'SETTLEMENT_HELD'});expect(x.sends).toHaveLength(0);
 });
 it('recovers finalized success before paused or unavailable providers',async()=>{
  const x=await fixture(),s=await retainRealmSaleSettlementFixture(db),settlement=await createRealmSaleSettlement(db,{connect:()=>s.chain.rpc,trust:s.chain.trust})(s.key);vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  const result=await createRealmSaleReconciler(db,{admission:x.sources.admission,transport:()=>{throw Error('offline');}})(s.key);expect(result).toEqual({status:'settled',...s.key,signature:settlement.signature,settlement});
 });
 it('rejects foreign actors, unknown keys and caller authority without transport',async()=>{
  const x=await fixture(),step=createRealmSaleReconciler(db,x.sources);expect(await step({...x.key,relayAuthorized:true} as never)).toMatchObject({reason:'INVALID_INPUT'});expect(await step({...x.key,wallet:x.f.seller.toBase58()})).toMatchObject({reason:'NOT_SIGNED'});expect(await step({...x.key,idempotencyKey:randomUUID()})).toMatchObject({reason:'NOT_SIGNED'});expect(x.sends).toHaveLength(0);
 });
 it('keeps a timed-out flight until an abort-ignoring transport settles and never sends late',async()=>{
  const x=await fixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});x.rpc.getSignatureStatuses=()=>new Promise(resolve=>{entered();release=()=>resolve({context:{slot:x.f.controls.slot},value:[null]});});
  const step=createRealmSaleReconciler(db,{...x.sources,timeoutMs:500}),first=step(x.key);await ready;expect(await first).toMatchObject({reason:'TIMEOUT'});expect(step(x.key)).toBe(first);release();await tick();expect(x.sends).toHaveLength(0);expect((await getRealmSaleSigned(db,x.key))?.wire).toEqual(x.wire);
 });
 it('retains a nested admission flight after its shorter deadline until raw RPC settles',async()=>{
  const x=await fixture();let release!:()=>void,entered!:()=>void;const ready=new Promise<void>(r=>{entered=r;});x.f.rpc.getGenesisHash=()=>new Promise(resolve=>{entered();release=()=>resolve(x.f.controls.genesisHash);});
  const step=createRealmSaleReconciler(db,{...x.sources,admission:{...x.sources.admission,timeoutMs:50},timeoutMs:1000}),first=step(x.key);await ready;expect(await first).toMatchObject({reason:'ADMISSION_HELD'});expect(step(x.key)).toBe(first);release();await tick();expect(x.sends).toHaveLength(0);
 });
 it('bounds unresolved requests across wallets and rejects oversized wallet text before decoding',async()=>{
  const x=await fixture(),releases:Array<()=>void>=[];vi.spyOn(receipts,'getRealmSaleSettlement').mockImplementation(()=>new Promise(resolve=>{releases.push(()=>resolve(null));}));
  const step=createRealmSaleReconciler(db,{...x.sources,timeoutMs:50}),results=Array.from({length:32},()=>step({...x.key,idempotencyKey:randomUUID()}));
  expect((await Promise.all(results)).every(r=>r.status==='held'&&r.reason==='TIMEOUT')).toBe(true);expect(await step(x.key)).toMatchObject({reason:'BUSY'});
  expect(await step({...x.key,wallet:'1'.repeat(10000)})).toMatchObject({reason:'INVALID_INPUT'});for(const release of releases)release();await tick();expect(x.sends).toHaveLength(0);
 });
});

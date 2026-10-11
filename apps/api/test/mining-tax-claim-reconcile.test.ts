/** Saved wallet packets, actual admission and independent owner settlement. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Db} from '../src/db/client';
import {getMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {createMiningTaxClaimSettlement,type MiningTaxClaimSettlement} from '../src/mining/taxClaimSettlement';
import * as receipts from '../src/mining/taxClaimSettlement';
import {createMiningTaxClaimReconciler,type MiningTaxClaimTransport} from '../src/mining/taxClaimReconcile';
import {withMiningTaxAdmissionFixture as fixture,type MiningTaxAdmissionFixture} from './fixtures/miningTaxAdmission';

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
const active=()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');};
const lookup=(f:MiningTaxAdmissionFixture)=>({wallet:f.wallet,idempotencyKey:f.key.idempotencyKey});
async function relayFixture(f:MiningTaxAdmissionFixture){
 active();const saved=(await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!,wires=saved.wires;
 const sends:Array<{bytes:Uint8Array;options:unknown}>=[],calls={connect:0,genesis:0,status:0,height:[] as unknown[]};
 let status:unknown={context:{slot:f.control.slot},value:[null]};
 const rpc:MiningTaxClaimTransport={getGenesisHash:async()=>{calls.genesis++;return f.record.artifact.source.genesisHash;},
  getSignatureStatuses:async()=>{calls.status++;return status;},getBlockHeight:async options=>{calls.height.push(options);return f.control.height;},
  sendRawTransaction:async(bytes,options)=>{sends.push({bytes:Uint8Array.from(bytes),options});return wires.find(w=>w.signedTransactionHex===Buffer.from(bytes).toString('hex'))!.signature;}};
 return {wires,sends,calls,rpc,setStatus:(value:unknown)=>{status=value;},sources:{admission:f.sources,transport:()=>{calls.connect++;return rpc;}}};
}
describe('saved original KEEP tax relay',()=>{
 it.each(['claim','combined','split'] as const)('submits only the exact %s packet with fresh finalized admission, never a payment assertion',mode=>fixture(async f=>{
  const x=await relayFixture(f),step=createMiningTaxClaimReconciler(f.conn.db,x.sources),wire=x.wires[0]!;
  expect(await step(f.key)).toEqual({...f.key,status:'submitted',signature:wire.signature,wireSha256:wire.wireSha256,claimFinalized:false});
  expect(x.sends).toEqual([{bytes:f.wire(),options:{skipPreflight:false,preflightCommitment:'finalized',maxRetries:0,minContextSlot:f.control.slot}}]);
  expect(x.calls.height).toEqual([{commitment:'finalized',minContextSlot:Math.max(f.record.artifact.source.snapshotSlot,f.record.artifact.source.blockhashSlot)},
   {commitment:'finalized',minContextSlot:f.control.slot}]);
  expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
  const reads=f.calls.connect;f.control.fee=Number(f.record.artifact.caps.maxFeeLamports)+1;
  expect(await step(f.key)).toMatchObject({status:'held',reason:'ADMISSION_HELD'});expect(f.calls.connect).toBeGreaterThan(reads);expect(x.sends).toHaveLength(1);
 },{mode}));
 it('allows delivery with SELECT-only runtime grants and has no owner writer capability',()=>fixture(async f=>{
  const x=await relayFixture(f),role=`tax_relay_${randomUUID().replaceAll('-','')}`;
  await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on all tables in schema public to ${role}`);
  try{await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await createMiningTaxClaimReconciler(tx as unknown as Db,x.sources)(f.key)).toMatchObject({status:'submitted'});});}
  finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
  expect(x.sends).toHaveLength(1);expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
  for(const extra of [{settlement:{}},{admit:async()=>({relayAuthorized:true})},{[Symbol('authority')]:true}])expect(()=>createMiningTaxClaimReconciler(f.conn.db,{...x.sources,...extra} as never)).toThrow();
 }));
 it('coalesces one pending delivery and retains the original packet after a lost acknowledgement',()=>fixture(async f=>{
  const x=await relayFixture(f);let release!:()=>void,entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  x.rpc.sendRawTransaction=async(bytes,options)=>{x.sends.push({bytes:Uint8Array.from(bytes),options});entered();await new Promise<void>(r=>{release=r;});throw Error('lost acknowledgement');};
  const step=createMiningTaxClaimReconciler(f.conn.db,x.sources),first=step(f.key);expect(step(f.key)).toBe(first);await began;release();
  expect(await first).toMatchObject({...f.key,status:'held',reason:'SEND_UNCERTAIN',signature:x.wires[0]!.signature});expect(x.sends).toHaveLength(1);
  expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toEqual(x.wires);
 }));
 it('does not interpret a different acknowledgement as delivery or finality',()=>fixture(async f=>{
  const x=await relayFixture(f);x.rpc.sendRawTransaction=async()=>Keypair.generate().publicKey.toBase58();
  expect(await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN',signature:x.wires[0]!.signature});
  expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
 }));
 it.each(['processed','confirmed','finalized','failed'] as const)('holds observed %s without inferring payment, absence or archival authority',kind=>fixture(async f=>{
  const x=await relayFixture(f);x.setStatus({context:{slot:f.control.slot},value:[{slot:f.control.slot,confirmations:kind==='finalized'||kind==='failed'?null:1,
   confirmationStatus:kind==='failed'?'finalized':kind,err:kind==='failed'?{InstructionError:[0,'Custom']}:null}]});
  expect(await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key)).toMatchObject({status:'held',reason:kind==='failed'?'FINALIZED_ERROR_UNVERIFIED':'OBSERVED_TRANSACTION'});
  expect(f.calls.connect).toBe(0);expect(x.sends).toHaveLength(0);expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
 }));
 it.each(['old-bank','bad-shape','bad-height','height-rollback','wrong-genesis','expired'] as const)('holds transport %s before admission',kind=>fixture(async f=>{
  const x=await relayFixture(f),a=f.record.artifact;
  if(kind==='old-bank')x.setStatus({context:{slot:Math.max(a.source.snapshotSlot,a.source.blockhashSlot)-1},value:[null]});
  if(kind==='bad-shape')x.setStatus({context:{slot:f.control.slot},value:[]});
  if(kind==='bad-height')x.rpc.getBlockHeight=async()=>Number.NaN;
  if(kind==='height-rollback')x.rpc.getBlockHeight=async()=>a.blockHeight-1;
  if(kind==='wrong-genesis')x.rpc.getGenesisHash=async()=>f.buyer;
  if(kind==='expired')x.rpc.getBlockHeight=async()=>a.lastValidBlockHeight+1;
  expect(await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key)).toMatchObject({status:'held',reason:kind==='wrong-genesis'?'IDENTITY':kind==='expired'?'EXPIRED_UNRESOLVED':'TRANSPORT_UNAVAILABLE'});
  expect(x.sends).toHaveLength(0);expect(f.calls.connect).toBe(0);
 }));
 it.each(['pause','expiry','height-rollback','height-expired','genesis'] as const)('checks final %s after fresh admission and the second receipt lookup',kind=>fixture(async f=>{
  const x=await relayFixture(f),genesis=x.rpc.getGenesisHash;let reads=0;
  x.rpc.getGenesisHash=async()=>{const result=await genesis();if(++reads===3){
   if(kind==='pause')vi.stubEnv('PHASE_E_MINING_ENABLED','false');if(kind==='expiry')f.control.now=new Date(f.record.artifact.expiresAt);if(kind==='genesis')return f.buyer;
  }return result;};
  let heights=0;const height=x.rpc.getBlockHeight;x.rpc.getBlockHeight=async options=>{const result=await height(options);return ++heights===2?kind==='height-rollback'?result-1:kind==='height-expired'?f.record.artifact.lastValidBlockHeight+1:result:result;};
  expect(await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key)).toMatchObject({status:'held',reason:kind==='pause'?'PAUSED':kind==='expiry'||kind==='height-expired'?'EXPIRED_UNRESOLVED':kind==='genesis'?'IDENTITY':'TRANSPORT_UNAVAILABLE'});
  expect(f.calls.connect).toBeGreaterThan(0);expect(x.sends).toHaveLength(0);
 }));
 it('requires owner-verified setup, then applies already-paid setup costs to the original whole-plan caps',()=>fixture(async f=>{
  const x=await relayFixture(f),step=createMiningTaxClaimReconciler(f.conn.db,x.sources),key={...f.key,ordinal:1};await f.stage('setup');
  expect(await step(key)).toMatchObject({status:'held',reason:'ADMISSION_HELD'});expect(x.sends).toHaveLength(0);
  const setup=await f.verifySetup(6);expect(setup.claimFinalized).toBe(false);
  expect(await step(key)).toMatchObject({status:'held',reason:'ADMISSION_HELD'});expect(x.sends).toHaveLength(0);
  f.control.fee=4;expect(await step(key)).toMatchObject({...key,status:'submitted',signature:x.wires[1]!.signature,claimFinalized:false});expect(x.sends.map(s=>s.bytes)).toEqual([f.wire(1)]);
 },{mode:'split'}));
 it('recovers setup without automatically delivering the following claim',()=>fixture(async f=>{
  const x=await relayFixture(f),setup=await f.verifySetup();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const result=await createMiningTaxClaimReconciler(f.conn.db,{...x.sources,transport:()=>{throw Error('provider unavailable');}})(f.key);
  expect(result).toEqual({...f.key,status:'setup',signature:x.wires[0]!.signature,settlement:setup,claimFinalized:false});expect(x.sends).toHaveLength(0);expect(f.calls.connect).toBe(0);
 },{mode:'split'}));
 it.each(['claim','split'] as const)('recovers finalized %s history before flags, expiry or either provider',mode=>fixture(async f=>{
  const x=await relayFixture(f);await f.stage('paid');const settled=await createMiningTaxClaimSettlement(f.conn.db,f.options)({...f.key,ordinal:mode==='split'?1:0});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');f.control.now=new Date(f.record.artifact.expiresAt);
  const step=createMiningTaxClaimReconciler(f.conn.db,{admission:{...f.sources,connect:()=>{throw Error('offline');}},transport:()=>{throw Error('offline');}});
  expect(await step(f.key)).toEqual({...f.key,status:'settled',signature:x.wires[0]!.signature,settlement:settled,claimFinalized:true});expect(x.sends).toHaveLength(0);
 },{mode}));
 it('suppresses delivery when the owner saves finality during admission',()=>fixture(async f=>{
  const x=await relayFixture(f),get=receipts.getMiningTaxClaimSettlement;let requestedReads=0,saved:MiningTaxClaimSettlement|undefined;
  vi.spyOn(receipts,'getMiningTaxClaimSettlement').mockImplementation(async(db,key)=>{
   if(key.ordinal===0&&++requestedReads===2){await f.stage('paid');saved=await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);}
   return get(db,key);
  });
  const result=await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key);expect(result).toMatchObject({status:'settled',settlement:saved});expect(x.sends).toHaveLength(0);expect(f.calls.connect).toBeGreaterThan(0);
 }));
 it('holds on either receipt-read failure instead of crossing an unaudited recovery boundary',()=>fixture(async f=>{
  const x=await relayFixture(f),get=receipts.getMiningTaxClaimSettlement;
  vi.spyOn(receipts,'getMiningTaxClaimSettlement').mockRejectedValueOnce(Error('read unavailable'));
  expect(await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key)).toMatchObject({reason:'SETTLEMENT_HELD'});expect(f.calls.connect).toBe(0);
  vi.restoreAllMocks();let reads=0;vi.spyOn(receipts,'getMiningTaxClaimSettlement').mockImplementation((db,key)=>key.ordinal===0&&++reads===2?Promise.reject(Error('late read unavailable')):get(db,key));
  expect(await createMiningTaxClaimReconciler(f.conn.db,x.sources)(f.key)).toMatchObject({reason:'SETTLEMENT_HELD'});expect(x.sends).toHaveLength(0);
 }));
 it('rejects foreign identity, unknown keys and caller authority without connecting',()=>fixture(async f=>{
  const x=await relayFixture(f),step=createMiningTaxClaimReconciler(f.conn.db,x.sources);
  for(const key of [{...f.key,wallet:f.buyer},{...f.key,idempotencyKey:randomUUID()},{...f.key,ordinal:1}])expect(await step(key)).toMatchObject({reason:'NOT_SIGNED'});
  for(const key of [{...f.key,relayAuthorized:true},{...f.key,[Symbol('authority')]:true},{...f.key,wallet:'1'.repeat(10_000)},{...f.key,ordinal:2}])expect(await step(key as never)).toMatchObject({reason:'INVALID_INPUT'});
  expect(x.calls.connect).toBe(0);expect(f.calls.connect).toBe(0);
 }));
 it('copies original request and source policy before any DB await',()=>fixture(async f=>{
  const x=await relayFixture(f),trust={mining:{...f.sources.trust.mining},seeker:{...f.sources.trust.seeker,deployment:{...f.sources.trust.seeker.deployment}}},sources={...x.sources,admission:{...f.sources,trust}};
  const step=createMiningTaxClaimReconciler(f.conn.db,sources);trust.mining.keepMint=Keypair.generate().publicKey;trust.seeker.deployment.programDataSha256='00'.repeat(32);sources.admission.connect=()=>{throw Error('replaced');};sources.transport=()=>{throw Error('replaced');};
  const key={...f.key},pending=step(key);key.wallet=f.buyer;key.ordinal=1;expect(await pending).toMatchObject({...f.key,status:'submitted'});expect(x.sends[0]!.bytes).toEqual(f.wire());
 }));
 it('retains a timed-out send until its real promise drains without claiming late success',()=>fixture(async f=>{
  const x=await relayFixture(f);let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  x.rpc.sendRawTransaction=async(bytes,options)=>{x.sends.push({bytes:Uint8Array.from(bytes),options});entered();return new Promise<string>(r=>{release=()=>r(x.wires[0]!.signature);});};
  // The deadline must expire AFTER the real send enters. CPU/DB contention
  // before admission cannot turn this transport-drain test into a hanging wait.
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{
   const step=createMiningTaxClaimReconciler(f.conn.db,{...x.sources,timeoutMs:1000}),first=step(f.key);
   await Promise.race([began,first.then(result=>{throw Error(`Send did not enter: ${JSON.stringify(result)}`);})]);
   await vi.advanceTimersByTimeAsync(1000);expect(await first).toMatchObject({reason:'TIMEOUT'});expect(step(f.key)).toBe(first);
   release();await vi.advanceTimersByTimeAsync(0);expect(await first).toMatchObject({reason:'TIMEOUT'});
   expect(x.sends).toHaveLength(1);expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
  }finally{release?.();vi.useRealTimers();}
 }));
 it('retains a shorter nested admission timeout until the underlying RPC drains',()=>fixture(async f=>{
  const x=await relayFixture(f);let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{entered();release=()=>resolve(f.record.artifact.source.genesisHash);});
  const step=createMiningTaxClaimReconciler(f.conn.db,{...x.sources,admission:{...f.sources,timeoutMs:200},timeoutMs:2000}),first=step(f.key);await began;
  expect(await first).toMatchObject({reason:'ADMISSION_HELD'});expect(step(f.key)).toBe(first);release();await tick();expect(x.sends).toHaveLength(0);
 }));
 it('retains all 32 concrete transport calls after timeout until their actual drain',()=>fixture(async f=>{
  const x=await relayFixture(f),keys=[f.key];for(let i=1;i<32;i++)keys.push(await f.forkClaim());const extra=await f.forkClaim();
  const releases:Array<()=>void>=[];let entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  x.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{releases.push(()=>resolve(f.record.artifact.source.genesisHash));if(releases.length===32)entered();});
  const step=createMiningTaxClaimReconciler(f.conn.db,{...x.sources,timeoutMs:5000}),pending=keys.map(key=>step(key)),all=Promise.all(pending);
  try{await Promise.race([began,all.then(()=>{if(releases.length!==32)throw Error(`Only ${releases.length}/32 concrete transport calls entered`);})]);
   expect((await all).every(r=>r.status==='held'&&r.reason==='TIMEOUT')).toBe(true);expect(step(keys[0]!)).toBe(pending[0]);expect(await step(extra)).toMatchObject({reason:'BUSY'});expect(releases).toHaveLength(32);
  }finally{for(const release of releases)release();await tick();}
  expect(x.sends).toHaveLength(0);vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect(await step(extra)).toMatchObject({reason:'PAUSED'});
 }),30_000);
});

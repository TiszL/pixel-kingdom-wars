/** Actual original-term quote adapters + isolated immutable SQL, never live RPC. */
import {randomUUID} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createDb,type Db,type DbTx} from '../src/db/client';
import {createMiningTaxClaimPreparer} from '../src/mining/taxClaimPreparation';
import {getMiningTaxClaimPreparation} from '../src/mining/taxClaimPreparationStore';
import {withMiningTaxPreparationFixture as fixture} from './fixtures/miningTaxPreparation';
const now=new Date('2035-01-01T00:00:00.000Z'),tick=()=>new Promise(resolve=>setTimeout(resolve,20));
type Fixture=Parameters<Parameters<typeof fixture>[0]>[0];
const sources=(f:Fixture)=>({connect:()=>f.rpc,trust:f.trust,now:()=>now});
afterEach(()=>vi.unstubAllEnvs());
function duringInsert(db:Db,after:()=>Promise<void>):Db{
 const transaction=db.transaction.bind(db),dialect=new PgDialect();
 return new Proxy(db,{get(target,name,receiver){if(name!=='transaction')return Reflect.get(target,name,receiver);
  return (run:(tx:DbTx)=>Promise<unknown>)=>transaction(tx=>run(new Proxy(tx,{get(t,p,r){if(p!=='execute')return Reflect.get(t,p,r);
   return async(...args:Parameters<DbTx['execute']>)=>{const result=await tx.execute(...args);
    if(/insert into mining_tax_claim_preparations/i.test(typeof args[0]==='string'?args[0]:dialect.sqlToQuery(args[0].getSQL()).sql))await after();return result;};
  }})));
 }});
}
// Control only the explicitly injected service/reader deadline. PostgreSQL's
// unrelated connection timers keep running while the test reaches its barrier.
function controlledDeadline(delay:number){
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,timers=new Map<ReturnType<typeof setTimeout>,()=>void>();
 const set=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:(...args:unknown[])=>void,ms?:number,...args:unknown[])=>{
  if(ms!==delay)return realSet(callback,ms,...args);
  const timer=realSet(()=>{},2_147_483_647);timer.unref();timers.set(timer,()=>callback(...args));return timer;
 }) as typeof globalThis.setTimeout);
 const clear=vi.spyOn(globalThis,'clearTimeout').mockImplementation(timer=>{timers.delete(timer as ReturnType<typeof setTimeout>);realClear(timer);});
 return {fire(){for(const [timer,callback] of [...timers]){if(!timers.has(timer))continue;timers.delete(timer);realClear(timer);callback();}},restore(){for(const timer of timers.keys())realClear(timer);clear.mockRestore();set.mockRestore();}};
}
describe('original spot KEEP tax preparation service',()=>{
 it('prepares expired original winner rights with sales disabled and recovers the same artifact after pause/provider loss',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  const service=createMiningTaxClaimPreparer(f.conn.db,sources(f)),a=await service.prepare(f.wallet,f.request);
  expect(a).toMatchObject({wallet:f.wallet,round:f.request.round,spot:f.request.spot,caps:f.request.caps,currentSigningAuthorized:false,submissionAuthorized:false});
  expect(BigInt(a.snapshot.unixTimestamp)).toBeGreaterThan(BigInt(a.term.operatingEnd));expect(a.identity.originalWinner).toBe(f.wallet);
  expect(Object.isFrozen(a)).toBe(true);expect(Object.isFrozen(a.transactions[0])).toBe(true);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const conn=createDb(f.url.toString());
  try{const recovered=createMiningTaxClaimPreparer(conn.db,{...sources(f),now:()=>new Date('2040-01-01T00:00:00.000Z'),connect:()=>{throw Error('offline');}});
   expect(await recovered.prepare(f.wallet,f.request)).toEqual(a);expect(await recovered.get(f.wallet,f.request.idempotencyKey)).toEqual(a);
   expect(await recovered.get(f.buyer,f.request.idempotencyKey)).toBeNull();
   await expect(recovered.prepare(f.wallet,{...f.request,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'DISABLED'});
  }finally{await conn.sql.end();}
 }));
 it('coalesces identical concurrent requests but rejects changed original round, spot or any cap while pending and saved',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');let connects=0;
  const service=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),connect:()=>{connects++;return f.rpc;}});
  const first=service.prepare(f.wallet,f.request),second=service.prepare(f.wallet,structuredClone(f.request));
  const changed=[{...f.request,round:'1'},{...f.request,spot:20},...Object.keys(f.request.caps).map(k=>({...f.request,caps:{...f.request.caps,[k]:'1'}}))];
  for(const value of changed)await expect(service.prepare(f.wallet,value)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  expect(await first).toEqual(await second);expect(connects).toBe(1);
  for(const value of changed)await expect(service.prepare(f.wallet,value)).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  expect(connects).toBe(1);expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(1);
 }));
 it('keeps the first immutable artifact across independent concurrent service instances',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');
  const [a,b]=await Promise.all([createMiningTaxClaimPreparer(f.conn.db,sources(f)).prepare(f.wallet,f.request),createMiningTaxClaimPreparer(f.conn.db,sources(f)).prepare(f.wallet,f.request)]);
  expect(a).toEqual(b);expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(1);
 }));
 it('copies request and server trust before any asynchronous recovery or RPC work',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const request=structuredClone(f.request),expected=structuredClone(request);
  const trust={mining:{...f.trust.mining},seeker:{...f.trust.seeker,deployment:{...f.trust.seeker.deployment}}};
  const service=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),trust});
  trust.mining.expectedGenesisHash=PublicKey.default.toBase58();trust.seeker.deployment.programDataSha256='00'.repeat(32);
  const pending=service.prepare(f.wallet,request);request.spot=21;request.round='1';request.caps.maxTotalLamports='0';
  expect(await pending).toMatchObject(expected);
 }));
 it('refuses unauthenticated actors, unknown request fields and malformed caps without RPC',async()=>fixture(async f=>{
  let reads=0;const service=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),connect:()=>{reads++;return f.rpc;}});
  for(const extra of [{wallet:f.buyer},{amount:'1'},{signature:'x'},{round:'01'},{spot:-1},{caps:{...f.request.caps,maxTotalLamports:'9'.repeat(10000)}},{[Symbol('extra')]:true}])await expect(service.prepare(f.wallet,{...f.request,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(service.prepare(PublicKey.default.toBase58(),f.request)).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(service.get(f.wallet,'bad-key')).rejects.toMatchObject({code:'INVALID_INPUT'});expect(reads).toBe(0);
  expect(()=>createMiningTaxClaimPreparer(f.conn.db,{...sources(f),timeoutMs:30001})).toThrow();
 }));
 it('checks mining admission before RPC and again after asynchronous fee work',async()=>fixture(async f=>{
  let connects=0;const service=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),connect:()=>{connects++;return f.rpc;}});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(service.prepare(f.wallet,f.request)).rejects.toMatchObject({code:'DISABLED'});expect(connects).toBe(0);
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const fee=f.rpc.getFeeForMessage.bind(f.rpc);f.rpc.getFeeForMessage=async(...args)=>{const v=await fee(...args);vi.stubEnv('PHASE_E_MINING_ENABLED','false');return v;};
  await expect(service.prepare(f.wallet,f.request)).rejects.toMatchObject({code:'DISABLED'});expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(0);
 }));
 it('does not persist a wrong original winner, insufficient SOL, or over-cap quote',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const service=createMiningTaxClaimPreparer(f.conn.db,sources(f));
  await expect(service.prepare(f.buyer,f.request)).rejects.toMatchObject({code:'QUOTE_UNAVAILABLE',reason:'NOT_WINNER'});
  await expect(service.prepare(f.wallet,{...f.request,caps:{...f.request.caps,maxFeeLamports:'1'}})).rejects.toMatchObject({code:'QUOTE_UNAVAILABLE',reason:'COST_CAP'});
  f.chain.store.get(f.wallet)!.lamports=1;
  await expect(service.prepare(f.wallet,f.request)).rejects.toMatchObject({code:'QUOTE_UNAVAILABLE',reason:'INSUFFICIENT_SOL'});
  expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(0);
 }));
 it('holds a timed-out original request and rejects changed input until its ignored RPC abort drains',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');let release!:(value:string)=>void,entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  f.rpc.getGenesisHash=()=>{entered();return new Promise(r=>{release=r;});};
  const service=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),timeoutMs:1000});
  const pending=service.prepare(f.wallet,f.request),rejected=expect(pending).rejects.toMatchObject({code:'TIMEOUT'});await began;await rejected;
  await expect(service.prepare(f.wallet,f.request)).rejects.toMatchObject({code:'TIMEOUT'});
  await expect(service.prepare(f.wallet,{...f.request,spot:20})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  release(f.trust.mining.expectedGenesisHash);await tick();expect(await service.get(f.wallet,f.request.idempotencyKey)).toBeNull();
 }));
 it('retains all32 request slots after nested timeout until every concrete transport promise settles',async()=>fixture(async f=>{
  // Start the deadline only after every concrete RPC has entered. Scheduler/DB
  // load must not turn this drain assertion into an unreachable entry barrier.
  const deadline=controlledDeadline(1234);
  try{
   vi.stubEnv('PHASE_E_MINING_ENABLED','true');const old=f.rpc.getGenesisHash.bind(f.rpc),releases:Array<()=>void>=[];let entered!:()=>void;
   const began=new Promise<void>(r=>{entered=r;});f.rpc.getGenesisHash=()=>new Promise<string>(r=>{releases.push(()=>r(f.trust.mining.expectedGenesisHash));if(releases.length===32)entered();});
   const service=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),timeoutMs:1234});
   const requests=Array.from({length:32},()=>({...f.request,idempotencyKey:randomUUID()}));
   const failures=requests.map(r=>service.prepare(f.wallet,r).then(()=>({code:'unexpected'}),error=>error));await began;
   deadline.fire();expect((await Promise.all(failures)).every(e=>e.code==='TIMEOUT')).toBe(true);
   await expect(service.prepare(f.wallet,{...f.request,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'BUSY'});
   for(const release of releases)release();f.rpc.getGenesisHash=old;await tick();
   expect(await service.prepare(f.wallet,f.request)).toMatchObject({wallet:f.wallet});expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(1);
  }finally{deadline.restore();}
 }));
 it('rolls back an INSERT when admission is paused during its SQL reply',async()=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','true');const db=duringInsert(f.conn.db,async()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','false');});
  await expect(createMiningTaxClaimPreparer(db,sources(f)).prepare(f.wallet,f.request)).rejects.toMatchObject({code:'DISABLED'});
  expect(await getMiningTaxClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:f.request.idempotencyKey})).toBeNull();
 }));
 it('rolls back an INSERT after timeout even when the already-executed SQL reply arrives late',async()=>fixture(async f=>{
  const deadline=controlledDeadline(1234);
  try{
   vi.stubEnv('PHASE_E_MINING_ENABLED','true');let release!:()=>void,entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
   const db=duringInsert(f.conn.db,()=>{entered();return new Promise<void>(r=>{release=r;});});
   const service=createMiningTaxClaimPreparer(db,{...sources(f),timeoutMs:1234});
   const pending=service.prepare(f.wallet,f.request),rejected=expect(pending).rejects.toMatchObject({code:'TIMEOUT'});await began;
   deadline.fire();await rejected;release();await tick();
   expect(await getMiningTaxClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:f.request.idempotencyKey})).toBeNull();
  }finally{deadline.restore();}
 }));
 it('recovers an immutable commit whose response arrived after the caller deadline',async()=>fixture(async f=>{
  const deadline=controlledDeadline(1234);
  try{
   vi.stubEnv('PHASE_E_MINING_ENABLED','true');let release!:()=>void,committed!:()=>void;const done=new Promise<void>(r=>{committed=r;}),transaction=f.conn.db.transaction.bind(f.conn.db);
   const db=new Proxy(f.conn.db,{get(target,p,r){if(p!=='transaction')return Reflect.get(target,p,r);return async(run:Parameters<Db['transaction']>[0])=>{const result=await transaction(run);committed();await new Promise<void>(resolve=>{release=resolve;});return result;};}});
   const service=createMiningTaxClaimPreparer(db,{...sources(f),timeoutMs:1234});const pending=service.prepare(f.wallet,f.request),rejected=expect(pending).rejects.toMatchObject({code:'TIMEOUT'});
   // Reach the actual committed response barrier before triggering its deadline.
   await done;deadline.fire();await rejected;const saved=await service.get(f.wallet,f.request.idempotencyKey);expect(saved).not.toBeNull();release();await tick();
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');const recovery=createMiningTaxClaimPreparer(f.conn.db,{...sources(f),connect:()=>{throw Error('offline');}});
   expect(await recovery.prepare(f.wallet,f.request)).toEqual(saved);
  }finally{deadline.restore();}
 }));
});

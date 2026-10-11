/** Real fixture DB plus actual encoded finalized-term/quote pairing. No public RPC. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import postgres from 'postgres';
import {describe,it,expect,afterEach,vi} from 'vitest';
import {PublicKey} from '@solana/web3.js';
import {realmSaleQuoteFixture} from '../../../packages/chain/src/seekerRealmSaleQuote.fixture';
import {createDb} from '../src/db/client';
import {ADMIN_DATABASE_URL} from './db-url';
import {createRealmSalePreparer,realmSalePreparationRequestSchema} from '../src/seeker/realmSalePreparation';
import {getRealmSalePreparation} from '../src/seeker/realmSalePreparationStore';
const flag=process.env['PHASE_E_SEEKER_ENABLED'];afterEach(()=>{if(flag===undefined)delete process.env['PHASE_E_SEEKER_ENABLED'];else process.env['PHASE_E_SEEKER_ENABLED']=flag;});
const tick=()=>new Promise(resolve=>setTimeout(resolve,10));
async function fixture(run:(conn:ReturnType<typeof createDb>,f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>,url:URL)=>Promise<void>){
 const name=`realm_service_${randomUUID().replaceAll('-','')}_test`,url=new URL(ADMIN_DATABASE_URL);url.pathname=`/${name}`;
 if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('unsafe test host');
 const admin=postgres(ADMIN_DATABASE_URL,{max:1,onnotice:()=>{}});await admin.unsafe(`create database ${name}`);const conn=createDb(url.toString(),{max:4});
 try{for(const statement of readFileSync(new URL('../drizzle/0182_seeker_realm_sale_preparations.sql',import.meta.url),'utf8').split('--> statement-breakpoint').filter(x=>x.trim()))await conn.sql.unsafe(statement);await run(conn,await realmSaleQuoteFixture(),url);}
 finally{await conn.sql.end();await admin.unsafe(`drop database ${name} with (force)`);await admin.end();}
}
const sources=(f:Awaited<ReturnType<typeof realmSaleQuoteFixture>>)=>({connect:()=>f.rpc,policy:{term:f.termPolicy,access:f.accessTrust,revision:'test-r1'}});
describe('actor-bound realm sale preparation service',()=>{
 it('pairs actual finalized term/quote encoding with durable exact actor/key recovery',async()=>fixture(async(conn,f,url)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';const service=createRealmSalePreparer(conn.db,sources(f)),request={idempotencyKey:randomUUID(),spot:0,realm:0};
  const a=await service.prepare(f.buyer.toBase58(),request);expect(a.wallet).toBe(f.buyer.toBase58());expect(a.saleId).toMatch(/^[a-f0-9]{32}$/);expect(a.currentSigningAuthorized).toBe(false);expect(a.submissionAuthorized).toBe(false);
  expect(a.quote.rents.map(r=>r.address)).toHaveLength(1);process.env['PHASE_E_SEEKER_ENABLED']='false';
  const reconnect=createDb(url.toString());try{const recovery=createRealmSalePreparer(reconnect.db,{...sources(f),connect:()=>{throw Error('offline');}});expect(await recovery.prepare(a.wallet,request)).toEqual(a);expect(await recovery.get(a.wallet,request.idempotencyKey)).toEqual(a);expect(await recovery.get(f.seller.toBase58(),request.idempotencyKey)).toBeNull();}finally{await reconnect.sql.end();}
 }));
 it('reorders rent facts by canonical builder addresses for missing access and quota',async()=>fixture(async(conn,f)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';f.store.delete(f.addresses.access.toBase58());f.store.delete(f.addresses.quota.toBase58());const service=createRealmSalePreparer(conn.db,sources(f));
  const a=await service.prepare(f.buyer.toBase58(),{idempotencyKey:randomUUID(),spot:0,realm:0});expect(a.quote.needsAccess&&a.quote.needsQuota).toBe(true);expect(a.quote.rents[0]!.address).toBe(f.addresses.access.toBase58());expect(a.quote.rents[1]!.address).toBe(f.addresses.quota.toBase58());expect(a.quote.rents).toHaveLength(3);
 }));
 it('deduplicates concurrent identical intent and rejects changed payload both pending and persisted',async()=>fixture(async(conn,f)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';let calls=0;const source=sources(f),service=createRealmSalePreparer(conn.db,{...source,connect:()=>{calls++;return f.rpc;}}),request={idempotencyKey:randomUUID(),spot:0,realm:0};
  const one=service.prepare(f.buyer.toBase58(),request),two=service.prepare(f.buyer.toBase58(),request);
  await expect(service.prepare(f.buyer.toBase58(),{...request,realm:1})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  expect(await one).toEqual(await two);const used=calls;await expect(service.prepare(f.buyer.toBase58(),{...request,spot:1})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});expect(calls).toBe(used);expect(await conn.sql`select * from seeker_realm_sale_preparations`).toHaveLength(1);
 }));
 it('refuses disabled admission before RPC and after asynchronous quote work',async()=>fixture(async(conn,f)=>{
  const service=createRealmSalePreparer(conn.db,sources(f)),request={idempotencyKey:randomUUID(),spot:0,realm:0};process.env['PHASE_E_SEEKER_ENABLED']='false';
  await expect(service.prepare(f.buyer.toBase58(),request)).rejects.toMatchObject({code:'DISABLED'});expect(f.reads).toHaveLength(0);
  process.env['PHASE_E_SEEKER_ENABLED']='true';f.controls.onFee=async()=>{process.env['PHASE_E_SEEKER_ENABLED']='false';};
  await expect(service.prepare(f.buyer.toBase58(),request)).rejects.toMatchObject({code:'DISABLED'});expect(await conn.sql`select * from seeker_realm_sale_preparations`).toHaveLength(0);
 }));
 it('rejects malformed requests, caller sale IDs/recipients and unbound actors without RPC',async()=>fixture(async(conn,f)=>{
  const service=createRealmSalePreparer(conn.db,sources(f)),request={idempotencyKey:randomUUID(),spot:0,realm:0};
  for(const patch of [{saleId:'ab'.repeat(16)},{seller:f.seller.toBase58()},{wallet:f.seller.toBase58()},{spot:100},{realm:-1},{idempotencyKey:'x'},{[Symbol('private')]:1}])await expect(service.prepare(f.buyer.toBase58(),{...request,...patch})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(service.prepare(PublicKey.default.toBase58(),request)).rejects.toMatchObject({code:'INVALID_INPUT'});expect(f.reads).toHaveLength(0);expect(realmSalePreparationRequestSchema.safeParse({...request,price:1}).success).toBe(false);
 }));
 it('never persists failed current-term or insufficient-balance quotes',async()=>fixture(async(conn,f)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';const service=createRealmSalePreparer(conn.db,sources(f));f.controls.balance=1;
  await expect(service.prepare(f.buyer.toBase58(),{idempotencyKey:randomUUID(),spot:0,realm:0})).rejects.toMatchObject({code:'QUOTE_UNAVAILABLE',reason:'INSUFFICIENT_SOL'});
  expect(await conn.sql`select * from seeker_realm_sale_preparations`).toHaveLength(0);
 }));
 it('times out ignored aborts, preserves the in-flight conflict fence and prevents late persistence',async()=>fixture(async(conn,f)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';let release:(()=>void)|undefined;const entered=new Promise<void>(resolve=>{f.controls.onFee=()=>{resolve();return new Promise<void>(r=>{release=r;});};});
  const service=createRealmSalePreparer(conn.db,{...sources(f),timeoutMs:1000}),request={idempotencyKey:randomUUID(),spot:0,realm:0};const pending=service.prepare(f.buyer.toBase58(),request);const rejected=expect(pending).rejects.toMatchObject({code:'TIMEOUT'});
  await entered;await rejected;await expect(service.prepare(f.buyer.toBase58(),{...request,realm:1})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  await expect(service.prepare(f.buyer.toBase58(),request)).rejects.toMatchObject({code:'TIMEOUT'});release!();await tick();expect(await getRealmSalePreparation(conn.db,{wallet:f.buyer.toBase58(),idempotencyKey:request.idempotencyKey})).toBeNull();
 }));
 it('retains all 32 capacity fences after nested deadlines while underlying RPC ignores abort',async()=>fixture(async(conn,f)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';const genesis=f.rpc.getGenesisHash.bind(f.rpc),releases:Array<()=>void>=[];let started=0,allStarted!:()=>void;
  const entered=new Promise<void>(resolve=>{allStarted=resolve;});f.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{releases.push(()=>resolve(f.controls.genesisHash));if(++started===32)allStarted();});
  // A busy database must not expire one request before all 32 reach the held
  // RPC. Control only these 1s deadlines; Postgres I/O and other timers stay real.
  const schedule=globalThis.setTimeout,deadlines=new Map<ReturnType<typeof setTimeout>,()=>void>();
  const timer=vi.spyOn(globalThis,'setTimeout').mockImplementation(((...args:Parameters<typeof setTimeout>)=>{
   const [callback,delay,...values]=args;if(delay!==1000)return schedule(callback,delay,...values);
   const handle=schedule(()=>undefined,delay);deadlines.set(handle,()=>callback(...values));return handle;
  }) as typeof setTimeout);
  try{
   const service=createRealmSalePreparer(conn.db,{...sources(f),timeoutMs:1000}),requests=Array.from({length:32},()=>({idempotencyKey:randomUUID(),spot:0,realm:0}));
   const results=requests.map(request=>service.prepare(f.buyer.toBase58(),request).then(()=>({code:'unexpected'}),error=>error));
   await entered;timer.mockRestore();
   // Expire every outer and nested deadline before checking capacity. A settled
   // quote promise must not free its still-unsettled concrete RPC work.
   for(const [handle,expire] of deadlines){clearTimeout(handle);expire();}
   expect((await Promise.all(results)).every(error=>error.code==='TIMEOUT')).toBe(true);
   await tick();
   await expect(service.prepare(f.buyer.toBase58(),{idempotencyKey:randomUUID(),spot:0,realm:0})).rejects.toMatchObject({code:'BUSY'});
   await expect(service.prepare(f.buyer.toBase58(),{...requests[0]!,realm:1})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
   for(const release of releases)release();f.rpc.getGenesisHash=genesis;await tick();
   expect(await conn.sql`select * from seeker_realm_sale_preparations`).toHaveLength(0);
   expect((await service.prepare(f.buyer.toBase58(),requests[0])).state).toBe('prepared');
  }finally{timer.mockRestore();for(const handle of deadlines.keys())clearTimeout(handle);for(const release of releases)release();f.rpc.getGenesisHash=genesis;}
 }));
 it('rolls back admission lost during the store read/write awaits',async()=>fixture(async(conn,f)=>{
  process.env['PHASE_E_SEEKER_ENABLED']='true';const actual=conn.db.transaction.bind(conn.db);const db=new Proxy(conn.db,{get(target,prop){if(prop!=='transaction')return Reflect.get(target,prop);return (run:(tx:unknown)=>Promise<unknown>)=>actual(async tx=>{let reads=0;const facade=new Proxy(tx,{get(t,p){if(p!=='execute')return Reflect.get(t,p);return async(...args:Parameters<typeof tx.execute>)=>{const result=await tx.execute(...args);if(++reads===2)process.env['PHASE_E_SEEKER_ENABLED']='false';return result;};}});return run(facade);});}});
  const service=createRealmSalePreparer(db,sources(f));await expect(service.prepare(f.buyer.toBase58(),{idempotencyKey:randomUUID(),spot:0,realm:0})).rejects.toMatchObject({code:'DISABLED'});expect(await conn.sql`select * from seeker_realm_sale_preparations`).toHaveLength(0);
 }));
});

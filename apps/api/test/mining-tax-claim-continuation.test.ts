import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createDb,type Db,type DbTx} from '../src/db/client';
import {createMiningTaxClaimContinuation,getMiningTaxClaimContinuation} from '../src/mining/taxClaimContinuation';
import {acceptMiningTaxClaimSigned,getMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {createMiningTaxClaimSettlement} from '../src/mining/taxClaimSettlement';
import {createMiningTaxClaimPreparationRecord,saveMiningTaxClaimPreparation} from '../src/mining/taxClaimPreparationStore';
import {createMiningTaxClaimAdmission,createMiningTaxClaimReview} from '../src/mining/taxClaimAdmission';
import {createMiningTaxClaimReconciler} from '../src/mining/taxClaimReconcile';
import {withMiningTaxContinuationFixture as fixture,continuationMigration} from './fixtures/miningTaxContinuation';
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
type F=Parameters<Parameters<typeof fixture>[0]>[0];
const active=()=>vi.stubEnv('PHASE_E_MINING_ENABLED','true');
const lookup=(f:F)=>({wallet:f.wallet,idempotencyKey:f.parentKey});
const prepare=(f:F,db=f.conn.db,request=f.request)=>createMiningTaxClaimContinuation(db,f.sources).prepare(f.wallet,f.parentKey,request);
function afterQuery(db:Db,pattern:RegExp,after:()=>Promise<void>):Db{
 const transaction=db.transaction.bind(db),dialect=new PgDialect();return new Proxy(db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return (run:(tx:DbTx)=>Promise<unknown>)=>transaction(tx=>run(new Proxy(tx,{get(o,k,z){if(k!=='execute')return Reflect.get(o,k,z);return async(query:Parameters<DbTx['execute']>[0])=>{const result=await tx.execute(query);if(pattern.test(typeof query==='string'?query:dialect.sqlToQuery(query.getSQL()).sql))await after();return result;};}})));}});
}
async function wire(f:F,db=f.conn.db){return db.transaction(tx=>acceptMiningTaxClaimSigned(tx,{...lookup(f),signedTransaction:f.wire(1)}));}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
function controlledDeadline(delay:number){
 const realSet=globalThis.setTimeout,realClear=globalThis.clearTimeout,timers=new Map<ReturnType<typeof setTimeout>,()=>void>();
 const set=vi.spyOn(globalThis,'setTimeout').mockImplementation(((callback:(...args:unknown[])=>void,ms?:number,...args:unknown[])=>{if(ms!==delay)return realSet(callback,ms,...args);const timer=realSet(()=>{},2_147_483_647);timer.unref();timers.set(timer,()=>callback(...args));return timer;}) as typeof globalThis.setTimeout);
 const clear=vi.spyOn(globalThis,'clearTimeout').mockImplementation(timer=>{timers.delete(timer as ReturnType<typeof setTimeout>);realClear(timer);});
 return {fire(){for(const [timer,callback] of [...timers]){if(!timers.has(timer))continue;timers.delete(timer);realClear(timer);callback();}},restore(){for(const timer of timers.keys())realClear(timer);clear.mockRestore();set.mockRestore();}};
}
describe('immutable split tax continuation',()=>{
 it('binds fresh additional caps and post-expiry bank while preserving paid setup history',()=>fixture(async f=>{
  active();const calls:string[]=[],height=f.rpc.getBlockHeight,slot=f.rpc.getSlot;f.rpc.getBlockHeight=async(...a)=>{calls.push('height');return height(...a);};f.rpc.getSlot=async(...a)=>{calls.push('slot');return slot(...a);};
  const saved=await prepare(f);expect(calls.indexOf('height')).toBeLessThan(calls.indexOf('slot'));
  expect(saved).toMatchObject({version:1,wallet:f.wallet,parentIdempotencyKey:f.parentKey,parentSetup:f.setup,childPreparation:{idempotencyKey:f.request.idempotencyKey,caps:f.request.caps,fees:{feeLamports:'5',rentLamports:'0'},currentSigningAuthorized:false,submissionAuthorized:false},expiry:{blockHeight:f.control.height,slot:f.control.slot},currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false,journalClearingAuthorized:false});
  expect(saved.childPreparation.blockhash).not.toBe(f.record.artifact.blockhash);expect(saved.childPreparation.transactions).toHaveLength(1);expect(saved.parentSetup.receipt.feeLamports).toBe('6');expect(saved.parentSetup.receipt.rentLamports).toBe('1000');
  expect(await getMiningTaxClaimContinuation(f.conn.db,lookup(f))).toEqual(saved);expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(1);
 }));
 it('recovers only the same child key and caps while paused/providerless, including later custody',()=>fixture(async f=>{
  active();const a=await prepare(f);await wire(f);vi.stubEnv('PHASE_E_MINING_ENABLED','false');const c=createDb(f.url.toString());try{const service=createMiningTaxClaimContinuation(c.db,{...f.sources,connect:()=>{throw Error('offline');}});
   expect(await service.prepare(f.wallet,f.parentKey,f.request)).toEqual(a);expect(await getMiningTaxClaimContinuation(c.db,lookup(f))).toEqual(a);
   for(const change of [{idempotencyKey:randomUUID()},{caps:{...f.request.caps,maxFeeLamports:'9'}}])await expect(service.prepare(f.wallet,f.parentKey,{...f.request,...change})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  }finally{await c.sql.end();}
 }));
 it('serializes independent competing children and never leaves the losing preparation behind',()=>fixture(async f=>{
  active();const b={...f.request,idempotencyKey:randomUUID()},results=await Promise.allSettled([prepare(f),prepare(f,f.conn.db,b)]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(2);expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(1);
 }));
 it('refuses a foreign parent or an already signed remainder before RPC',()=>fixture(async f=>{
  active();const service=createMiningTaxClaimContinuation(f.conn.db,f.sources),before=f.calls.connect;await expect(service.prepare(f.buyer,f.parentKey,f.request)).rejects.toMatchObject({code:'NOT_PREPARED'});await wire(f);await expect(prepare(f)).rejects.toMatchObject({code:'PARENT_SIGNED'});expect(f.calls.connect).toBe(before);
 }));
 it.each(['height-unexpired','same-blockhash','old-bank','first-bank-old','height-regression','wrong-genesis'] as const)('holds %s instead of treating a late height as a fresh bank',kind=>fixture(async f=>{
  active();if(kind==='height-unexpired')f.control.height=f.record.artifact.lastValidBlockHeight;if(kind==='same-blockhash')f.control.blockhash=f.record.artifact.blockhash;
  if(kind==='wrong-genesis')f.rpc.getGenesisHash=async()=>f.buyer;
  if(kind==='old-bank'||kind==='first-bank-old'){const get=f.rpc.getSlot;let reads=0;f.rpc.getSlot=async(...a)=>{const value=await get(...a);return ++reads===1?value+1:value;};}
  // Only the first quote bank predates expiry; a fresh second bank cannot repair it.
  if(kind==='first-bank-old'){const get=f.rpc.getLatestBlockhashAndContext;f.rpc.getLatestBlockhashAndContext=async(...a)=>{f.control.slot++;return get(...a);};}
  if(kind==='height-regression'){let reads=0;f.rpc.getBlockHeight=async()=>++reads===1?f.control.height+1:f.control.height;}
  await expect(prepare(f)).rejects.toThrow();expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(0);expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(1);
 }));
 it('rejects caller authority, reused parent key and pending changed caps without RPC authority',()=>fixture(async f=>{
  active();const service=createMiningTaxClaimContinuation(f.conn.db,f.sources);for(const extra of [{wallet:f.buyer},{expiryHeight:999},{setupReceipt:{}},{[Symbol('authority')]:true},{idempotencyKey:f.parentKey}])await expect(service.prepare(f.wallet,f.parentKey,{...f.request,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>{entered=r;}),get=f.rpc.getGenesisHash;f.rpc.getGenesisHash=async()=>{entered();await new Promise<void>(r=>{release=r;});return get();};const first=service.prepare(f.wallet,f.parentKey,f.request);await began;
  await expect(service.prepare(f.wallet,f.parentKey,{...f.request,caps:{...f.request.caps,maxTotalLamports:'999'}})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});f.rpc.getGenesisHash=get;release();expect(await first).toMatchObject({childPreparation:{idempotencyKey:f.request.idempotencyKey}});
 }));
 it.each([true,false])('uses a real parent row lock for wire/link races, wireFirst=%s',wireFirst=>fixture(async f=>{
  active();const a=createDb(f.url.toString()),b=createDb(f.url.toString());let release!:()=>void,entered!:()=>void,pidReady!:(pid:number)=>void;const gate=new Promise<void>(r=>{release=r;}),began=new Promise<void>(r=>{entered=r;}),pidPromise=new Promise<number>(r=>{pidReady=r;});
  const hold=afterQuery(a.db,wireFirst?/insert into mining_tax_claim_signed_wires/i:/insert into mining_tax_claim_continuations/i,async()=>{entered();await gate;});
  const first=wireFirst?wire(f,hold):prepare(f,hold);void first.catch(()=>{});let second:Promise<unknown>|undefined;
  try{await Promise.race([began,first.then(()=>{throw Error('missing write barrier');})]);const watched=new Proxy(b.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return (run:Parameters<Db['transaction']>[0])=>b.db.transaction(async tx=>{const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() pid`);pidReady(row!.pid);return run(tx);});}});
   second=(wireFirst?prepare(f,watched):wire(f,watched)).then(value=>({ok:true,value}),error=>({ok:false,error}));const pid=await pidPromise;let blocked=false;
   for(let n=0;n<100;n++){const [row]=await f.conn.sql<{waiting:boolean}[]>`select wait_event_type='Lock' waiting from pg_stat_activity where pid=${pid}`;if(row?.waiting){blocked=true;break;}await tick();}expect(blocked).toBe(true);release();await first;const result=await second as {ok:boolean;error?:{code?:string}};expect(result.ok).toBe(!wireFirst);if(wireFirst)expect(result.error).toMatchObject({code:'PARENT_SIGNED'});
   expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toHaveLength(2);expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(wireFirst?0:1);
  }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);await a.sql.end();await b.sql.end();}
 }));
 it('rolls back child and link together after INSERT failure and recovers lost COMMIT',()=>fixture(async f=>{
  active();const broken=afterQuery(f.conn.db,/insert into mining_tax_claim_continuations/i,async()=>{throw Error('lost transaction');});await expect(prepare(f,broken)).rejects.toThrow();expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(1);
  const transaction=f.conn.db.transaction.bind(f.conn.db),lost=new Proxy(f.conn.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return async(run:Parameters<Db['transaction']>[0])=>{await transaction(run);throw Error('lost COMMIT reply');};}});await expect(prepare(f,lost)).rejects.toThrow();const saved=await prepare(f);expect(saved.childPreparation.idempotencyKey).toBe(f.request.idempotencyKey);expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(2);
 }));
 it('does not let a pause during quote create either child or link',()=>fixture(async f=>{
  active();f.control.afterFee=async()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','false');};await expect(prepare(f)).rejects.toMatchObject({code:'DISABLED'});expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(0);expect(await f.conn.sql`select claim_id from mining_tax_claim_preparations`).toHaveLength(1);
 }));
 it('permanently holds old review/admission/relay but keeps late custody and owner history writable',()=>fixture(async f=>{
  active();await prepare(f);await wire(f);const before=f.calls.connect,offline={...f.sources,connect:()=>{throw Error('offline');}};
  for(const read of [createMiningTaxClaimReview(f.conn.db,offline),createMiningTaxClaimAdmission(f.conn.db,offline)])await expect(read({...f.key,ordinal:1})).rejects.toMatchObject({code:'CONTINUED'});
  expect(await createMiningTaxClaimReconciler(f.conn.db,{admission:offline,transport:()=>{throw Error('offline');}})({...f.key,ordinal:1})).toMatchObject({status:'held',reason:'CONTINUED',claimFinalized:false});expect(f.calls.connect).toBe(before);
  const claim=f.chain.txs[1]!;claim.meta!.fee=4;claim.meta!.preBalances[0]!-=1;
  await f.stage('paid');const paid=await createMiningTaxClaimSettlement(f.conn.db,f.options)({...f.key,ordinal:1});expect(paid.claimFinalized).toBe(true);expect(await getMiningTaxClaimContinuation(f.conn.db,lookup(f))).not.toBeNull();
 }));
 it('keeps links immutable and idempotent across migration replay even with broad runtime grants',()=>fixture(async f=>{
  active();const a=await prepare(f),role=`tax_link_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{for(const statement of ['update mining_tax_claim_continuations set expiry_height=expiry_height','delete from mining_tax_claim_continuations','truncate mining_tax_claim_continuations'])await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(statement);})).rejects.toThrow('IMMUTABLE');}finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
  for(let n=0;n<2;n++)for(const statement of continuationMigration().split('--> statement-breakpoint').filter(s=>s.trim()))await f.conn.sql.unsafe(statement);expect(await getMiningTaxClaimContinuation(f.conn.db,lookup(f))).toEqual(a);
 }));
 it('permits restricted runtime linking and late custody without UPDATE or receipt writer privileges',()=>fixture(async f=>{
  active();const role=`tax_continue_${randomUUID().replaceAll('-','')}`,password=randomUUID();await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};grant select on all tables in schema public to ${role};grant insert on mining_tax_claim_preparations,mining_tax_claim_signed_wires,mining_tax_claim_continuations to ${role};grant execute on function public.shardkeep_mining_tax_continuation_lock(uuid) to ${role}`);
  const url=new URL(f.url);url.username=role;url.password=password;const c=createDb(url.toString());
  try{const [rights]=await c.sql`select has_table_privilege(current_user,'mining_tax_claim_preparations','UPDATE') mutable,has_table_privilege(current_user,'mining_tax_claim_receipts','INSERT') writer`;expect(rights).toEqual({mutable:false,writer:false});const saved=await prepare(f,c.db);await wire(f,c.db);expect(await getMiningTaxClaimContinuation(c.db,lookup(f))).toEqual(saved);}
  finally{await c.sql.end();await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('SQL refuses forged expiry provenance and derived fields before accepting an immutable link',()=>fixture(async f=>{
  active();const a=f.record.artifact,quote=await f.quote(),child=createMiningTaxClaimPreparationRecord(f.wallet,{...f.request,round:a.round,spot:a.spot},quote,{claimId:randomUUID(),preparedAt:f.control.now});await saveMiningTaxClaimPreparation(f.conn.db,child);
  for(const [height,slot] of [[a.lastValidBlockHeight,f.control.slot],[f.control.height+1,f.control.slot],[f.control.height,f.control.slot+1],[f.control.height,0]])await expect(f.conn.sql`insert into mining_tax_claim_continuations(parent_claim_id,child_claim_id,expiry_height,expiry_slot) values(${a.claimId},${child.artifact.claimId},${height!},${slot!})`).rejects.toThrow('EXPIRY');
  await expect(f.conn.sql`insert into mining_tax_claim_continuations(parent_claim_id,child_claim_id,expiry_height,expiry_slot,wallet) values(${a.claimId},${child.artifact.claimId},${f.control.height},${f.control.slot},${f.wallet})`).rejects.toThrow('DERIVED');
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_tax_claim_continuations(parent_claim_id,child_claim_id,expiry_height,expiry_slot) values(${a.claimId},${child.artifact.claimId},${f.control.height},${f.control.slot})`;})).rejects.toThrow('READ_COMMITTED');
  expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(0);await f.conn.sql`insert into mining_tax_claim_continuations(parent_claim_id,child_claim_id,expiry_height,expiry_slot) values(${a.claimId},${child.artifact.claimId},${f.control.height},${f.control.slot})`;expect(await getMiningTaxClaimContinuation(f.conn.db,lookup(f))).toMatchObject({childPreparation:{claimId:child.artifact.claimId}});
 }));
 it('keeps timed-out RPC work coalesced until concrete ignored-abort work drains',()=>fixture(async f=>{
  active();const clock=controlledDeadline(1234),get=f.rpc.getGenesisHash;let entered!:()=>void,release!:()=>void;const began=new Promise<void>(r=>{entered=r;});f.rpc.getGenesisHash=async()=>{entered();await new Promise<void>(r=>{release=r;});return get();};
  const service=createMiningTaxClaimContinuation(f.conn.db,{...f.sources,timeoutMs:1234});
  try{const first=service.prepare(f.wallet,f.parentKey,f.request),rejected=expect(first).rejects.toMatchObject({code:'TIMEOUT'});await began;clock.fire();await rejected;
   await expect(service.prepare(f.wallet,f.parentKey,f.request)).rejects.toMatchObject({code:'TIMEOUT'});await expect(service.prepare(f.wallet,f.parentKey,{...f.request,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
   f.rpc.getGenesisHash=get;release();await tick();vi.stubEnv('PHASE_E_MINING_ENABLED','false');await expect(service.prepare(f.wallet,f.parentKey,f.request)).rejects.toMatchObject({code:'DISABLED'});expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(0);
  }finally{release?.();clock.restore();}
 }));
 it('retains all32 concrete SQL reply slots after timeout until actual drain',()=>fixture(async f=>{
  active();const clock=controlledDeadline(1234),dialect=new PgDialect(),execute=f.conn.db.execute.bind(f.conn.db),releases:Array<()=>void>=[];let entered!:()=>void,block=true;const began=new Promise<void>(r=>{entered=r;});
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='execute')return Reflect.get(t,p,r);return async(query:Parameters<Db['execute']>[0])=>{const result=await execute(query),text=typeof query==='string'?query:dialect.sqlToQuery(query.getSQL()).sql;if(block&&text.startsWith('select c.wallet,')){await new Promise<void>(resolve=>{releases.push(resolve);if(releases.length===32)entered();});}return result;};}});
  const service=createMiningTaxClaimContinuation(db,{...f.sources,timeoutMs:1234}),keys=Array.from({length:32},()=>randomUUID()),extra=randomUUID();
  try{const replies=keys.map(k=>service.prepare(f.wallet,k,f.request).then(()=>({code:'unexpected'}),error=>error));await began;clock.fire();expect((await Promise.all(replies)).every(e=>e.code==='TIMEOUT')).toBe(true);await expect(service.prepare(f.wallet,extra,f.request)).rejects.toMatchObject({code:'BUSY'});expect(releases).toHaveLength(32);
   block=false;for(const release of releases)release();await tick();await expect(service.prepare(f.wallet,extra,f.request)).rejects.toMatchObject({code:'NOT_PREPARED'});expect(await f.conn.sql`select * from mining_tax_claim_continuations`).toHaveLength(0);
  }finally{block=false;for(const release of releases)release();clock.restore();}
 }));
});

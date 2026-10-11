import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {createMiningTaxClaimFailure,getMiningTaxClaimFailure} from '../src/mining/taxClaimFailure';
import {acceptMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {getMiningTaxClaimSettlement} from '../src/mining/taxClaimSettlement';
import {withMiningTaxFailureFixture as fixture,failureMigration} from './fixtures/miningTaxFailure';
afterEach(()=>vi.unstubAllEnvs());
type F=Parameters<Parameters<typeof fixture>[0]>[0];
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function failedBank(f:F,ordinal=0){const tx=f.chain.txs[ordinal]!,m=tx.meta!;tx.meta={...m,err:{InstructionError:[0,{Custom:9}]},postBalances:m.preBalances.map((n,i)=>n-(i===0?m.fee:0)),postTokenBalances:structuredClone(m.preTokenBalances!)};}
describe('owner-only immutable KEEP tax packet failure recovery',()=>{
 it.each(['claim','combined','split'] as const)('recovers exact failed%s offline after pause and expiry without resolving whole plan',mode=>fixture(async f=>{
  await failedBank(f);vi.stubEnv('PHASE_E_MINING_ENABLED','false');const fail=createMiningTaxClaimFailure(f.conn.db,f.failureOptions);
  const saved=await fail(f.key);expect(saved).toMatchObject({...f.key,claimId:f.record.artifact.claimId,transactionFailed:true,claimFinalized:false,receipt:{outcome:'failed',paidKeepBaseUnits:'0',rentLamports:'0',feeLamports:'5',signingAuthorized:false,journalClearingAuthorized:false}});
  expect(saved.verifiedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);f.chain.rpc.getTransaction=async()=>{throw Error('offline');};
  expect(await fail(f.key)).toEqual(saved);expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toEqual(saved);
  const c=createDb(f.url.toString());try{expect(await createMiningTaxClaimFailure(c.db,{...f.failureOptions,connect:()=>{throw Error('offline');}})(f.key)).toEqual(saved);}finally{await c.sql.end();}
  expect(await getMiningTaxClaimFailure(f.conn.db,{...f.key,wallet:f.buyer})).toBeNull();expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toBeNull();
 },{mode}));
 it('requires retained signature before RPC and rejects caller-supplied authority',()=>fixture(async f=>{
  const fail=createMiningTaxClaimFailure(f.conn.db,f.failureOptions);await expect(fail(f.key)).rejects.toMatchObject({code:'NOT_SIGNED'});
  for(const extra of [{ordinal:2},{receipt:{}},{claimId:randomUUID()},{finalityAuthenticated:true},{[Symbol('proof')]:true}])await expect(fail({...f.key,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(f.chain.calls.genesis).toBe(0);
 },{persistSigned:false}));
 it('records an actual fee above old caps without refund or renewed signing consent',()=>fixture(async f=>{
  f.chain.txs[0]!.meta!.fee=Number(f.record.artifact.caps.maxFeeLamports)+1;await failedBank(f);const saved=await createMiningTaxClaimFailure(f.conn.db,f.failureOptions)(f.key);
  expect(saved.receipt.feeLamports).toBe(String(f.chain.txs[0]!.meta!.fee));expect(saved.receipt.signingAuthorized).toBe(false);
 }));
 it('runtime broad grants do not enable forged receipts or destructive changes',()=>fixture(async f=>{
  const receipt=await f.failure(),role=`tax_failure_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify(receipt)}::jsonb)`;})).rejects.toThrow('MINING_TAX_FAILURE_OWNER_REQUIRED');
   const calls=f.chain.calls.genesis;await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await expect(createMiningTaxClaimFailure(tx as unknown as Db,f.failureOptions)(f.key)).rejects.toMatchObject({code:'OWNER_REQUIRED'});});expect(f.chain.calls.genesis).toBe(calls);
   await failedBank(f);const saved=await createMiningTaxClaimFailure(f.conn.db,f.failureOptions)(f.key);
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await getMiningTaxClaimFailure(tx,f.key)).toEqual(saved);});
   for(const statement of ['update mining_tax_claim_failures set receipt=receipt','delete from mining_tax_claim_failures','truncate mining_tax_claim_failures'])await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(statement);})).rejects.toThrow('MINING_TAX_FAILURE_IMMUTABLE');
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('rejects SQL identity, wire, source, type and authority substitutions',()=>fixture(async f=>{
  const r=await f.failure();const changes=[{wallet:f.buyer},{idempotencyKey:randomUUID()},{claimId:randomUUID()},{ordinal:1},{kind:'setup'},{signature:f.buyer},{messageSha256:'ab'.repeat(32)},{signedTransactionSha256:'ab'.repeat(32)},{round:'999'},{spot:99},{extra:true},{feeLamports:5},{feeLamports:'05'},{rentLamports:'1'},{paidKeepBaseUnits:'1'},{paymentAuthorized:true},{signingAuthorized:true},{journalClearingAuthorized:true},{slot:f.record.artifact.source.snapshotSlot-1},{blockTime:0}];
  for(const change of changes)await expect(f.conn.sql`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify({...r,...change})}::jsonb)`).rejects.toThrow();
  for(const change of [{snapshotSha256:'ab'.repeat(32)},{snapshotSlot:0},{blockhashSlot:0},{observedAccountSlot:0},{reviewedProgramDataSha256:'ab'.repeat(32)},{configAddress:f.buyer},{extra:true}])await expect(f.conn.sql`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify({...r,source:{...r.source,...change}})}::jsonb)`).rejects.toThrow();
  await expect(f.conn.sql`insert into mining_tax_claim_failures(claim_id,ordinal,wallet,receipt) values(${f.record.artifact.claimId},0,${f.wallet},${JSON.stringify(r)}::jsonb)`).rejects.toThrow('MINING_TAX_FAILURE_DERIVED');
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify(r)}::jsonb)`;})).rejects.toThrow('READ_COMMITTED');
 }));
 it('preserves original immutable payload through duplicates and migration replay',()=>fixture(async f=>{
  await failedBank(f);const create=()=>createMiningTaxClaimFailure(f.conn.db,f.failureOptions)(f.key),[a,b]=await Promise.all([create(),create()]);expect(a).toEqual(b);
  for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const statement of failureMigration().split('--> statement-breakpoint').filter(x=>x.trim()))await tx.unsafe(statement);});expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toEqual(a);
  for(const query of ['update mining_tax_claim_failures set receipt=receipt','delete from mining_tax_claim_failures','truncate mining_tax_claim_failures'])await expect(f.conn.sql.unsafe(query)).rejects.toThrow('IMMUTABLE');
  expect(await f.conn.sql`select claim_id from mining_tax_claim_failures`).toHaveLength(1);
 }));
 it.each([[0,0,true],[0,1,true],[1,1,true],[1,0,false]].flatMap(([failed,success,conflict])=>[true,false].map(firstFailure=>({failed:failed as number,success:success as number,conflict:conflict as boolean,firstFailure}))))('serializes outcome prefixes $failed/$success, failureFirst=$firstFailure',({failed,success,conflict,firstFailure})=>fixture(async f=>{
  const failure=await f.failure(failed),receipt=await f.success(success),a=createDb(f.url.toString()),b=createDb(f.url.toString());
  let release!:()=>void,entered!:()=>void,pidReady!:(pid:number)=>void;
  const gate=new Promise<void>(r=>{release=r;}),wrote=new Promise<void>(r=>{entered=r;}),pidPromise=new Promise<number>(r=>{pidReady=r;});
  const insert=(tx:Pick<typeof f.conn.sql,'unsafe'>,failureRow:boolean)=>tx.unsafe(failureRow?'insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values($1,$2,$3::jsonb)':'insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values($1,$2,$3::jsonb)',[f.record.artifact.claimId,failureRow?failed:success,JSON.stringify(failureRow?failure:receipt)]);
  const first=a.sql.begin(async tx=>{await insert(tx,firstFailure);entered();await gate;});
  let second:Promise<unknown>|undefined;
  try{
   await wrote;second=b.sql.begin(async tx=>{const [row]=await tx<{pid:number}[]>`select pg_backend_pid() pid`;pidReady(row!.pid);await insert(tx,!firstFailure);}).then(()=>({ok:true}),error=>({ok:false,error}));
   const pid=await pidPromise;let blocked=false;
   for(let i=0;i<100;i++){const [row]=await f.conn.sql<{waiting:boolean}[]>`select wait_event_type='Lock' waiting from pg_stat_activity where pid=${pid}`;if(row?.waiting){blocked=true;break;}await tick();}
   expect(blocked).toBe(true);release();await first;const result=await second as {ok:boolean;error?:Error};expect(result.ok).toBe(!conflict);
   if(conflict)expect(result.error?.message).toContain('MINING_TAX_OUTCOME_CONFLICT');
   expect(await f.conn.sql`select claim_id from mining_tax_claim_failures`).toHaveLength(firstFailure||!conflict?1:0);
   expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(!firstFailure||!conflict?1:0);
  }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);await a.sql.end();await b.sql.end();}
 },{mode:'split'}));
 it('permits both failed ordinals without inventing a successful setup prefix',()=>fixture(async f=>{
  for(const ordinal of [0,1]){const receipt=await f.failure(ordinal);await f.conn.sql`insert into mining_tax_claim_failures(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},${ordinal},${JSON.stringify(receipt)}::jsonb)`;}
  for(const ordinal of [0,1])expect(await getMiningTaxClaimFailure(f.conn.db,{...f.key,ordinal})).toMatchObject({ordinal,transactionFailed:true,claimFinalized:false});
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
 },{mode:'split'}));
 it('records a sparse failed claim packet without inventing unresolved setup custody or success',()=>fixture(async f=>{
  await acceptMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,signedTransaction:f.wire(1)});await failedBank(f,1);
  const fail=createMiningTaxClaimFailure(f.conn.db,f.failureOptions),k={...f.key,ordinal:1};expect(await fail(k)).toMatchObject({ordinal:1,transactionFailed:true,claimFinalized:false});
  expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toBeNull();await expect(fail(f.key)).rejects.toMatchObject({code:'NOT_SIGNED'});
  expect(await f.conn.sql`select ordinal from mining_tax_claim_signed_wires`).toEqual([{ordinal:1}]);expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
 },{mode:'split',persistSigned:false}));
 it.each(['missing','successful','unavailable'] as const)('holds %s observations without recording failure',kind=>fixture(async f=>{
  if(kind==='missing')f.chain.rpc.getTransaction=async()=>null;
  if(kind==='unavailable')f.chain.rpc.getTransaction=async()=>{throw Error('offline');};
  await expect(createMiningTaxClaimFailure(f.conn.db,f.failureOptions)(f.key)).rejects.toThrow();
  expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toBeNull();expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);
 }));
 it('rolls back insertion failure while retaining exact custody for later recovery',()=>fixture(async f=>{
  await failedBank(f);await f.conn.sql.unsafe("create function test_tax_failure_rollback() returns trigger language plpgsql as $$begin raise exception 'fixture rollback';end$$;create trigger test_tax_failure_rollback before insert on mining_tax_claim_failures for each row execute function test_tax_failure_rollback()");
  const fail=createMiningTaxClaimFailure(f.conn.db,f.failureOptions);await expect(fail(f.key)).rejects.toThrow();expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toBeNull();
  expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);await f.conn.sql.unsafe('drop trigger test_tax_failure_rollback on mining_tax_claim_failures');expect((await fail(f.key)).transactionFailed).toBe(true);
 }));
 it('rolls back a failed post-insert read instead of reporting an uncommitted proof',()=>fixture(async f=>{
  await failedBank(f);const transaction=f.conn.db.transaction.bind(f.conn.db);
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return async(run:Parameters<Db['transaction']>[0])=>transaction(tx=>{let inserted=false;const execute=tx.execute.bind(tx);const wrapped=new Proxy(tx,{get(inner,name,receiver){if(name!=='execute')return Reflect.get(inner,name,receiver);return async(query:Parameters<typeof execute>[0])=>{if(inserted)throw Error('post-insert read lost');const value=await execute(query);const rows=await tx.execute(sql`select claim_id from mining_tax_claim_failures`);inserted=rows.length>0;return value;};}});return run(wrapped);});}});
  await expect(createMiningTaxClaimFailure(db,f.failureOptions)(f.key)).rejects.toThrow();expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toBeNull();
  expect((await createMiningTaxClaimFailure(f.conn.db,f.failureOptions)(f.key)).transactionFailed).toBe(true);
 }));
 it('recovers immutable failure after COMMIT succeeds but its reply misses the deadline',()=>fixture(async f=>{
  await failedBank(f);const transaction=f.conn.db.transaction.bind(f.conn.db);let release!:()=>void,committed!:()=>void;const done=new Promise<void>(r=>{committed=r;});
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return async(run:Parameters<Db['transaction']>[0])=>{const result=await transaction(run);committed();await new Promise<void>(resolve=>{release=resolve;});return result;};}});
  const fail=createMiningTaxClaimFailure(db,{...f.failureOptions,timeoutMs:1000}),rejected=expect(fail(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await done;await rejected;
  const saved=await getMiningTaxClaimFailure(f.conn.db,f.key);expect(saved).not.toBeNull();release();await tick();
  expect(await createMiningTaxClaimFailure(f.conn.db,{...f.failureOptions,connect:()=>{throw Error('offline');}})(f.key)).toEqual(saved);
 }));
 it('coalesces timed-out work until an ignored-abort RPC drains and never inserts late evidence',()=>fixture(async f=>{
  await failedBank(f);const original=f.chain.rpc.getGenesisHash.bind(f.chain.rpc);let release!:(v:string)=>void,entered!:()=>void,calls=0;const began=new Promise<void>(r=>{entered=r;});
  f.chain.rpc.getGenesisHash=()=>{calls++;entered();return new Promise(r=>{release=r;});};const fail=createMiningTaxClaimFailure(f.conn.db,{...f.failureOptions,timeoutMs:1000});
  const rejected=expect(fail(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await began;await rejected;await expect(fail(f.key)).rejects.toMatchObject({code:'TIMEOUT'});expect(calls).toBe(1);
  release(f.chain.trust.mining.expectedGenesisHash);await tick();expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toBeNull();f.chain.rpc.getGenesisHash=original;expect((await fail(f.key)).transactionFailed).toBe(true);
 }));
 it('retains all32 concrete RPC slots after timeout until the actual calls drain',()=>fixture(async f=>{
  await failedBank(f);const keys=[f.key];for(let i=1;i<32;i++)keys.push(await f.forkClaim());const extra=await f.forkClaim();
  const original=f.chain.rpc.getGenesisHash.bind(f.chain.rpc),releases:Array<()=>void>=[];let entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  f.chain.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{releases.push(()=>resolve(f.chain.trust.mining.expectedGenesisHash));if(releases.length===32)entered();});
  const fail=createMiningTaxClaimFailure(f.conn.db,{...f.failureOptions,timeoutMs:5000}),all=Promise.all(keys.map(k=>fail(k).then(()=>({code:'unexpected'}),e=>e)));
  try{await Promise.race([began,all.then(()=>{if(releases.length!==32)throw Error(`Only ${releases.length}/32 RPCs entered`);})]);expect((await all).every(e=>e.code==='TIMEOUT')).toBe(true);await expect(fail(extra)).rejects.toMatchObject({code:'BUSY'});expect(releases).toHaveLength(32);}
  finally{for(const release of releases)release();f.chain.rpc.getGenesisHash=original;await tick();}
  expect(await f.conn.sql`select claim_id from mining_tax_claim_failures`).toHaveLength(0);expect((await fail(f.key)).transactionFailed).toBe(true);
 }));
 it('retains all32 blocked SQL slots beyond timeout without reaching RPC',()=>fixture(async f=>{
  await failedBank(f);const execute=f.conn.db.execute.bind(f.conn.db),releases:Array<()=>void>=[];
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='execute')return Reflect.get(t,p,r);return async(query:Parameters<typeof execute>[0])=>{await new Promise<void>(resolve=>{releases.push(resolve);});return execute(query);};}});
  const fail=createMiningTaxClaimFailure(db,{...f.failureOptions,timeoutMs:50}),keys=Array.from({length:32},()=>({...f.key,idempotencyKey:randomUUID()}));
  const all=Promise.all(keys.map(k=>fail(k).then(()=>({code:'unexpected'}),e=>e)));expect((await all).every(e=>e.code==='TIMEOUT')).toBe(true);expect(releases).toHaveLength(32);
  await expect(fail(f.key)).rejects.toMatchObject({code:'BUSY'});expect(f.chain.calls.genesis).toBe(0);for(const release of releases)release();await tick();expect(await getMiningTaxClaimFailure(f.conn.db,f.key)).toBeNull();
  expect((await createMiningTaxClaimFailure(f.conn.db,f.failureOptions)(f.key)).transactionFailed).toBe(true);
 }));

});

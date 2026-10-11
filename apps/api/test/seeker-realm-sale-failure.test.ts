import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createDb,type Db} from '../src/db/client';
import {createRealmSaleFailure,getRealmSaleFailure} from '../src/seeker/realmSaleFailure';
import {getRealmSaleSigned} from '../src/seeker/realmSaleSignedStore';
import {withRealmSaleFailureFixture as fixture,realmFailureMigration} from './fixtures/realmSaleFailure';
afterEach(()=>vi.unstubAllEnvs());
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
describe('immutable original realm sale failure',()=>{
 it('recovers original failed custody after restart, pause and provider loss without granting purchase or release',()=>fixture(async f=>{
  expect(await getRealmSaleFailure(f.conn.db,f.key)).toBeNull();const connect=vi.fn(()=>f.rpc),create=createRealmSaleFailure(f.conn.db,{...f.options,connect});
  const saved=await create(f.key);expect(saved).toMatchObject({...f.key,saleId:f.artifact.saleId,transactionFailed:true,purchaseFinalized:false,journalClearingAuthorized:false,receipt:{feeLamports:'5000',actualRentLamports:'0',buyerNetPaymentLamports:'0',accessChanged:false,quotaConsumed:false}});
  vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');const restart=createDb(f.url.toString());try{const down=vi.fn(()=>{throw Error('offline');});expect(await createRealmSaleFailure(restart.db,{...f.options,connect:down})(f.key)).toEqual(saved);expect(down).not.toHaveBeenCalled();}finally{await restart.sql.end();}
  expect(await create(f.key)).toEqual(saved);expect(connect).toHaveBeenCalledTimes(1);expect(await getRealmSaleFailure(f.conn.db,{...f.key,wallet:Keypair.generate().publicKey.toBase58()})).toBeNull();expect(await getRealmSaleSigned(f.conn.db,f.key)).toMatchObject({wire:{signature:saved.receipt.signature}});
 }));
 it.each([null,-1])('retains nullable or lagging blockTime %s and actual fee above quote',blockTime=>fixture(async f=>{
  f.transaction.blockTime=blockTime;f.transaction.meta.fee=Number(f.artifact.quote.feeLamports)+1;f.transaction.meta.postBalances=f.transaction.meta.preBalances.map((n,i)=>n-(i===0?f.transaction.meta.fee:0));
  expect((await createRealmSaleFailure(f.conn.db,f.options)(f.key)).receipt).toMatchObject({blockTime,feeLamports:'5001',paymentAuthorized:false});
 }));
 it('owns input and reviewed pins, rejects foreign keys and extra authority before RPC',()=>fixture(async f=>{
  const connect=vi.fn(()=>f.rpc),create=createRealmSaleFailure(f.conn.db,{...f.options,connect});
  for(const extra of [{receipt:{}},{finalityVerified:true},{[Symbol('proof')]:true}])await expect(create({...f.key,...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(create({...f.key,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'NOT_SIGNED'});
  for(const patch of [{expectedGenesisHash:Keypair.generate().publicKey.toBase58()},{reviewedDeploymentSlot:f.options.trust.reviewedDeploymentSlot+1},{reviewedProgramDataSha256:'ab'.repeat(32)},{developer:Keypair.generate().publicKey}])await expect(createRealmSaleFailure(f.conn.db,{connect,trust:{...f.options.trust,...patch}})(f.key)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
  expect(connect).not.toHaveBeenCalled();const trust={...f.options.trust},owned=createRealmSaleFailure(f.conn.db,{connect,trust});trust.reviewedProgramDataSha256='ab'.repeat(32);expect((await owned(f.key)).transactionFailed).toBe(true);
 }));
 it.each(['missing','success','unavailable'] as const)('holds %s observations and preserves signed custody',kind=>fixture(async f=>{
  const rpc={...f.rpc,getTransaction:async()=>{if(kind==='unavailable')throw Error('offline');return kind==='missing'?null:f.chain.transaction;}};
  await expect(createRealmSaleFailure(f.conn.db,{...f.options,connect:()=>rpc})(f.key)).rejects.toThrow();expect(await getRealmSaleFailure(f.conn.db,f.key)).toBeNull();expect((await getRealmSaleSigned(f.conn.db,f.key))?.wire).not.toBeNull();
 }));
 it('denies accidental runtime writes while permitting private historical reads',()=>fixture(async f=>{
  const role=`realm_failure_${randomUUID().replaceAll('-','')}`,receipt=await f.failure();await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into seeker_realm_sale_failures(wallet,idempotency_key,receipt) values(${f.key.wallet},${f.key.idempotencyKey},${JSON.stringify(receipt)}::jsonb)`;})).rejects.toThrow('REALM_SALE_FAILURE_OWNER_REQUIRED');
   const connect=vi.fn(()=>f.rpc);await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await expect(createRealmSaleFailure(tx as unknown as Db,{...f.options,connect})(f.key)).rejects.toMatchObject({code:'OWNER_REQUIRED'});});expect(connect).not.toHaveBeenCalled();
   const saved=await createRealmSaleFailure(f.conn.db,f.options)(f.key);await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await getRealmSaleFailure(tx,f.key)).toEqual(saved);});
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('rejects forged identity, source, typed values and terminal authorities in SQL',()=>fixture(async f=>{
  const r=await f.failure();for(const change of [{wallet:Keypair.generate().publicKey.toBase58()},{saleId:'ab'.repeat(16)},{spot:r.spot+1},{round:'99'},{signature:'bad'},{originalMessageSha256:'ab'.repeat(32)},{signedTransactionSha256:'ab'.repeat(32)},{extra:true},{feeLamports:5000},{feeLamports:'05000'},{actualRentLamports:'1'},{buyerNetPaymentLamports:'1'},{accessChanged:true},{quotaConsumed:true},{paymentAuthorized:true},{journalClearingAuthorized:true},{slot:0},{blockTime:'0'},{proofClockUnixTimestamp:'0'}])await expect(f.conn.sql`insert into seeker_realm_sale_failures(wallet,idempotency_key,receipt) values(${f.key.wallet},${f.key.idempotencyKey},${JSON.stringify({...r,...change})}::jsonb)`).rejects.toThrow('REALM_SALE_FAILURE_');
  for(const change of [{genesisHash:Keypair.generate().publicKey.toBase58()},{reviewedProgramDataSha256:'ab'.repeat(32)},{accounts:[]},{extra:true}])await expect(f.conn.sql`insert into seeker_realm_sale_failures(wallet,idempotency_key,receipt) values(${f.key.wallet},${f.key.idempotencyKey},${JSON.stringify({...r,source:{...r.source,...change}})}::jsonb)`).rejects.toThrow('REALM_SALE_FAILURE_');
  await expect(f.conn.sql.begin('isolation level repeatable read',tx=>tx`insert into seeker_realm_sale_failures(wallet,idempotency_key,receipt) values(${f.key.wallet},${f.key.idempotencyKey},${JSON.stringify(r)}::jsonb)`)).rejects.toThrow('READ_COMMITTED');
 }));
 it('refuses corrupt owner history rather than trusting persisted flags or account order',()=>fixture(async f=>{
  const saved=await createRealmSaleFailure(f.conn.db,f.options)(f.key),receipt={...saved.receipt,source:{...saved.receipt.source,accounts:[...saved.receipt.source.accounts].reverse()}};
  await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update seeker_realm_sale_failures set receipt=${JSON.stringify(receipt)}::jsonb`;});await expect(getRealmSaleFailure(f.conn.db,f.key)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
 }));
 it('rechecks the original Ed25519 signature before returning owner-attested historical failure',()=>fixture(async f=>{
  await createRealmSaleFailure(f.conn.db,f.options)(f.key);
  await f.conn.sql.begin(async tx=>{await tx`set local session_replication_role=replica`;await tx`update seeker_realm_sale_signed_wires set signed_transaction=set_byte(signed_transaction,1,(get_byte(signed_transaction,1)+1)%256)`;});
  await expect(getRealmSaleFailure(f.conn.db,f.key)).rejects.toThrow();
 }));
 it('keeps immutable exact history through duplicate factories and repeated DDL',()=>fixture(async f=>{
  const [one,two]=await Promise.all([createRealmSaleFailure(f.conn.db,f.options)(f.key),createRealmSaleFailure(f.conn.db,f.options)(f.key)]);expect(one).toEqual(two);
  for(let i=0;i<2;i++)for(const statement of realmFailureMigration().split('--> statement-breakpoint').filter(s=>s.trim()))await f.conn.sql.unsafe(statement);
  expect(await getRealmSaleFailure(f.conn.db,f.key)).toEqual(one);for(const query of ['update seeker_realm_sale_failures set receipt=receipt','delete from seeker_realm_sale_failures','truncate seeker_realm_sale_failures'])await expect(f.conn.sql.unsafe(query)).rejects.toThrow('REALM_SALE_FAILURE_IMMUTABLE');
 }));
 it.each([true,false])('serializes actual competing outcome inserts, failure first=%s',failureFirst=>fixture(async f=>{
  const failure=await f.failure(),success=await f.success(),a=createDb(f.url.toString()),b=createDb(f.url.toString());let release!:()=>void,entered!:()=>void,pidReady!:(v:number)=>void;
  const gate=new Promise<void>(r=>{release=r;}),wrote=new Promise<void>(r=>{entered=r;}),pidPromise=new Promise<number>(r=>{pidReady=r;});
  const insert=(tx:Pick<typeof f.conn.sql,'unsafe'>,failed:boolean)=>tx.unsafe(`insert into ${failed?'seeker_realm_sale_failures':'seeker_realm_sale_receipts'}(wallet,idempotency_key,receipt) values($1,$2,$3::jsonb)`,[f.key.wallet,f.key.idempotencyKey,JSON.stringify(failed?failure:success)]);
  const first=a.sql.begin(async tx=>{await insert(tx,failureFirst);entered();await gate;});let second:Promise<unknown>|undefined;
  try{await wrote;second=b.sql.begin(async tx=>{const [row]=await tx<{pid:number}[]>`select pg_backend_pid() pid`;pidReady(row!.pid);await insert(tx,!failureFirst);}).then(()=>({ok:true}),error=>({ok:false,error}));const pid=await pidPromise;let blocked=false;
   for(let i=0;i<100;i++){const [row]=await f.conn.sql<{waiting:boolean}[]>`select wait_event_type='Lock' waiting from pg_stat_activity where pid=${pid}`;if(row?.waiting){blocked=true;break;}await tick();}expect(blocked).toBe(true);release();await first;
   expect(await second).toMatchObject({ok:false,error:{message:expect.stringContaining('REALM_SALE_OUTCOME_CONFLICT')}});expect(await f.conn.sql`select wallet from seeker_realm_sale_failures`).toHaveLength(failureFirst?1:0);expect(await f.conn.sql`select wallet from seeker_realm_sale_receipts`).toHaveLength(failureFirst?0:1);
  }finally{release();await Promise.allSettled([first,...(second?[second]:[])]);await a.sql.end();await b.sql.end();}
 }));
 it('retains the bounded RPC slot after timeout until ignored cancellation drains',()=>fixture(async f=>{
  let release!:(v:string)=>void,entered!:()=>void;const began=new Promise<void>(r=>{entered=r;}),rpc={...f.rpc,getGenesisHash:()=>{entered();return new Promise<string>(r=>{release=r;});}},create=createRealmSaleFailure(f.conn.db,{...f.options,connect:()=>rpc,timeoutMs:1000});
  const rejected=expect(create(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await began;await rejected;await expect(create({...f.key,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'BUSY'});release(f.options.trust.expectedGenesisHash);await tick();expect(await getRealmSaleFailure(f.conn.db,f.key)).toBeNull();expect((await createRealmSaleFailure(f.conn.db,f.options)(f.key)).transactionFailed).toBe(true);
 }));
 it('retains bounded capacity while an uncancellable SQL lookup is pending',()=>fixture(async f=>{
  const execute=f.conn.db.execute.bind(f.conn.db);let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='execute')return Reflect.get(t,p,r);return async(query:Parameters<typeof execute>[0])=>{await gate;return execute(query);};}}),connect=vi.fn(()=>f.rpc),create=createRealmSaleFailure(db,{...f.options,connect,timeoutMs:100});
  await expect(create(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await expect(create({...f.key,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'BUSY'});expect(connect).not.toHaveBeenCalled();release();await tick();expect(await getRealmSaleFailure(f.conn.db,f.key)).toBeNull();
 }));
 it('recovers durable failure when COMMIT succeeds but its reply misses the deadline',()=>fixture(async f=>{
  const transaction=f.conn.db.transaction.bind(f.conn.db);let committed!:()=>void,release!:()=>void;const done=new Promise<void>(r=>{committed=r;}),gate=new Promise<void>(r=>{release=r;});
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return async(run:Parameters<Db['transaction']>[0])=>{const result=await transaction(run);committed();await gate;return result;};}});
  const rejected=expect(createRealmSaleFailure(db,{...f.options,timeoutMs:1000})(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await done;await rejected;
  const saved=await getRealmSaleFailure(f.conn.db,f.key);expect(saved).not.toBeNull();release();await tick();expect(await createRealmSaleFailure(f.conn.db,{...f.options,connect:()=>{throw Error('offline');}})(f.key)).toEqual(saved);
 }));
 it('rolls back a receipt if its deadline expires after INSERT before returning from the transaction',()=>fixture(async f=>{
  const transaction=f.conn.db.transaction.bind(f.conn.db);let inserted!:()=>void,release!:()=>void;const wrote=new Promise<void>(r=>{inserted=r;}),gate=new Promise<void>(r=>{release=r;});
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return (run:Parameters<Db['transaction']>[0])=>transaction(tx=>{const execute=tx.execute.bind(tx);return run(new Proxy(tx,{get(inner,name,receiver){if(name!=='execute')return Reflect.get(inner,name,receiver);return async(query:Parameters<typeof execute>[0])=>{const result=await execute(query);if((await tx.execute(sql`select wallet from seeker_realm_sale_failures`)).length){inserted();await gate;}return result;};}}));});}});
  const rejected=expect(createRealmSaleFailure(db,{...f.options,timeoutMs:1000})(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await wrote;await rejected;release();await tick();expect(await getRealmSaleFailure(f.conn.db,f.key)).toBeNull();expect((await getRealmSaleSigned(f.conn.db,f.key))?.wire).not.toBeNull();
 }));
});

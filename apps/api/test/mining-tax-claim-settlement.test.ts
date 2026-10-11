import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createMiningTaxReceiptReader} from '@shardkeep/chain/mining-tax-receipt-reader';
import {createDb,type Db} from '../src/db/client';
import {createMiningTaxClaimSettlement,getMiningTaxClaimSettlement} from '../src/mining/taxClaimSettlement';
import {acceptMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {getMiningTaxClaimPreparationRecord} from '../src/mining/taxClaimPreparationStore';
import {withMiningTaxSettlementFixture as fixture,settlementMigration} from './fixtures/miningTaxSettlement';
afterEach(()=>vi.unstubAllEnvs());
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
describe('owner-verified original KEEP tax settlements',()=>{
 it.each(['claim','combined'] as const)('settles actual %s once despite expired quote and paused admission, then recovers offline',mode=>fixture(async f=>{
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');
  expect(Date.parse(f.record.artifact.expiresAt)).toBeLessThan(Date.now());expect(f.record.artifact.source).toMatchObject({firstSnapshotSlot:2000,feeSlot:2002,snapshotSlot:2003});
  const settle=createMiningTaxClaimSettlement(f.conn.db,f.options);expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toBeNull();
  const saved=await settle(f.key);expect(saved).toMatchObject({...f.key,claimId:f.record.artifact.claimId,claimFinalized:true,receipt:{phase:'settled',wallet:f.wallet,paidKeepBaseUnits:f.record.artifact.intended.claimBaseUnits,finalityAuthenticated:true,signingAuthorized:false,broadcastAuthorized:false,journalClearingAuthorized:false}});
  expect(saved.settledAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);expect(saved.receipt.transactions).toHaveLength(1);expect(saved.receipt.transactions[0]!.kind).toBe(mode);
  expect(f.chain.calls.transactions).toEqual(expect.arrayContaining(f.record.snapshot.term.auctions.map(a=>a.settlement.signature)));
  f.chain.rpc.getTransaction=async()=>{throw Error('provider unavailable');};expect(await settle(f.key)).toEqual(saved);
  const c=createDb(f.url.toString());try{expect(await getMiningTaxClaimSettlement(c.db,f.key)).toEqual(saved);expect(await createMiningTaxClaimSettlement(c.db,{...f.options,connect:()=>{throw Error('offline');}})(f.key)).toEqual(saved);}finally{await c.sql.end();}
  expect(await getMiningTaxClaimSettlement(f.conn.db,{...f.key,wallet:f.buyer})).toBeNull();expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(1);
  expect(await getMiningTaxClaimPreparationRecord(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey})).toEqual(f.record);
 },{mode}));
 it('retains genuine finalized fees above the estimate but inside original explicit SOL caps',()=>fixture(async f=>{
  const tx=f.chain.txs[0]!,quoted=f.record.artifact.fees.feeLamports;tx.meta!.fee++;tx.meta!.postBalances[0]!--;
  expect(BigInt(tx.meta!.fee)).toBeGreaterThan(BigInt(quoted));expect(BigInt(tx.meta!.fee)).toBeLessThanOrEqual(BigInt(f.record.artifact.caps.maxFeeLamports));
  const saved=await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);expect(saved.receipt.feeLamports).toBe(String(tx.meta!.fee));expect(saved.claimFinalized).toBe(true);
  expect((await getMiningTaxClaimPreparationRecord(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey}))?.artifact.fees.feeLamports).toBe(quoted);
 }));
 it('stores nonterminal setup, then the complete original signed prefix and exact final payment',()=>fixture(async f=>{
  expect(f.record.snapshot.term.auctions.every(a=>a.settlement.method==='permit')).toBe(true);
  const settle=createMiningTaxClaimSettlement(f.conn.db,f.options),setup=await settle(f.key);
  expect(setup).toMatchObject({ordinal:0,claimFinalized:false,receipt:{phase:'setup',paidKeepBaseUnits:'0'}});expect(setup.receipt.transactions.map(t=>t.kind)).toEqual(['setup']);
  const key={...f.key,ordinal:1},final=await settle(key);expect(final).toMatchObject({ordinal:1,claimFinalized:true,receipt:{phase:'settled',paidKeepBaseUnits:f.record.artifact.intended.claimBaseUnits}});
  expect(final.receipt.transactions.map(t=>t.kind)).toEqual(['setup','claim']);expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toEqual(setup);expect(await getMiningTaxClaimSettlement(f.conn.db,key)).toEqual(final);
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(2);
 },{mode:'split'}));
 it('requires every original signed prefix packet before any finalized read',()=>fixture(async f=>{
  const settle=createMiningTaxClaimSettlement(f.conn.db,f.options),key={...f.key,ordinal:1};
  await expect(settle(f.key)).rejects.toMatchObject({code:'NOT_SIGNED'});
  await acceptMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,signedTransaction:f.wire(1)});
  await expect(settle(key)).rejects.toMatchObject({code:'NOT_SIGNED'});expect(f.chain.calls.genesis).toBe(0);expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
  await acceptMiningTaxClaimSigned(f.conn.db,{wallet:f.wallet,idempotencyKey:f.key.idempotencyKey,signedTransaction:f.wire(0)});expect((await settle(key)).claimFinalized).toBe(true);
 },{mode:'split',persistSigned:false}));
 it('preserves the first payload across independent concurrent owner writers',()=>fixture(async f=>{
  const [a,b]=await Promise.all([createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key),createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key)]);expect(a).toEqual(b);
  const rows=await f.conn.sql`select receipt from mining_tax_claim_receipts`;expect(rows).toHaveLength(1);expect(rows[0]!.receipt).toEqual(a.receipt);
 }));
 it.each(['absent','failed','unavailable','signature','recipient','payment','event','genesis'] as const)('holds %s finalized evidence without inserting a success or clearing custody',kind=>fixture(async f=>{
  const tx=f.chain.txs[0]!,signature=tx.transaction.signatures[0]!;
  if(kind==='absent')f.chain.transactions.set(signature,null);
  if(kind==='failed')tx.meta!.err={InstructionError:[0,{Custom:9}]};
  if(kind==='unavailable')f.chain.rpc.getTransaction=async()=>{throw Error('archive unavailable');};
  if(kind==='signature')tx.transaction.signatures[0]=Keypair.generate().publicKey.toBase58();
  if(kind==='recipient')tx.meta!.postTokenBalances!.at(-1)!.owner=f.buyer;
  if(kind==='payment')tx.meta!.postTokenBalances!.at(-1)!.uiTokenAmount.amount='0';
  if(kind==='event')tx.meta!.logMessages=[];
  if(kind==='genesis')f.chain.rpc.getGenesisHash=async()=>Keypair.generate().publicKey.toBase58();
  await expect(createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key)).rejects.toMatchObject({code:expect.stringMatching(/^RECEIPT_(UNAVAILABLE|CONFLICT)$/)});
  expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toBeNull();expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);
 }));
 it('rejects runtime owner impersonation even with broad grants, but allows saved recovery',()=>fixture(async f=>{
  const payload=await createMiningTaxReceiptReader(f.chain.connect,f.chain.trust)(f.chain.request),role=`tax_receipt_${randomUUID().replaceAll('-','')}`;
  await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify(payload)}::jsonb)`;})).rejects.toThrow('MINING_TAX_RECEIPT_OWNER_REQUIRED');
   const calls=f.chain.calls.genesis;await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await expect(createMiningTaxClaimSettlement(tx as unknown as Db,f.options)(f.key)).rejects.toMatchObject({code:'OWNER_REQUIRED'});});expect(f.chain.calls.genesis).toBe(calls);
   const saved=await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);f.chain.rpc.getTransaction=async()=>{throw Error('offline');};
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await getMiningTaxClaimSettlement(tx,f.key)).toEqual(saved);expect(await createMiningTaxClaimSettlement(tx as unknown as Db,{...f.options,connect:()=>{throw Error('offline');}})(f.key)).toEqual(saved);});
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('rejects canonical-looking SQL receipt substitutions against original consent and signed bytes',()=>fixture(async f=>{
  const r=await createMiningTaxReceiptReader(f.chain.connect,f.chain.trust)(f.chain.request);
  const variants=[{...r,wallet:f.buyer},{...r,paidKeepBaseUnits:'0'},{...r,round:'1'},{...r,spot:20},{...r,pool:r.cursor},{...r,phase:'setup'},
   {...r,source:{...r.source,reviewedProgramDataSha256:'00'.repeat(32)}},{...r,finalityAuthenticated:false},{...r,journalClearingAuthorized:true},
   {...r,transactions:[{...r.transactions[0]!,messageSha256:'00'.repeat(32)}]},{...r,transactions:[{...r.transactions[0]!,signedTransactionSha256:'00'.repeat(32)}]},
   {...r,transactions:[{...r.transactions[0]!,signature:Keypair.generate().publicKey.toBase58()}]}];
  for(const receipt of variants)await expect(f.conn.sql`insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify(receipt)}::jsonb)`).rejects.toThrow();
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
 }));
 it('retains immutable receipts across migration replay and rejects destructive or non-READ-COMMITTED writes',()=>fixture(async f=>{
  const saved=await createMiningTaxClaimSettlement(f.conn.db,f.options)(f.key);
  for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const statement of settlementMigration().split('--> statement-breakpoint').filter(x=>x.trim()))await tx.unsafe(statement);});
  expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toEqual(saved);
  for(const statement of ['update mining_tax_claim_receipts set receipt=receipt','delete from mining_tax_claim_receipts','truncate mining_tax_claim_receipts'])await expect(f.conn.sql.unsafe(statement)).rejects.toThrow('MINING_TAX_RECEIPT_IMMUTABLE');
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_tax_claim_receipts(claim_id,ordinal,receipt) values(${f.record.artifact.claimId},0,${JSON.stringify(saved.receipt)}::jsonb)`;})).rejects.toThrow('MINING_TAX_RECEIPT_READ_COMMITTED');
 }));
 it('rolls back failed receipt insertion while retaining signed custody for a later verified retry',()=>fixture(async f=>{
  await f.conn.sql.unsafe("create function test_tax_receipt_failure() returns trigger language plpgsql as $$begin raise exception 'receipt fixture rollback';end$$;create trigger test_tax_receipt_failure before insert on mining_tax_claim_receipts for each row execute function test_tax_receipt_failure()");
  const settle=createMiningTaxClaimSettlement(f.conn.db,f.options);await expect(settle(f.key)).rejects.toThrow();expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
  expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);await f.conn.sql.unsafe('drop trigger test_tax_receipt_failure on mining_tax_claim_receipts');expect((await settle(f.key)).claimFinalized).toBe(true);
 }));
 it('retains a timed-out slot until the concrete ignored-abort RPC drains and never inserts late evidence',()=>fixture(async f=>{
  const original=f.chain.rpc.getGenesisHash.bind(f.chain.rpc);let release!:(v:string)=>void,entered!:()=>void,calls=0;const began=new Promise<void>(r=>{entered=r;});
  f.chain.rpc.getGenesisHash=()=>{calls++;entered();return new Promise(r=>{release=r;});};const settle=createMiningTaxClaimSettlement(f.conn.db,{...f.options,timeoutMs:1000});
  const rejected=expect(settle(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await began;await rejected;
  await expect(settle(f.key)).rejects.toMatchObject({code:'TIMEOUT'});expect(calls).toBe(1);release(f.chain.trust.mining.expectedGenesisHash);await tick();
  expect(await getMiningTaxClaimSettlement(f.conn.db,f.key)).toBeNull();f.chain.rpc.getGenesisHash=original;expect((await settle(f.key)).claimFinalized).toBe(true);
 }));
 it('retains all32 concrete RPC slots after timeout and returns BUSY until they drain',()=>fixture(async f=>{
  const keys=[f.key];for(let i=1;i<32;i++)keys.push(await f.forkClaim());const extra=await f.forkClaim();
  const original=f.chain.rpc.getGenesisHash.bind(f.chain.rpc),releases:Array<()=>void>=[];let entered!:()=>void;const began=new Promise<void>(r=>{entered=r;});
  f.chain.rpc.getGenesisHash=()=>new Promise<string>(resolve=>{releases.push(()=>resolve(f.chain.trust.mining.expectedGenesisHash));if(releases.length===32)entered();});
  const settle=createMiningTaxClaimSettlement(f.conn.db,{...f.options,timeoutMs:5000}),pending=keys.map(key=>settle(key).then(()=>({code:'unexpected'}),error=>error)),all=Promise.all(pending);
  try{
   await Promise.race([began,all.then(()=>{if(releases.length!==32)throw Error(`Only ${releases.length}/32 RPCs entered before their bounded deadlines`);})]);
   expect((await all).every(e=>e.code==='TIMEOUT')).toBe(true);await new Promise(r=>setTimeout(r,100));
   await expect(settle(extra)).rejects.toMatchObject({code:'BUSY'});expect(releases).toHaveLength(32);
  }finally{for(const release of releases)release();f.chain.rpc.getGenesisHash=original;await tick();}
  expect(await f.conn.sql`select claim_id from mining_tax_claim_receipts`).toHaveLength(0);
  expect((await settle(f.key)).claimFinalized).toBe(true);
 }));
 it('recovers the immutable original receipt after COMMIT succeeds but its reply misses the deadline',()=>fixture(async f=>{
  const transaction=f.conn.db.transaction.bind(f.conn.db);let release!:()=>void,committed!:()=>void;const done=new Promise<void>(r=>{committed=r;});
  const db=new Proxy(f.conn.db,{get(t,p,r){if(p!=='transaction')return Reflect.get(t,p,r);return async(run:Parameters<Db['transaction']>[0])=>{const result=await transaction(run);committed();await new Promise<void>(resolve=>{release=resolve;});return result;};}});
  const settle=createMiningTaxClaimSettlement(db,{...f.options,timeoutMs:1000}),failed=expect(settle(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await done;await failed;
  const saved=await getMiningTaxClaimSettlement(f.conn.db,f.key);expect(saved).not.toBeNull();release();await tick();
  expect(await createMiningTaxClaimSettlement(f.conn.db,{...f.options,connect:()=>{throw Error('offline');}})(f.key)).toEqual(saved);
 }));
 it('rejects untrusted authority fields and malformed original keys before provider use',()=>fixture(async f=>{
  const settle=createMiningTaxClaimSettlement(f.conn.db,f.options);
  for(const change of [{idempotencyKey:'bad'},{ordinal:-1},{ordinal:2},{claimId:randomUUID()},{receipt:{}},{finalityAuthenticated:true},{[Symbol('extra')]:true}])await expect(settle({...f.key,...change})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(f.chain.calls.genesis).toBe(0);expect(()=>createMiningTaxClaimSettlement(f.conn.db,{...f.options,timeoutMs:30001})).toThrow();
 }));
});

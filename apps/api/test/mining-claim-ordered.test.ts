import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {sql} from 'drizzle-orm';
import {createDb} from '../src/db/client';
import {createMiningClaimAdmission} from '../src/mining/claimAdmission';
import {createMiningClaimReview} from '../src/mining/claimReview';
import {createMiningClaimPreparer} from '../src/mining/claimPreparation';
import {getMiningClaimPreparation} from '../src/mining/claimPreparationStore';
import {acceptMiningClaimSigned} from '../src/mining/claimSignedStore';
import {createMiningClaimContinuation,getMiningClaimContinuation} from '../src/mining/claimContinuation';
import {withMiningOrderedClaimFixture as fixture} from './fixtures/miningOrderedClaim';
import {FRESH_DB_CASE_MS} from './freshDbCaseBudgets';
afterEach(()=>vi.unstubAllEnvs());
describe('source-funded ordered mining claims',{timeout:FRESH_DB_CASE_MS},()=>{
 it('keeps default legacy byte profile and source cap while requiring explicit independent lookup admission',async()=>fixture(async f=>{
  expect(f.prepared.header.leafCount).toBeLessThanOrEqual(10000);expect(f.prepared.transactions.map(t=>t.kind)).toEqual(['setup','claim']);expect(f.prepared.feeLamports).toBe('10000');expect(f.prepared.transactions[1]!.rentLamports).toBe('0');
  const legacy=await f.prepare.prepare(f.wallet,{idempotencyKey:randomUUID()});expect(legacy.format).toBeUndefined();expect(legacy.transactions).toHaveLength(1);expect(legacy.transactions[0]!.kind).toBe('combined');
  const {ordered:_ordered,...source}=f.provider;await expect(createMiningClaimPreparer(f.conn.db,source).prepare(f.wallet,{idempotencyKey:randomUUID(),profile:'ordered-v0'})).rejects.toMatchObject({code:'FORMAT_UNAVAILABLE'});
  await expect(f.prepare.prepare(f.wallet,{idempotencyKey:randomUUID(),profile:'ordered-v0',lookupTable:f.prepared.format!.lookupTable})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(f.prepare.prepare(f.wallet,{idempotencyKey:f.prepared.idempotencyKey})).rejects.toMatchObject({code:'INVALID_INPUT'});
  const original=f.table.data[60]!;f.table.data[60]=original^1;await expect(f.prepare.prepare(f.wallet,{idempotencyKey:randomUUID(),profile:'ordered-v0'})).rejects.toMatchObject({code:'QUOTE_UNAVAILABLE'});f.table.data[60]=original;
 }));
 it('requires authentic setup finality before signing and delivering the exact original second packet',async()=>fixture(async f=>{
  const request={wallet:f.wallet,claimId:f.prepared.claimId,ordinal:1},review=createMiningClaimReview(f.conn.db,f.provider);
  await expect(review(request)).rejects.toMatchObject({code:'SETUP_REQUIRED'});
  const setup=await f.execute(f.prepared,0);expect(setup.payment).toBe(0n);expect(setup.outcome).toHaveProperty('receipt.kind','setup');
  const ready=await review(request);expect(ready.setup?.signature).toBe(setup.signed.signature);expect(ready.currentSigningAuthorized).toBe(false);
  await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.prepared.claimId,signedTransaction:f.sign(f.prepared,1)});
  const admitted=await createMiningClaimAdmission(f.conn.db,f.provider)(request);expect(admitted.snapshotSlot).toBeGreaterThanOrEqual(setup.tx.slot);
  const paid=await f.execute(f.prepared,1);expect(paid.payment).toBeGreaterThan(0n);expect(paid.outcome).toHaveProperty('receipt.paidKeepBaseUnits',paid.payment.toString());
  await expect(createMiningClaimContinuation(f.conn.db,f.provider)({wallet:f.wallet,claimId:f.prepared.claimId},{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('atomically continues unsigned expiry once, retains late parent custody, and recovers ancestor setup across another expired child',async()=>fixture(async f=>{
  await f.execute(f.prepared,0);const k={wallet:f.wallet,claimId:f.prepared.claimId},next=createMiningClaimContinuation(f.conn.db,f.provider),request={idempotencyKey:randomUUID()};
  await expect(next(k,request)).rejects.toMatchObject({code:'NOT_EXPIRED'});f.advance();
  const independent=createDb(f.url.toString(),{max:2});let a:Awaited<ReturnType<typeof next>>;
  try{const results=await Promise.all([next(k,request),createMiningClaimContinuation(independent.db,f.provider)(k,request)]);a=results[0];expect(a).toEqual(results[1]);}finally{await independent.sql.end();}
  expect(a.reason).toBe('unsigned-expired');expect(a.childPreparation.transactions).toHaveLength(1);
  await expect(next(k,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'REQUEST_CONFLICT'});
  await acceptMiningClaimSigned(f.conn.db,{...k,signedTransaction:f.sign(f.prepared,1)});await expect(createMiningClaimAdmission(f.conn.db,f.provider)({...k,ordinal:1})).rejects.toMatchObject({code:'CONTINUED'});
  await f.execute(f.prepared,1,true);const afterLateFailure=await getMiningClaimContinuation(f.conn.db,k);expect(afterLateFailure?.childClaimId).toBe(a.childClaimId);expect(afterLateFailure?.reason).toBe('unsigned-expired');expect(afterLateFailure?.failure).toBeNull();
  const child=await getMiningClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:request.idempotencyKey});if(!child)throw Error('Missing child');
  expect((await createMiningClaimReview(f.conn.db,f.provider)({wallet:f.wallet,claimId:child.claimId,ordinal:0})).setup?.claimId).toBe(f.prepared.claimId);
  f.advance();const second=await next({wallet:f.wallet,claimId:child.claimId},{idempotencyKey:randomUUID()});expect(second.setup.claimId).toBe(f.prepared.claimId);
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');expect((await getMiningClaimContinuation(f.conn.db,k))?.childClaimId).toBe(child.claimId);
  await expect(f.conn.sql`delete from mining_claim_continuations`).rejects.toThrow('MINING_CLAIM_CONTINUATION_IMMUTABLE');
 }));
 it('serializes late parent custody ahead of an independently quoted child without saving an orphan',async()=>fixture(async f=>{
  await f.execute(f.prepared,0);f.advance();const k={wallet:f.wallet,claimId:f.prepared.claimId},request={idempotencyKey:randomUUID()},independent=createDb(f.url.toString(),{max:2});
  let quoted!:()=>void;const quoteReached=new Promise<void>(resolve=>{quoted=resolve;});
  const sources={...f.provider,quoteSource:(signal:AbortSignal)=>{const rpc=f.provider.quoteSource(signal);return {...rpc,getLatestBlockhashAndContext:async(options:Parameters<typeof rpc.getLatestBlockhashAndContext>[0])=>{const result=await rpc.getLatestBlockhashAndContext(options);quoted();return result;}};}};
  let attempt!:Promise<unknown>;
  try{
   await f.conn.db.transaction(async tx=>{
    await tx.execute(sql`select shardkeep_mining_claim_continuation_lock(${k.claimId}::uuid)`);
    await acceptMiningClaimSigned(tx,{...k,signedTransaction:f.sign(f.prepared,1)});
    attempt=createMiningClaimContinuation(independent.db,sources)(k,request).then(()=>{throw Error('Unknown signed parent incorrectly replaced');},error=>{expect(error).toMatchObject({code:'PARENT_SIGNED'});});
    await quoteReached;
   });
   await attempt;expect(await getMiningClaimContinuation(f.conn.db,k)).toBeNull();expect(await getMiningClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:request.idempotencyKey})).toBeNull();expect((await f.read())?.wires).toHaveLength(2);
  }finally{await independent.sql.end();}
 }));
 it('never replaces an unknown signed remainder, but uses a verified failed remainder for one fresh explicit child',async()=>fixture(async f=>{
  await f.execute(f.prepared,0);const k={wallet:f.wallet,claimId:f.prepared.claimId},next=createMiningClaimContinuation(f.conn.db,f.provider);
  await acceptMiningClaimSigned(f.conn.db,{...k,signedTransaction:f.sign(f.prepared,1)});f.advance();
  await expect(next(k,{idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'PARENT_SIGNED'});
  const failed=await f.execute(f.prepared,1,true),link=await next(k,{idempotencyKey:randomUUID()});expect(link.reason).toBe('failed');expect(link.failure?.signature).toBe(failed.signed.signature);
  const child=await getMiningClaimPreparation(f.conn.db,{wallet:f.wallet,idempotencyKey:link.childPreparation.idempotencyKey});if(!child)throw Error('Missing child');
  const paid=await f.execute(child,0);expect(paid.payment).toBeGreaterThan(0n);expect((await f.read())?.wires).toHaveLength(2);expect(link.setup.claimId).toBe(f.prepared.claimId);
 }));
 it('SQL preserves exact source, format and immutable ancestry even with broad direct table grants',async()=>fixture(async f=>{
  const bad={...f.prepared,claimId:randomUUID(),idempotencyKey:randomUUID(),format:null};
  await expect(f.conn.sql`insert into mining_claim_preparations(artifact) values(${JSON.stringify(bad)}::jsonb)`).rejects.toThrow('MINING_CLAIM_PREPARATION_FORMAT');
  const changed={...f.prepared,claimId:randomUUID(),idempotencyKey:randomUUID(),header:{...f.prepared.header,leafCount:10001}};
  await expect(f.conn.sql`insert into mining_claim_preparations(artifact) values(${JSON.stringify(changed)}::jsonb)`).rejects.toThrow('MINING_CLAIM_PREPARATION_SOURCE');
  await expect(f.conn.sql`insert into mining_claim_continuations(parent_claim_id,child_claim_id,reason,expiry_height,expiry_slot) values(${f.prepared.claimId},${f.prepared.claimId},'unsigned-expired',9000,9000)`).rejects.toThrow('MINING_CLAIM_CONTINUATION_PARENT');
  expect(await getMiningClaimContinuation(f.conn.db,{wallet:f.buyer,claimId:f.prepared.claimId})).toBeNull();
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`select shardkeep_mining_claim_continuation_lock(${f.prepared.claimId}::uuid)`;})).rejects.toThrow('MINING_CLAIM_CONTINUATION_READ_COMMITTED');
 }));
});

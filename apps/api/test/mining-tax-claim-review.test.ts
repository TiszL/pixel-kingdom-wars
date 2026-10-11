/** Fresh pre-wallet assessment of a durable original artifact, never consent. */
import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {Db} from '../src/db/client';
import {acceptMiningTaxClaimSigned,getMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {getMiningTaxClaimPreparation} from '../src/mining/taxClaimPreparationStore';
import {createMiningTaxClaimAdmission} from '../src/mining/taxClaimAdmission';
import {createMiningTaxClaimReview} from '../src/mining/taxClaimReview';
import {withMiningTaxAdmissionFixture as fixture,type MiningTaxAdmissionFixture} from './fixtures/miningTaxAdmission';

const active=()=>{vi.stubEnv('PHASE_E_MINING_ENABLED','true');vi.stubEnv('PHASE_E_SEEKER_ENABLED','false');};
const lookup=(f:MiningTaxAdmissionFixture)=>({wallet:f.wallet,idempotencyKey:f.key.idempotencyKey});
afterEach(()=>vi.unstubAllEnvs());
describe('unsigned original KEEP tax review',()=>{
 it.each(['claim','combined','split'] as const)('reviews actual %s before any signed custody and preserves its original bytes and expiry',mode=>fixture(async f=>{
  active();const a=f.record.artifact,review=createMiningTaxClaimReview(f.conn.db,f.sources),before=await getMiningTaxClaimPreparation(f.conn.db,lookup(f));
  const result=await review(f.key);
  expect(result).toEqual({...f.key,status:'ready',claimId:a.claimId,messageSha256:a.transactions[0]!.messageSha256,blockhash:a.blockhash,preparedAt:a.preparedAt,expiresAt:a.expiresAt,observedAt:f.control.now.toISOString(),
   feeLamports:5n,rentLamports:BigInt(a.transactions[0]!.rentLamports),totalLamports:5n+BigInt(a.transactions[0]!.rentLamports),paidFeeLamports:0n,paidRentLamports:0n,
   source:{genesisHash:a.source.genesisHash,programId:a.source.programId,reviewedDeploymentSlot:a.source.reviewedDeploymentSlot,reviewedProgramDataSha256:a.source.reviewedProgramDataSha256,
    snapshotSlot:f.control.slot,feeSlot:f.control.slot,blockHeight:f.control.height,lastValidBlockHeight:a.lastValidBlockHeight},currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false});
  expect(Object.isFrozen(result)).toBe(true);expect(Object.isFrozen(result.source)).toBe(true);
  expect(f.calls.messages).toContain(a.transactions[0]!.messageHex);expect(f.control.blockhash).not.toBe(a.blockhash);
  expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toEqual([]);expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
  expect(await getMiningTaxClaimPreparation(f.conn.db,lookup(f))).toEqual(before);
  const reads=f.calls.connect;await expect(createMiningTaxClaimAdmission(f.conn.db,f.sources)(f.key)).rejects.toMatchObject({code:'NOT_SIGNED'});expect(f.calls.connect).toBe(reads);
 },{mode,persistSigned:false}));
 it('requires only the signed verified setup prefix before reviewing an unsigned ordinal1',()=>fixture(async f=>{
  active();const review=createMiningTaxClaimReview(f.conn.db,f.sources),key={...f.key,ordinal:1};await f.stage('setup');
  await expect(review(key)).rejects.toMatchObject({code:'SETUP_REQUIRED'});expect(f.calls.connect).toBe(0);
  await acceptMiningTaxClaimSigned(f.conn.db,{...lookup(f),signedTransaction:f.wire(0)});await f.verifySetup(6);
  await expect(review(key)).rejects.toMatchObject({code:'COST_CAP'});f.control.fee=4;
  expect(await review(key)).toMatchObject({...key,status:'ready',messageSha256:f.record.artifact.transactions[1]!.messageSha256,paidFeeLamports:6n,paidRentLamports:1000n,feeLamports:4n,rentLamports:0n,totalLamports:4n});
  expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires.map(w=>w.ordinal)).toEqual([0]);
  await expect(createMiningTaxClaimAdmission(f.conn.db,f.sources)(key)).rejects.toMatchObject({code:'NOT_SIGNED'});
 },{mode:'split',persistSigned:false}));
 it('uses SELECT-only runtime permission and cannot create a replacement preparation or signature',()=>fixture(async f=>{
  active();const role=`tax_review_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on all tables in schema public to ${role}`);
  try{await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await createMiningTaxClaimReview(tx as unknown as Db,f.sources)(f.key)).toMatchObject({status:'ready'});});}
  finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
  expect(await f.conn.sql`select * from mining_tax_claim_preparations`).toHaveLength(1);expect(await f.conn.sql`select * from mining_tax_claim_signed_wires`).toHaveLength(0);expect(await f.conn.sql`select * from mining_tax_claim_receipts`).toHaveLength(0);
 },{persistSigned:false}));
 it('requires durable actor/key/ordinal and rejects injected authority before connecting',()=>fixture(async f=>{
  active();const review=createMiningTaxClaimReview(f.conn.db,f.sources);
  for(const key of [{...f.key,wallet:f.buyer},{...f.key,idempotencyKey:randomUUID()}])await expect(review(key)).rejects.toMatchObject({code:'NOT_PREPARED'});
  await expect(review({...f.key,ordinal:1})).rejects.toMatchObject({code:'NOT_PREPARED'});
  for(const key of [{...f.key,ordinal:2},{...f.key,signingAuthorized:true},{...f.key,[Symbol('authority')]:true}])await expect(review(key)).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(f.calls.connect).toBe(0);
 },{persistSigned:false}));
 it('holds when a fresh plan no longer matches the saved original setup message',()=>fixture(async f=>{
  active();await f.stage('setup');await expect(createMiningTaxClaimReview(f.conn.db,f.sources)(f.key)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toHaveLength(0);
 },{mode:'combined',persistSigned:false}));
 it.each(['fee','rent','source','old-height','expired-height'] as const)('refuses changed %s before a wallet can approve',kind=>fixture(async f=>{
  active();if(kind==='fee')f.control.fee=11;if(kind==='rent')f.control.rent=1001;if(kind==='source')f.rpc.getGenesisHash=async()=>f.buyer;
  if(kind==='old-height')f.control.height=f.record.artifact.blockHeight-1;if(kind==='expired-height')f.control.height=f.record.artifact.lastValidBlockHeight+1;
  await expect(createMiningTaxClaimReview(f.conn.db,f.sources)(f.key)).rejects.toThrow();expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toHaveLength(0);
 },{mode:'combined',persistSigned:false}));
 it.each(['pause','expiry'] as const)('rechecks %s after original-message measurement without refreshing saved consent',kind=>fixture(async f=>{
  active();const a=f.record.artifact;f.control.afterFee=async message=>{if(Buffer.from(message.serialize()).toString('hex')===a.transactions[0]!.messageHex){if(kind==='pause')vi.stubEnv('PHASE_E_MINING_ENABLED','false');else f.control.now=new Date(a.expiresAt);}};
  await expect(createMiningTaxClaimReview(f.conn.db,f.sources)(f.key)).rejects.toMatchObject({code:kind==='pause'?'DISABLED':'EXPIRED'});
  expect((await getMiningTaxClaimPreparation(f.conn.db,lookup(f)))!.expiresAt).toBe(a.expiresAt);expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toHaveLength(0);
 },{persistSigned:false}));
 it('timestamps the final validated observation and cannot reuse it as another assessment',()=>fixture(async f=>{
  active();const start=new Date(f.control.now),review=createMiningTaxClaimReview(f.conn.db,f.sources);f.control.afterFee=async()=>{f.control.now=new Date(+start+1000);};
  expect((await review(f.key)).observedAt).toBe(f.control.now.toISOString());const calls=f.calls.connect;f.control.fee=11;
  await expect(review(f.key)).rejects.toThrow();expect(f.calls.connect).toBeGreaterThan(calls);
 },{persistSigned:false}));
 it('copies policy and input before DB awaits and holds when either source or current clock is unavailable',()=>fixture(async f=>{
  active();const trust={mining:{...f.sources.trust.mining},seeker:{...f.sources.trust.seeker,deployment:{...f.sources.trust.seeker.deployment}}},sources={...f.sources,trust},review=createMiningTaxClaimReview(f.conn.db,sources);
  trust.mining.keepMint=Keypair.generate().publicKey;trust.seeker.deployment.programDataSha256='00'.repeat(32);sources.connect=()=>{throw Error('replaced');};
  const key={...f.key},pending=review(key);key.wallet=f.buyer;key.ordinal=1;expect(await pending).toMatchObject(f.key);
  await expect(createMiningTaxClaimReview(f.conn.db,{...f.sources,connect:()=>{throw Error('offline');}})(f.key)).rejects.toThrow();
  await expect(createMiningTaxClaimReview(f.conn.db,{...f.sources,now:()=>new Date(Number.NaN)})(f.key)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 },{persistSigned:false}));
 it('retains an unsigned timeout until its concrete ignored-abort read drains',()=>fixture(async f=>{
  active();const original=f.rpc.getGenesisHash;let release!:(value:string)=>void,entered!:()=>void,calls=0;const began=new Promise<void>(resolve=>{entered=resolve;});
  f.rpc.getGenesisHash=()=>{calls++;entered();return new Promise(resolve=>{release=resolve;});};
  // The timeout boundary is fixture-controlled; real signature verification
  // after drain must not race this deliberately short transport deadline.
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  try{
   const review=createMiningTaxClaimReview(f.conn.db,{...f.sources,timeoutMs:1000}),pending=expect(review(f.key)).rejects.toMatchObject({code:'TIMEOUT'});await began;
   await vi.advanceTimersByTimeAsync(1000);await pending;
   await expect(review(f.key)).rejects.toMatchObject({code:'TIMEOUT'});expect(calls).toBe(1);release(f.record.artifact.source.genesisHash);
   await vi.advanceTimersByTimeAsync(0);f.rpc.getGenesisHash=original;
   expect(await review(f.key)).toMatchObject({status:'ready'});expect((await getMiningTaxClaimSigned(f.conn.db,lookup(f)))!.wires).toHaveLength(0);
  }finally{vi.useRealTimers();}
 },{persistSigned:false}));
});

import {randomUUID} from 'node:crypto';
import {Keypair} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {describe,expect,it,vi} from 'vitest';
import type {DbOrTx} from '../src/db/client';
import {getOrCreatePlayerAccount,postTransaction} from '../src/ledger';
import {spendGems,refundPostedSpend} from '../src/game/spend';
import {convertGemsToShards} from '../src/game/gems';
import {readGemsNoDebitEvidence,replayGemsNoDebitEvidence,type GemsNoDebitEvidence} from '../src/mining/gemsNoDebitEvidence';
import * as baselineSource from '../src/mining/existingMiningWallet';
import {withExistingMiningWalletFixture} from './fixtures/existingMiningWallet';

type Fixture=Parameters<Parameters<typeof withExistingMiningWalletFixture>[0]>[0];
const request=(f:Fixture,id:string,day='2020-01-04')=>({wallet:f.wallet,baselineId:id,day});
async function unknownCredit(f:Fixture,db:DbOrTx,wallet:string,gemsId:string,amount:bigint,metadata:Record<string,unknown>={}){
 const keep=await getOrCreatePlayerAccount(db,wallet,'player_keep');
 await postTransaction(db,{idempotencyKey:randomUUID(),type:'fixture.keep.funding',entries:[{account:f.sys.keep_genesis,delta:-amount},{account:keep.id,delta:amount}]});
 return postTransaction(db,{idempotencyKey:randomUUID(),type:'fixture.unknown.credit',metadata,entries:[{account:keep.id,delta:-amount},{account:f.sys.emission_pool,delta:amount},{account:f.sys.gems_mint,delta:-amount},{account:gemsId,delta:amount}]});
}
const credit=(f:Fixture,amount=7n,metadata:Record<string,unknown>={})=>unknownCredit(f,f.conn.db,f.wallet,f.gems.id,amount,metadata);
const clone=(value:GemsNoDebitEvidence):GemsNoDebitEvidence=>JSON.parse(JSON.stringify(value));

describe('committed existing-wallet no-debit source',()=>{
 it('keeps nonzero opening and credit origins unknown while isolating prior and future day debits',async()=>withExistingMiningWalletFixture(async f=>{
  await f.clock('2020-01-02T12:00:00Z');await spendGems(f.conn.db,f.wallet,2n,'fixture.historical.spend',randomUUID());
  const b=await f.capture();await f.clock('2020-01-04T12:00:00.000001Z');await credit(f,7n,{unclassified:'origin remains unknown'});await f.close();
  const proof=await readGemsNoDebitEvidence(f.conn.db,request(f,b.id));
  expect(proof).toMatchObject({sourceKind:'committed-existing-wallet-no-debit',openingGems:'unknown',creditOrigins:'unknown',debitCount:0,contribution:'0',eligibilityAuthorized:false,allocationAuthorized:false,publicationAuthorized:false});
  expect(proof.identity.baseline).toEqual(b);expect(proof.facts).toHaveLength(2);expect('zeroQualifyingCredit'in proof).toBe(false);expect('birthEventId'in proof).toBe(false);expect('netGems'in proof).toBe(false);
  expect((await f.conn.sql`select balance::text balance from accounts where id=${f.gems.id}`)[0]?.balance).toBe('55');
  expect(replayGemsNoDebitEvidence(JSON.parse(JSON.stringify(proof)))).toEqual(proof);expect(Object.isFrozen(proof.facts[0]?.source)).toBe(true);
  await f.clock('2020-01-05T12:00:00Z');await spendGems(f.conn.db,f.wallet,1n,'fixture.future.spend',randomUUID());await f.clock('2020-01-06T00:00:00Z');
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');const later=await readGemsNoDebitEvidence(f.conn.db,request(f,b.id));expect(later.contribution).toBe('0');expect(later.facts).toHaveLength(3);
 }));

 it('holds every in-day debit even when net-positive, fully refunded or excluded from useful spend',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture();await f.clock('2020-01-04T12:00:00Z');const spent=await spendGems(f.conn.db,f.wallet,3n,'fixture.use',randomUUID());
  await refundPostedSpend(f.conn.db,spent,randomUUID(),'fixture.use.system_refund',{originalTxnId:spent.transaction.id});await credit(f,10n);await f.close();
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'DEBIT_PRESENT'});
  await f.clock('2020-01-05T12:00:00Z');await convertGemsToShards(f.conn.db,f.wallet,2n,randomUUID());await f.clock('2020-01-06T00:00:00Z');
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id,'2020-01-05'))).rejects.toMatchObject({code:'DEBIT_PRESENT'});
 }));

 it('includes a pre-day debit completed by another wallet and holds the earlier cross-cutoff group',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture(),other=await getOrCreatePlayerAccount(f.conn.db,f.buyer,'player_gems');
  await f.clock('2020-01-04T23:59:59.999999Z');await f.conn.db.transaction(async tx=>{
   await spendGems(tx,f.wallet,1n,'fixture.midnight',randomUUID());await f.clock('2020-01-05T00:00:00.000001Z');
   await unknownCredit(f,tx,f.buyer,other.id,1n);
  });await f.clock('2020-01-06T00:00:00Z');
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id,'2020-01-05'))).rejects.toMatchObject({code:'DEBIT_PRESENT'});
 }));

 it('refuses later and out-and-back transaction mutations without changing retained source bytes',async()=>withExistingMiningWalletFixture(async f=>{
  await f.clock('2020-01-02T12:00:00Z');const prior=await spendGems(f.conn.db,f.wallet,1n,'fixture.prior.spend',randomUUID());
  const b=await f.capture();await f.close();const proof=await readGemsNoDebitEvidence(f.conn.db,request(f,b.id));
  await f.clock('2020-01-05T12:00:00Z');await f.conn.sql`update ledger_transactions set type='changed' where id=${prior.transaction.id}`;
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await f.conn.sql`update ledger_transactions set type='fixture.prior.spend' where id=${prior.transaction.id}`;
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  expect(replayGemsNoDebitEvidence(proof)).toEqual(proof);
 }));

 it('strictly replays exact identity, day, source rows, complete balanced receipts and immutable unknown-origin claims',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture();await f.clock('2020-01-04T12:00:00Z');await credit(f);await f.close();const proof=await readGemsNoDebitEvidence(f.conn.db,request(f,b.id));
  const cases:Array<(p:GemsNoDebitEvidence)=>void>=[
   p=>{p.wallet=Keypair.generate().publicKey.toBase58();},p=>{p.baselineId=randomUUID();},p=>{p.day='2020-01-03';},p=>{p.identity.baseline.sourceSeal='0'.repeat(64);},
   p=>{p.facts=[];},p=>{p.groupRows=[];},p=>{p.groupRows[0]!.wallet=Keypair.generate().publicKey.toBase58();},p=>{p.groupRows[0]!.observedAt='2020-01-04T12:00:00.00001Z';},
   p=>{Object.assign(p.facts[0]!,{receiptComplete:false});},p=>{Object.assign(p.groupRows[0]!,{receiptComplete:false});},p=>{p.facts[0]!.before={};},
   p=>{p.facts[0]!.receipt[0]!.delta='-8';},p=>{p.facts[0]!.accountId=randomUUID();},p=>{p.facts[0]!.transactionId=randomUUID();},
   p=>{(p.facts[0]!.source as {entry:{delta:string}}).entry.delta='0';},p=>{p.facts[0]!.sourceTable='ledger_transactions';},
   p=>{(p as unknown as Record<string,unknown>).zeroQualifyingCredit=true;},p=>{(p as unknown as Record<string,unknown>).openingGems='0';},p=>{p.sourceRowsSha256='0'.repeat(64);},
  ];for(const change of cases){const mutated=clone(proof);change(mutated);expect(()=>replayGemsNoDebitEvidence(mutated)).toThrow();}
  const getter=vi.fn(()=>proof.facts[0]);const accessor=clone(proof);Object.defineProperty(accessor.facts,'0',{get:getter,enumerable:true});expect(()=>replayGemsNoDebitEvidence(accessor)).toThrow();expect(getter).not.toHaveBeenCalled();
  const cycle=clone(proof);(cycle.facts[0]!.source as Record<string,unknown>).cycle=cycle;expect(()=>replayGemsNoDebitEvidence(cycle)).toThrow();
 }));

 it('refuses unclosed posting groups instead of inferring a complete no-debit day',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture();await f.clock('2020-01-04T12:00:00Z');const txId=randomUUID();
  await f.conn.sql`insert into ledger_transactions(id,idempotency_key,type,metadata) values(${txId},${randomUUID()},'fixture.incomplete','{}')`;
  await f.conn.sql`insert into ledger_entries(txn_id,account_id,delta,balance_after) values(${txId},${f.gems.id},1,51)`;await f.close();
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));

 it('refuses post-baseline backdating at microsecond precision even before the requested day',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture();await f.clock('2020-01-03T11:59:59.999999Z');await credit(f);await f.close();
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));

 it('holds open days, mismatched baselines, source contention, stale transactions and disabled source guards',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture();await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'DAY_OPEN'});await f.close();
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,randomUUID()))).rejects.toMatchObject({code:'COVERAGE_UNAVAILABLE'});
  let release!:()=>void,ready!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>ready=r);
  const writer=f.conn.sql.begin(async tx=>{await tx`lock table ledger_entries in row exclusive mode`;ready();await gate;});try{await started;await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'BUSY'});}finally{release();await writer;}
  await expect(f.conn.db.transaction(async tx=>{await tx.execute(sql`set transaction isolation level repeatable read`);await readGemsNoDebitEvidence(tx as unknown as Parameters<typeof readGemsNoDebitEvidence>[0],request(f,b.id));})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await f.conn.sql`alter table ledger_entries disable trigger ledger_entries_mining_gems_flow_capture`;
  await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'SOURCE_UNAVAILABLE'});
 }));

 it('bounds candidate and global-group reads before row decoding, and rejects oversized live metadata',async()=>withExistingMiningWalletFixture(async f=>{
  const b=await f.capture();await f.close();const proof=await readGemsNoDebitEvidence(f.conn.db,request(f,b.id)),dialect=new PgDialect();
  // The authentic baseline is reused only to isolate SQL resource preflight;
  // these fake DB results are never accepted as live source evidence.
  const source=vi.spyOn(baselineSource,'readExistingMiningWalletIntervalInTransaction').mockResolvedValue(proof.identity);
  try{for(const overflow of ['wallet','groups']){const queries:string[]=[];const fake={transaction:async(run:(tx:unknown)=>Promise<unknown>)=>run({execute:async(statement:Parameters<PgDialect['sqlToQuery']>[0])=>{
   const query=dialect.sqlToQuery(statement).sql;queries.push(query);if(query.includes('bounded_wallet'))return [{n:overflow==='wallet'?10001:1,bytes:'1',largest:'1'}];if(query.includes('bounded_groups'))return [{n:10001}];throw Error('decoded source rows before size refusal');
  }})} as unknown as Parameters<typeof readGemsNoDebitEvidence>[0];await expect(readGemsNoDebitEvidence(fake,request(f,b.id))).rejects.toMatchObject({code:'TOO_LARGE'});expect(queries.some(q=>q.includes('jsonb_build_object'))).toBe(false);if(overflow==='wallet')expect(queries.some(q=>q.includes('join markers'))).toBe(false);}}finally{source.mockRestore();}
  await f.clock('2020-01-04T12:00:00Z');await credit(f,1n,{payload:'x'.repeat(1_048_577)});await f.close();await expect(readGemsNoDebitEvidence(f.conn.db,request(f,b.id))).rejects.toMatchObject({code:'TOO_LARGE'});
 }));
});

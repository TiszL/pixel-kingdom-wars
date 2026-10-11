import { describe,it,expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createMiningPublicationReceiptVerifier } from './miningPublicationReceipt';
import { createMiningPublicationFixture as fixture } from './testFixtures/miningPublication';
const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n));
describe('original finalized mining publication receipts',()=>{
 it.each(['legacy',0] as const)('binds real signed %s messages, immutable epoch and exact recycle',async version=>{
  const f=await fixture(version),r=await createMiningPublicationReceiptVerifier(f.reader,f.trusted)(f.request);
  expect(r).toMatchObject({signature:f.request.signature,day:100n,sequence:1n,playerNet:80n,tax:10n,recycle:10n,currentClaimsAuthorized:false,scoreFairnessVerified:false});
  expect(r.originalMessageSha256).toMatch(/^[0-9a-f]{64}$/);expect(Object.isFrozen(r)).toBe(true);
 });
 it('keeps original funding valid after claims, publisher rotation and root revocation',async()=>{
  const f=await fixture();Object.assign(f.models[0]!,{publisher:pk(21),latest_sequence:3n,total_published:0n,total_claimed:60n,correction_pending:true});Object.assign(f.models[2]!,{revoked:true,claims_count:3n});await f.encode(0);await f.encode(2);
  expect((await createMiningPublicationReceiptVerifier(f.reader,f.trusted)(f.request)).playerNet).toBe(80n);
 });
 it('refuses publication in the deployment slot even with the matching reviewed binary hash',async()=>{
  const f=await fixture();f.trusted.reviewedDeploymentSlot=f.tx.slot;
  f.accounts[4]!.data.writeBigUInt64LE(BigInt(f.tx.slot),4);
  f.trusted.reviewedProgramDataSha256=createHash('sha256').update(f.accounts[4]!.data).digest('hex');
  await expect(createMiningPublicationReceiptVerifier(f.reader,f.trusted)(f.request)).rejects.toThrow(/Mining publication receipt refused/);
 });
 it.each(['signature','message','failed','missing','version','genesis','deployment','upgrade','binary','context','account','source','root','net','recycle','owner','inner'] as const)('refuses %s contradiction instead of authorizing custody',async kind=>{
  const f=await fixture(0);
  if(kind==='signature')f.tx.transaction.signatures[0]=bs58.encode(Buffer.alloc(64,7));
  if(kind==='message')f.tx.transaction.message.recentBlockhash=pk(11).toBase58();
  if(kind==='failed')f.tx.meta!.err={InstructionError:[0,'Custom']};
  if(kind==='missing')f.reader.getTransaction=async()=>null;
  if(kind==='version')Object.assign(f.tx,{version:1});
  if(kind==='genesis')f.reader.getGenesisHash=async()=>pk(11).toBase58();
  if(kind==='deployment')f.trusted.reviewedDeploymentSlot=101;
  if(kind==='upgrade')f.accounts[4]!.data.writeBigUInt64LE(91n,4);
  if(kind==='binary')f.accounts[4]!.data[49]=8;
  if(kind==='context')f.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot:99},value:f.accounts});
  if(kind==='account')f.accounts[1]!.owner=pk(11);
  if(kind==='source'){Object.assign(f.models[1]!,{source_hash:Buffer.alloc(32,11)});await f.encode(1);}
  if(kind==='root'){Object.assign(f.models[2]!,{total_cumulative:81n});await f.encode(2);}
  if(kind==='net'){Object.assign(f.models[1]!,{player_net:79n,tax:11n});await f.encode(1);}
  if(kind==='recycle')f.tx.meta!.postTokenBalances![0]!.uiTokenAmount.amount='89';
  if(kind==='owner')f.tx.meta!.preTokenBalances![0]!.owner=pk(11).toBase58();
  if(kind==='inner')f.tx.meta!.innerInstructions![0]!.instructions=[];
  await expect(createMiningPublicationReceiptVerifier(f.reader,f.trusted)(f.request)).rejects.toThrow(/Mining publication receipt refused/);
 });
 it('snapshots request bytes and expected fields before the first asynchronous read',async()=>{
  const f=await fixture();f.reader.getGenesisHash=async()=>{f.request.args.sourceHash.fill(19);f.request.signedTransaction.fill(0);return f.trusted.expectedGenesisHash;};
  expect((await createMiningPublicationReceiptVerifier(f.reader,f.trusted)(f.request)).sourceHash).toBe(Buffer.alloc(32,4).toString('hex'));
 });
});

import { createHash,randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair,Message,PublicKey,VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { sql } from 'drizzle-orm';
import { describe,it,expect,vi } from 'vitest';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { createMiningClaimReceiptVerifier } from '@shardkeep/chain/mining-claim-receipt';
import { createDb } from '../src/db/client';
import { createMiningClaimSettlement,getMiningClaimSettlement } from '../src/mining/claimSettlement';
import { acceptMiningClaimSigned } from '../src/mining/claimSignedStore';
import { withMiningClaimSettlementFixture as fixture } from './fixtures/miningClaimSettlement';
describe('immutable verified mining claim success receipts',()=>{
 it.each(['leading-zero','high-byte'] as const)('binds the exact64-byte %s signature through PostgreSQL base58 validation',async shape=>fixture(async f=>{
  // Search only disposable candidate blockhashes before the actual new quote.
  // Both the accepted wire and its receipt still use the real B3f preparer.
  const message=Message.from(Buffer.from(f.preparedClaim.transactions[0]!.messageHex,'hex'));
  let candidate:VersionedTransaction|undefined;
  for(let i=0;i<65_536;i++){
   message.recentBlockhash=new PublicKey(createHash('sha256').update(`claim-signature-boundary:${i}`).digest()).toBase58();
   const tx=new VersionedTransaction(message);tx.sign([f.claimantSigner]);const first=tx.signatures[0]![0]!;
   if(shape==='leading-zero'?first===0:first>=128){candidate=tx;break;}
  }
  if(!candidate)throw Error('Bounded signature fixture search exhausted');
  const chosen=candidate,blockhash=message.recentBlockhash;
  f.quote.reader.getLatestBlockhashAndContext=async()=>({context:{slot:3004},value:{blockhash,lastValidBlockHeight:250}});
  f.quote.reader.getFeeForMessage=async()=>({context:{slot:3005},value:5000});f.quote.reader.getSlot=async()=>3005;
  const preparation=await f.claimService.prepare(f.wallet,{idempotencyKey:randomUUID()});expect(preparation.transactions[0]!.messageHex).toBe(Buffer.from(message.serialize()).toString('hex'));
  const signed=await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:preparation.claimId,signedTransaction:chosen.serialize()});
  const tx={...f.tx,transaction:{message,signatures:[signed.signature]}};
  const receipt=await createMiningClaimSettlement(f.conn.db,{reader:{...f.receiptReader,getTransaction:async()=>tx},trust:f.trust})({wallet:f.wallet,claimId:preparation.claimId,ordinal:0});
  expect(receipt.signature).toBe(bs58.encode(chosen.signatures[0]!));expect(bs58.decode(receipt.signature)).toEqual(chosen.signatures[0]);
  expect(shape==='leading-zero'?receipt.signature.startsWith('1'):bs58.decode(receipt.signature)[0]!>=128).toBe(true);
 }));
 it('settles actual combined setup/payment once and recovers while paused/offline after reconnect',async()=>fixture(async f=>{
  const k={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},settle=createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.receiptTrust});
  expect(await getMiningClaimSettlement(f.conn.db,k)).toBeNull();const result=await settle(k);expect(result).toMatchObject({...k,signature:f.signed.signature,claimFinalized:true,receipt:{kind:'combined',paidKeepBaseUnits:String(f.payment),currentClaimedTotal:String(f.payment),slot:3004,observedAccountSlot:3005,currentClaimsAuthorized:false}});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');f.receiptReader.getTransaction=async()=>{throw Error('offline');};expect(await settle(k)).toEqual(result);
  const c=createDb(f.url.toString());try{expect(await getMiningClaimSettlement(c.db,k)).toEqual(result);}finally{await c.sql.end();}
  expect(await getMiningClaimSettlement(f.conn.db,{...k,wallet:f.buyer})).toBeNull();expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(1);
 }));
 it('leaves missing and contradictory transaction evidence unpersisted',async()=>fixture(async f=>{
  const k={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},settle=createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.receiptTrust});
  f.receiptReader.getTransaction=async()=>null;await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_UNAVAILABLE'});f.receiptReader.getTransaction=async()=>f.tx;
  const owner=f.tx.meta!.postTokenBalances![1]!.owner;if(typeof owner!=='string')throw Error('Fixture owner missing');f.tx.meta!.postTokenBalances![1]!.owner=Keypair.generate().publicKey.toBase58();await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});f.tx.meta!.postTokenBalances![1]!.owner=owner;
  const amount=f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount;f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount='0';await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});f.tx.meta!.postTokenBalances![1]!.uiTokenAmount.amount=amount;
  const ix=f.tx.meta!.innerInstructions!.at(-1)!.instructions[0]!;Object.assign(ix,{stackHeight:3});await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});Object.assign(ix,{stackHeight:2});
  f.tx.slot=3000;await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});f.tx.slot=3004;
  f.receiptRows[9]!.data[8]=f.receiptRows[9]!.data[8]!^1;await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_CONFLICT'});
  expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 }));
 it('serializes concurrent successful observations and preserves the first receipt',async()=>fixture(async f=>{
  const k={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},options={reader:f.receiptReader,trust:f.receiptTrust};const [a,b]=await Promise.all([createMiningClaimSettlement(f.conn.db,options)(k),createMiningClaimSettlement(f.conn.db,options)(k)]);expect(a).toEqual(b);expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(1);
 }));
 it('does not persist a late timeout result and holds its pending source slot until drain',async()=>fixture(async f=>{
  const k={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0};let resolve!:(tx:typeof f.tx)=>void,calls=0;const held=new Promise<typeof f.tx>(r=>{resolve=r;});f.receiptReader.getTransaction=()=>{calls++;return held;};const settle=createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.receiptTrust,timeoutMs:30});
  await expect(settle(k)).rejects.toMatchObject({code:'TIMEOUT'});await expect(settle(k)).rejects.toMatchObject({code:'BUSY'});expect(calls).toBe(1);f.receiptReader.getTransaction=async()=>null;resolve(f.tx);
  await vi.waitFor(async()=>{await expect(settle(k)).rejects.toMatchObject({code:'RECEIPT_UNAVAILABLE'});});
  expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
 }));
 it('refuses a first canonical fake runtime receipt for an unlanded signed claim, while retaining runtime replay',async()=>fixture(async f=>{
  const k={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},a=f.preparedClaim,h=a.header;
  f.receiptReader.getTransaction=async()=>null;
  // Deliberately fabricated successful RPC evidence supplies a fully canonical
  // attack payload. The application's actual trusted reader reports no landing.
  const forged=await createMiningClaimReceiptVerifier({...f.receiptReader,getTransaction:async()=>f.tx},f.trust)({signature:f.signed.signature,signedTransaction:Buffer.from(f.signed.signedTransactionHex,'hex'),kind:f.signed.kind,blockhashContextSlot:a.blockhashContextSlot,sourceHash:h.sourceHash,
   plan:{wallet:new PublicKey(a.wallet),root:Buffer.from(h.root,'hex'),sequence:BigInt(h.sequence),day:BigInt(h.day),totalCumulative:BigInt(h.totalCumulative),leaf:decodeMiningAllocationLeaf(Buffer.from(a.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(a.proofHex,'hex')),blockhash:a.blockhash,needsAta:a.needsAta,needsMinerRecords:a.needsMinerRecords}});
  const role=`claim_receipt_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_claim_receipts(claim_id,ordinal,receipt) values(${k.claimId},0,${JSON.stringify(forged)}::jsonb)`;})).rejects.toThrow('MINING_CLAIM_RECEIPT_OWNER_REQUIRED');
   expect(await getMiningClaimSettlement(f.conn.db,k)).toBeNull();
   await expect(createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.trust})(k)).rejects.toMatchObject({code:'RECEIPT_UNAVAILABLE'});
   let rpcCalls=0;const genesis=f.receiptReader.getGenesisHash;f.receiptReader.getGenesisHash=async()=>{rpcCalls++;return genesis();};
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));await expect(createMiningClaimSettlement(tx,{reader:f.receiptReader,trust:f.trust})(k)).rejects.toMatchObject({code:'OWNER_REQUIRED'});});expect(rpcCalls).toBe(0);
   expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);
   f.receiptReader.getTransaction=async()=>f.tx;const result=await createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.trust})(k);
   vi.stubEnv('PHASE_E_MINING_ENABLED','false');f.receiptReader.getTransaction=async()=>{throw Error('offline replay');};rpcCalls=0;
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect(await getMiningClaimSettlement(tx,k)).toEqual(result);expect(await createMiningClaimSettlement(tx,{reader:f.receiptReader,trust:f.trust})(k)).toEqual(result);});expect(rpcCalls).toBe(0);
   await expect(f.conn.sql`update mining_claim_receipts set receipt=receipt`).rejects.toThrow('MINING_CLAIM_RECEIPT_IMMUTABLE');await expect(f.conn.sql`truncate mining_claim_receipts`).rejects.toThrow('MINING_CLAIM_RECEIPT_IMMUTABLE');
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('rolls back a failed receipt insert and retains completed receipts across migration replay',async()=>fixture(async f=>{
  const k={wallet:f.wallet,claimId:f.preparedClaim.claimId,ordinal:0},settle=createMiningClaimSettlement(f.conn.db,{reader:f.receiptReader,trust:f.receiptTrust});
  await f.conn.sql.unsafe("create function test_fail_claim_receipt() returns trigger language plpgsql as $$begin raise exception 'receipt fixture rollback';end$$;create trigger test_fail_claim_receipt before insert on mining_claim_receipts for each row execute function test_fail_claim_receipt()");await expect(settle(k)).rejects.toThrow();expect(await f.conn.sql`select claim_id from mining_claim_receipts`).toHaveLength(0);await f.conn.sql.unsafe('drop trigger test_fail_claim_receipt on mining_claim_receipts');
  const saved=await settle(k),migration=readFileSync(new URL('../drizzle/0175_mining_claim_receipts.sql',import.meta.url),'utf8');for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const s of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(s);});expect(await getMiningClaimSettlement(f.conn.db,k)).toEqual(saved);
 }));
});

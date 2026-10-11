import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Keypair,VersionedMessage,VersionedTransaction } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { describe,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client';
import { acceptMiningClaimSigned,getMiningClaimSigned } from '../src/mining/claimSignedStore';
import { withMiningClaimPreparationFixture as fixture } from './fixtures/miningClaimPreparation';
describe('immutable exact claimant signed wire',()=>{
 it('retains a generated claimant signature through expired quote, pause and offline reconnect',async()=>fixture(async f=>{
  const key={wallet:f.wallet,claimId:f.preparedClaim.claimId};expect(await getMiningClaimSigned(f.conn.db,key)).toMatchObject({preparation:f.preparedClaim,wires:[]});
  vi.stubEnv('PHASE_E_MINING_ENABLED','false');f.bank.reader.getGenesisHash=async()=>{throw Error('offline');};const wire=f.sign();
  const saved=await acceptMiningClaimSigned(f.conn.db,{...key,signedTransaction:wire});expect(saved).toMatchObject({...key,ordinal:0,kind:'combined',claimSubmissionAuthorized:false});
  expect(saved.signedTransactionHex).toBe(Buffer.from(wire).toString('hex'));expect(await acceptMiningClaimSigned(f.conn.db,{...key,signedTransaction:wire})).toEqual(saved);
  const c=createDb(f.url.toString());try{expect(await getMiningClaimSigned(c.db,key)).toEqual({preparation:f.preparedClaim,wires:[saved]});}finally{await c.sql.end();}
  expect(await getMiningClaimSigned(f.conn.db,{...key,wallet:f.buyer})).toBeNull();
 }));
 it('refuses wrong wallet, changed message, malformed and invalid signatures without partial rows',async()=>fixture(async f=>{
  const key={wallet:f.wallet,claimId:f.preparedClaim.claimId},wire=f.sign();
  await expect(acceptMiningClaimSigned(f.conn.db,{...key,wallet:f.buyer,signedTransaction:wire})).rejects.toMatchObject({code:'NOT_FOUND'});
  const signature=Uint8Array.from(wire);signature[2]=signature[2]!^1;const message=VersionedMessage.deserialize(Buffer.from(f.preparedClaim.transactions[0]!.messageHex,'hex'));message.recentBlockhash=Keypair.generate().publicKey.toBase58();const other=new VersionedTransaction(message);other.sign([f.claimantSigner]);
  for(const bad of [signature,other.serialize(),new Uint8Array(1233),wire.slice(0,65)])await expect(acceptMiningClaimSigned(f.conn.db,{...key,signedTransaction:bad})).rejects.toMatchObject({code:expect.stringMatching(/INVALID_INPUT|INVALID_WIRE/)});
  expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(0);
 }));
 it('copies bytes before awaiting and serializes exact simultaneous acceptance',async()=>fixture(async f=>{
  const key={wallet:f.wallet,claimId:f.preparedClaim.claimId},wire=f.sign(),expected=Buffer.from(wire).toString('hex');
  const first=acceptMiningClaimSigned(f.conn.db,{...key,signedTransaction:wire});wire.fill(0);
  const [a,b]=await Promise.all([first,acceptMiningClaimSigned(f.conn.db,{...key,signedTransaction:f.sign()})]);expect(a).toEqual(b);expect(a.signedTransactionHex).toBe(expected);expect(await f.conn.sql`select claim_id from mining_claim_signed_wires`).toHaveLength(1);
 }));
 it('allows minimal runtime grants and refuses immutable changes, conflicting signatures and unrelated messages',async()=>fixture(async f=>{
  const role=`claim_wire_${randomUUID().replaceAll('-','')}`,key={wallet:f.wallet,claimId:f.preparedClaim.claimId};await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations to ${role};grant select,insert on mining_claim_signed_wires to ${role}`);
  try{await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect((await acceptMiningClaimSigned(tx,{...key,signedTransaction:f.sign()})).ordinal).toBe(0);expect((await getMiningClaimSigned(tx,key))?.wires).toHaveLength(1);});
   const corrupt=Buffer.from(f.sign());corrupt[2]=corrupt[2]!^1;
   await expect(f.conn.sql`insert into mining_claim_signed_wires(claim_id,signed_transaction) values(${key.claimId},${corrupt})`).rejects.toMatchObject({code:'23505'});
   const unrelated=Buffer.from(f.sign());unrelated[unrelated.length-1]=unrelated[unrelated.length-1]!^1;
   await expect(f.conn.sql`insert into mining_claim_signed_wires(claim_id,signed_transaction) values(${key.claimId},${unrelated})`).rejects.toThrow('MINING_CLAIM_SIGNED_MESSAGE');
   await f.conn.sql.unsafe(`grant all on mining_claim_signed_wires to ${role}`);await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`delete from mining_claim_signed_wires`;})).rejects.toThrow('MINING_CLAIM_SIGNED_IMMUTABLE');
   // Later terminal receipts reference this table; CASCADE reaches the immutable trigger boundary.
   await expect(f.conn.sql`truncate mining_claim_signed_wires cascade`).rejects.toThrow('MINING_CLAIM_SIGNED_IMMUTABLE');
   expect((await getMiningClaimSigned(f.conn.db,key))?.wires).toHaveLength(1);
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('reverifies an SQL-inserted signature instead of trusting derived hashes',async()=>fixture(async f=>{
  const corrupt=Buffer.from(f.sign());corrupt[2]=corrupt[2]!^1;await f.conn.sql`insert into mining_claim_signed_wires(claim_id,signed_transaction) values(${f.preparedClaim.claimId},${corrupt})`;
  await expect(getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('does not assign one signed transaction to two independently prepared claim IDs',async()=>fixture(async f=>{
  const wire=f.sign();await acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:f.preparedClaim.claimId,signedTransaction:wire});
  const block=await f.quote.reader.getLatestBlockhashAndContext({commitment:'finalized',minContextSlot:3000});
  f.quote.reader.getLatestBlockhashAndContext=async()=>({...block,context:{slot:3004}});
  const fee=f.quote.reader.getFeeForMessage;f.quote.reader.getFeeForMessage=async(...args)=>({...await fee(...args),context:{slot:3005}});f.quote.reader.getSlot=async()=>3005;
  const second=await f.claimService.prepare(f.wallet,{idempotencyKey:randomUUID()});expect(second.claimId).not.toBe(f.preparedClaim.claimId);expect(second.transactions[0]!.messageHex).toBe(f.preparedClaim.transactions[0]!.messageHex);
  await expect(acceptMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:second.claimId,signedTransaction:wire})).rejects.toMatchObject({code:'SIGNED_CONFLICT'});
  expect((await getMiningClaimSigned(f.conn.db,{wallet:f.wallet,claimId:second.claimId}))?.wires).toEqual([]);
 }));
 it('preserves wire custody across migration retry and refuses repeatable-read insertion',async()=>fixture(async f=>{
  const key={wallet:f.wallet,claimId:f.preparedClaim.claimId};const saved=await acceptMiningClaimSigned(f.conn.db,{...key,signedTransaction:f.sign()});
  const migration=readFileSync(new URL('../drizzle/0174_mining_claim_signed_wires.sql',import.meta.url),'utf8');for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const s of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(s);});
  expect((await getMiningClaimSigned(f.conn.db,key))?.wires).toEqual([saved]);
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_claim_signed_wires(claim_id,signed_transaction) values(${key.claimId},${Buffer.from(f.sign())})`;})).rejects.toThrow('MINING_CLAIM_SIGNED_READ_COMMITTED');
 }));
});

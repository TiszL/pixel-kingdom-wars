import {randomUUID} from 'node:crypto';
import {Keypair,VersionedMessage,VersionedTransaction} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createDb} from '../src/db/client';
import {acceptMiningTaxClaimSigned,getMiningTaxClaimSigned} from '../src/mining/taxClaimSignedStore';
import {saveMiningTaxClaimPreparation} from '../src/mining/taxClaimPreparationStore';
import {withMiningTaxSignedFixture as fixture,signedMigration} from './fixtures/miningTaxSigned';
afterEach(()=>vi.unstubAllEnvs());
describe('immutable original KEEP tax signed custody',()=>{
 it.each(['claim','combined'] as const)('retains exact %s bytes through pause, expiry and offline reconnect without admitting payment',mode=>fixture(async f=>{
  expect(await getMiningTaxClaimSigned(f.conn.db,f.key)).toEqual({preparation:f.record.artifact,wires:[]});vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  f.chain.state.rpc.getGenesisHash=async()=>{throw Error('offline');};
  const saved=await acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire()});
  expect(saved).toMatchObject({...f.key,claimId:f.record.artifact.claimId,ordinal:0,kind:mode,currentSigningAuthorized:false,relayAuthorized:false,settlementAuthorized:false});
  expect(saved.signedTransactionHex).toBe(Buffer.from(f.wire()).toString('hex'));expect(await acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire()})).toEqual(saved);
  const c=createDb(f.url.toString());try{expect(await getMiningTaxClaimSigned(c.db,f.key)).toEqual({preparation:f.record.artifact,wires:[saved]});}finally{await c.sql.end();}
  expect(await getMiningTaxClaimSigned(f.conn.db,{...f.key,wallet:f.buyer})).toBeNull();
 },mode));
 it('retains ordinal1 before setup as custody only, then recovers the original setup→claim roster',()=>fixture(async f=>{
  expect(f.record.artifact.transactions.map(t=>t.kind)).toEqual(['setup','claim']);
  const claim=await acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire(1)});
  expect(claim).toMatchObject({ordinal:1,kind:'claim',relayAuthorized:false,settlementAuthorized:false});
  expect((await getMiningTaxClaimSigned(f.conn.db,f.key))?.wires).toEqual([claim]);
  const setup=await acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire(0)});
  expect((await getMiningTaxClaimSigned(f.conn.db,f.key))?.wires).toEqual([setup,claim]);
  expect(setup).toMatchObject({ordinal:0,kind:'setup',relayAuthorized:false,settlementAuthorized:false});
 },'split'));
 it('rejects wrong wallet, changed original message and malformed signatures before any write',()=>fixture(async f=>{
  await expect(acceptMiningTaxClaimSigned(f.conn.db,{...f.key,wallet:f.buyer,signedTransaction:f.wire()})).rejects.toMatchObject({code:'NOT_FOUND'});
  const signature=f.wire();signature[2]=signature[2]!^1;const m=VersionedMessage.deserialize(Buffer.from(f.record.artifact.transactions[0]!.messageHex,'hex'));m.recentBlockhash=Keypair.generate().publicKey.toBase58();const changed=new VersionedTransaction(m);changed.sign([f.chain.signer]);
  const prefix=f.wire();prefix[0]=2;const zero=f.wire();zero.fill(0,1,65);
  for(const wire of [signature,changed.serialize(),prefix,zero])await expect(acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:wire})).rejects.toMatchObject({code:'INVALID_WIRE'});
  expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(0);
 }));
 it('bounds raw/string/oversized input and refuses caller identity, ordinal or authority substitutions',()=>fixture(async f=>{
  for(const value of [new Uint8Array(65),new Uint8Array(1233),Buffer.from(f.wire()).toString('base64'),'aa'.repeat(5000),null])await expect(acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:value as Uint8Array})).rejects.toMatchObject({code:'INVALID_INPUT'});
  for(const extra of [{claimId:randomUUID()},{ordinal:0},{settlementAuthorized:true},{[Symbol('extra')]:true}])await expect(acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire(),...extra})).rejects.toMatchObject({code:'INVALID_INPUT'});
  await expect(getMiningTaxClaimSigned(f.conn.db,{...f.key,idempotencyKey:'BAD'})).rejects.toMatchObject({code:'INVALID_INPUT'});
  expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(0);
 }));
 it('copies caller bytes before awaits and retains one row across simultaneous acceptance',()=>fixture(async f=>{
  const wire=f.wire(),hex=Buffer.from(wire).toString('hex'),first=acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:wire});wire.fill(0);
  const [a,b]=await Promise.all([first,acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire()})]);expect(a).toEqual(b);expect(a.signedTransactionHex).toBe(hex);
  expect(await f.conn.sql`select claim_id from mining_tax_claim_signed_wires`).toHaveLength(1);
 }));
 it('uses only SELECT/INSERT runtime privileges and blocks mutation even with broader grants',()=>fixture(async f=>{
  const role=`tax_wire_${randomUUID().replaceAll('-','')}`;await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant select on mining_tax_claim_preparations to ${role};grant select,insert on mining_tax_claim_signed_wires to ${role}`);
  try{
   await f.conn.db.transaction(async tx=>{await tx.execute(sql.raw(`set local role ${role}`));expect((await acceptMiningTaxClaimSigned(tx,{...f.key,signedTransaction:f.wire()})).ordinal).toBe(0);expect((await getMiningTaxClaimSigned(tx,f.key))?.wires).toHaveLength(1);});
   await f.conn.sql.unsafe(`grant all on mining_tax_claim_signed_wires to ${role}`);
   for(const statement of ['update mining_tax_claim_signed_wires set signed_transaction=signed_transaction','delete from mining_tax_claim_signed_wires'])await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe(statement);})).rejects.toThrow('MINING_TAX_SIGNED_IMMUTABLE');
   // Continuation evidence makes PostgreSQL reject TRUNCATE before its trigger.
   await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx.unsafe('truncate mining_tax_claim_signed_wires');})).rejects.toThrow('cannot truncate a table referenced in a foreign key constraint');
   expect((await getMiningTaxClaimSigned(f.conn.db,f.key))?.wires).toHaveLength(1);
  }finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
 }));
 it('SQL derives scalar identity and rejects foreign packets, hashes, ordinals and oversized bytes',()=>fixture(async f=>{
  const wire=Buffer.from(f.wire()),id=f.record.artifact.claimId;
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,ordinal,signed_transaction) values(${id},0,${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,wallet,signed_transaction) values(${id},${f.wallet},${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,wire_sha256,signed_transaction) values(${id},${'00'.repeat(32)},${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,idempotency_key,signed_transaction) values(${id},${f.key.idempotencyKey},${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,signature,signed_transaction) values(${id},${wire.subarray(1,65)},${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,message_sha256,signed_transaction) values(${id},${'00'.repeat(32)},${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,accepted_at,signed_transaction) values(${id},now(),${wire})`).rejects.toThrow('MINING_TAX_SIGNED_DERIVED');
  // The additive continuation guard locks and validates the parent first.
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${randomUUID()},${wire})`).rejects.toThrow('MINING_TAX_CONTINUATION_PARENT');
  const foreign=Buffer.from(wire);foreign[foreign.length-1]=foreign[foreign.length-1]!^1;
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${id},${foreign})`).rejects.toThrow('MINING_TAX_SIGNED_MESSAGE');
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${id},${Buffer.alloc(1233)})`).rejects.toThrow('MINING_TAX_SIGNED_WIRE');
 }));
 it('reverifies Ed25519 on every GET instead of trusting SQL-derived hashes',()=>fixture(async f=>{
  const bad=Buffer.from(f.wire());bad[2]=bad[2]!^1;
  await f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${f.record.artifact.claimId},${bad})`;
  await expect(getMiningTaxClaimSigned(f.conn.db,f.key)).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
  await expect(acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire()})).rejects.toMatchObject({code:'SOURCE_CONFLICT'});
 }));
 it('does not reassign one global signature or wire to a different original claim/key',()=>fixture(async f=>{
  await acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire()});const second=structuredClone(f.record);second.artifact.claimId=randomUUID();second.artifact.idempotencyKey=randomUUID();await saveMiningTaxClaimPreparation(f.conn.db,second);
  const key={wallet:f.wallet,idempotencyKey:second.artifact.idempotencyKey};
  await expect(acceptMiningTaxClaimSigned(f.conn.db,{...key,signedTransaction:f.wire()})).rejects.toMatchObject({code:'SIGNED_CONFLICT'});
  expect((await getMiningTaxClaimSigned(f.conn.db,key))?.wires).toEqual([]);
  const corrupt=Buffer.from(f.wire());corrupt[2]=corrupt[2]!^1;
  await expect(f.conn.sql`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${f.record.artifact.claimId},${corrupt})`).rejects.toMatchObject({code:'23505'});
 }));
 it('reapplies additive migration without changing custody and refuses non-READ-COMMITTED inserts',()=>fixture(async f=>{
  const saved=await acceptMiningTaxClaimSigned(f.conn.db,{...f.key,signedTransaction:f.wire()});
  for(let i=0;i<2;i++)await f.conn.sql.begin(async tx=>{for(const statement of signedMigration().split('--> statement-breakpoint').filter(x=>x.trim()))await tx.unsafe(statement);});
  expect((await getMiningTaxClaimSigned(f.conn.db,f.key))?.wires).toEqual([saved]);
  // Its parent-locking continuation guard rejects the isolation level first.
  await expect(f.conn.sql.begin('isolation level repeatable read',async tx=>{await tx`insert into mining_tax_claim_signed_wires(claim_id,signed_transaction) values(${f.record.artifact.claimId},${Buffer.from(f.wire())})`;})).rejects.toThrow('MINING_TAX_CONTINUATION_READ_COMMITTED');
 }));
});

/** Durable exact-message custody must precede any possible transport handoff. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createMiningBackingSnapshotReader } from '@shardkeep/chain/mining-backing';
import { Keypair } from '@solana/web3.js';
import { describe,it,expect,vi } from 'vitest';
import { createDb } from '../src/db/client';
import { beginMiningPublicationAttempt } from '../src/mining/publicationCustody';
import { createMiningPublicationOutbox,getMiningPublicationOutbox } from '../src/mining/publicationOutbox';
import { withMiningPublicationOutboxFixture as fixture } from './fixtures/miningPublicationOutbox';
describe('mining publication durable signing outbox',()=>{
 it('persists reservation before signing and exact wire before recovery, including reconnect and pause',async()=>fixture(async f=>{
  const reservation=await f.outbox.reserveSigning(f.request);expect(reservation.signingAuthorized).toBe(false);expect(reservation.signed).toBeNull();
  const wire=f.sign();vi.stubEnv('PHASE_E_MINING_ENABLED','false');
  const saved=await f.outbox.acceptSigned({...f.request,signedTransaction:wire});expect(saved.signed?.wireSha256).toMatch(/^[0-9a-f]{64}$/);
  f.backing.reader.getGenesisHash=async()=>{throw Error('recovery must not call RPC');};
  expect(await f.outbox.reserveSigning(f.request)).toEqual(saved);expect(await f.outbox.acceptSigned({...f.request,signedTransaction:wire})).toEqual(saved);
  const reopened=createDb(f.url.toString());try{expect(await getMiningPublicationOutbox(reopened.db,f.request.epochId)).toEqual(saved);}finally{await reopened.sql.end();}
  await expect(f.outbox.admitBroadcast(f.request)).rejects.toMatchObject({code:'DISABLED'});
  expect(Buffer.from(saved.signed!.signedTransactionHex,'hex')).toEqual(Buffer.from(wire));
 }));
 it('refuses signature corruption, different exact message and signed acceptance before reservation',async()=>fixture(async f=>{
  const wire=f.sign();await expect(f.outbox.acceptSigned({...f.request,signedTransaction:wire})).rejects.toMatchObject({code:'NOT_RESERVED'});
  await f.outbox.reserveSigning(f.request);const broken=Uint8Array.from(wire);broken[2]=broken[2]!^1;
  await expect(f.outbox.acceptSigned({...f.request,signedTransaction:broken})).rejects.toMatchObject({code:'SIGNED_WIRE_INVALID'});
  const other=Uint8Array.from(wire);other[other.length-1]=other[other.length-1]!^1;
  await expect(f.outbox.acceptSigned({...f.request,signedTransaction:other})).rejects.toMatchObject({code:'SIGNED_WIRE_INVALID'});
  expect((await f.outbox.get(f.request.epochId))?.signed).toBeNull();
  await f.outbox.acceptSigned({...f.request,signedTransaction:wire});await expect(f.outbox.acceptSigned({...f.request,signedTransaction:broken})).rejects.toMatchObject({code:'IDEMPOTENCY_BODY_MISMATCH'});
 }));
 it.each(['publisher','pause','frontier','funding','bank','deployment'] as const)('refuses fresh %s drift without reserving a sequence',async kind=>fixture(async f=>{
  if(kind==='publisher')f.backing.model.publisher=Keypair.generate().publicKey;
  if(kind==='pause')f.backing.model.flags=2;
  if(kind==='frontier')f.backing.model.latest_sequence=1n;
  if(kind==='funding')f.backing.rows[1]!.data.writeBigUInt64LE(0n,64);
  if(kind==='bank'){f.backing.rows[7]!.data.writeBigUInt64LE(1900n);f.backing.reader.getSlot=async()=>1900;f.backing.reader.getMultipleAccountsInfoAndContext=async()=>({context:{slot:1900},value:f.backing.rows});}
  if(kind==='deployment')f.backing.rows[5]!.data[4]=f.backing.rows[5]!.data[4]!^1;
  await f.backing.config();await expect(f.outbox.reserveSigning(f.request)).rejects.toMatchObject({code:'SOURCE_DRIFT'});
  expect(await f.outbox.get(f.request.epochId)).toBeNull();
 }));
 it('freshly admits only stored signed bytes and refuses changed frontier after a durable signature',async()=>fixture(async f=>{
  await f.outbox.reserveSigning(f.request);await expect(f.outbox.admitBroadcast(f.request)).rejects.toMatchObject({code:'NOT_SIGNED'});
  const saved=await f.outbox.acceptSigned({...f.request,signedTransaction:f.sign()}),admitted=await f.outbox.admitBroadcast(f.request);
  expect(Buffer.from(admitted.signedTransaction)).toEqual(Buffer.from(saved.signed!.signedTransactionHex,'hex'));
  f.backing.model.latest_sequence=1n;await f.backing.config();await expect(f.outbox.admitBroadcast(f.request)).rejects.toMatchObject({code:'SOURCE_DRIFT'});
  expect(await f.outbox.get(f.request.epochId)).toEqual(saved);
 }));
 it('serializes same-epoch reserve and accepts one exact signature across concurrent callers',async()=>fixture(async f=>{
  const reservations=await Promise.allSettled([f.outbox.reserveSigning(f.request),f.outbox.reserveSigning(f.request)]);expect(reservations.some(r=>r.status==='fulfilled')).toBe(true);
  await f.outbox.reserveSigning(f.request);const wire=f.sign(),accepted=await Promise.allSettled([f.outbox.acceptSigned({...f.request,signedTransaction:wire}),f.outbox.acceptSigned({...f.request,signedTransaction:wire})]);
  expect(accepted.some(r=>r.status==='fulfilled')).toBe(true);const saved=await f.outbox.acceptSigned({...f.request,signedTransaction:wire});
  for(const r of accepted)if(r.status==='fulfilled')expect(r.value).toEqual(saved);else expect(r.reason).toMatchObject({code:'BUSY'});
  expect(await f.conn.sql`select epoch_id from mining_publication_signed_wires`).toHaveLength(1);
 }));
 it('refuses broad grants, immutable history rewrites and stale isolation; migration repeats preserve wire',async()=>fixture(async f=>{
  await f.outbox.reserveSigning(f.request);const saved=await f.outbox.acceptSigned({...f.request,signedTransaction:f.sign()}),role=`mining_sign_${randomUUID().replaceAll('-','')}`;
  await f.conn.sql.unsafe(`create role ${role};grant usage on schema public to ${role};grant all on all tables in schema public to ${role}`);
  try{await expect(f.conn.sql.begin(async tx=>{await tx.unsafe(`set local role ${role}`);await tx`insert into mining_publication_signed_wires(epoch_id,signature,signed_transaction) values(${f.request.epochId},${saved.signed!.signature},${Buffer.from(f.sign())})`;})).rejects.toThrow('MINING_OUTBOX_OWNER_REQUIRED');}
  finally{await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`);}
  await expect(f.conn.sql`delete from mining_publication_signed_wires`).rejects.toThrow('MINING_OUTBOX_IMMUTABLE');
  await expect(f.conn.sql`truncate mining_publication_signing_reservations`).rejects.toThrow();
  await expect(f.conn.sql.begin(async tx=>{await tx`set transaction isolation level repeatable read`;await tx`insert into mining_publication_signed_wires(epoch_id,signature,signed_transaction) values(${f.request.epochId},${saved.signed!.signature},${Buffer.from(f.sign())})`;})).rejects.toThrow('MINING_OUTBOX_READ_COMMITTED_REQUIRED');
  const migration=readFileSync(new URL('../drizzle/0171_mining_publication_outbox.sql',import.meta.url),'utf8');
  for(let n=0;n<2;n++)await f.conn.sql.begin(async tx=>{for(const s of migration.split('--> statement-breakpoint').filter(s=>s.trim()))await tx.unsafe(s);});
  expect(await f.outbox.get(f.request.epochId)).toEqual(saved);
 }));
 it('serializes competing prepared epoch identities at the same finalized publication frontier',async()=>fixture(async f=>{
  const backing=await createMiningBackingSnapshotReader(f.backing.reader,f.backing.trust)(),encoded=JSON.stringify(backing,(_,v)=>typeof v==='bigint'?v.toString():v),extra=await f.reserve('2020-01-02');
  const secondKey=randomUUID();await beginMiningPublicationAttempt(f.conn.db,{epochId:extra.receipt.epochId,attemptKey:secondKey,intentBytes:Buffer.from(f.prepared.intentHex,'hex')});
  // The SQL uniqueness boundary must hold even for an owner-inserted second
  // declaration; it cannot rely only on application qualification/preparation.
  const plan=JSON.parse(f.prepared.manifestJson);plan.input.epochId=extra.receipt.epochId;
  plan.reservations=[{reservationId:extra.receipt.id,baseId:extra.receipt.baseId,actorWallet:extra.receipt.actorWallet,reserved:extra.receipt.ingots,proposedConsumed:extra.receipt.ingots,proposedReturned:0}];
  await f.conn.sql`insert into mining_publication_manifests(epoch_id,manifest_json,publication) values(${extra.receipt.epochId},${JSON.stringify(plan)},${JSON.stringify(f.prepared.publication)}::jsonb)`;
  const attempts=await Promise.allSettled([f.conn.sql`insert into mining_publication_signing_reservations(epoch_id,backing) values(${f.request.epochId},${encoded}::jsonb)`,f.conn.sql`insert into mining_publication_signing_reservations(epoch_id,backing) values(${extra.receipt.epochId},${encoded}::jsonb)`]);
  expect(attempts.filter(a=>a.status==='fulfilled')).toHaveLength(1);expect(attempts.find(a=>a.status==='rejected')).toMatchObject({reason:{code:'23505'}});
  expect(await f.conn.sql`select epoch_id from mining_publication_signing_reservations`).toHaveLength(1);
 }));

 it('keeps one timed-out source read in flight and discards its late result before a fresh retry',async()=>fixture(async f=>{
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;}),original=f.backing.reader.getGenesisHash;
  let calls=0;f.backing.reader.getGenesisHash=vi.fn(async()=>{if(++calls===1)await held;return original();});
  const outbox=createMiningPublicationOutbox(f.conn.db,{reader:f.backing.reader,trust:f.backing.trust,timeoutMs:100});
  await expect(outbox.reserveSigning(f.request)).rejects.toMatchObject({code:'SOURCE_DRIFT'});
  for(let n=0;n<3;n++)await expect(outbox.reserveSigning(f.request)).rejects.toMatchObject({code:'BUSY'});
  expect(calls).toBe(1);expect(await outbox.get(f.request.epochId)).toBeNull();
  release();await vi.waitFor(()=>expect(calls).toBe(2));expect(await outbox.get(f.request.epochId)).toBeNull();
  expect((await outbox.reserveSigning(f.request)).signed).toBeNull();expect(calls).toBe(4);
 }));

});

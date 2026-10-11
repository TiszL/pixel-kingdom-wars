import { createHash } from 'node:crypto';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { transferStableBase } from '../src/game/baseOwnership';
import { createCharterCreationSignedStore } from '../src/game/clanCharterCreationSignedStore';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { terminalBank } from './fixtures/charterCreationTerminal';
import { charterCreationSignedFixture,noSignedAuthority,signedRefusal,type SignedFixture } from './fixtures/charterCreationSigned';
let active:SignedFixture|undefined;
const fixture=()=>{if(!active)throw Error('Signed fixture setup incomplete');return active;};
beforeEach(async()=>{active=undefined;active=await charterCreationSignedFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const f=active;active=undefined;await f?.dispose();},120_000);

it('retains the exact payer-signed v0 packet without changing funding, quests, inventory or issuer exposure',async()=>{
 const f=fixture(),p=await f.preparedSigned();await f.seedSpendQuests();const before=await f.terminalSnapshot();
 expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toBeNull();
 const saved=await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire);
 expect(saved).toMatchObject({attemptId:p.saved.attempt.id,reservationId:p.consent.reservationId,creationIntentId:p.consent.creationIntentId,
  wallet:p.actor.wallet,signedTransactionHex:p.wire.toString('hex'),messageSha256:p.saved.preparation!.packet.messageSha256,...noSignedAuthority});
 expect(saved.wireSha256).toBe(createHash('sha256').update(p.wire).digest('hex'));
 expect(saved.acceptedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
 expect(Object.isFrozen(saved)).toBe(true);expect(await f.signedRows()).toHaveLength(1);
 expect(await f.terminalSnapshot()).toEqual(before);expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);
});

it('requires an issued original preparation and refuses a different payer without exposing saved bytes',async()=>{
 const f=fixture(),p=await f.admitted();
 expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toBeNull();
 await expect(f.store().accept(p.actor.wallet,p.consent.creationIntentId,Buffer.alloc(100))).rejects.toMatchObject(signedRefusal('PREPARATION'));
 const q=await f.preparedSigned();await f.store().accept(q.actor.wallet,q.consent.creationIntentId,q.wire);
 for(const method of ['get','accept'] as const){
  const call=method==='get'?f.store().get(p.actor.wallet,q.consent.creationIntentId):f.store().accept(p.actor.wallet,q.consent.creationIntentId,q.wire);
  await expect(call).rejects.toMatchObject(signedRefusal('PAYER'));
 }
 expect(await f.signedRows()).toHaveLength(1);
});

it('refuses unsigned, foreign, changed blockhash and changed instruction packets even with a valid new wallet signature',async()=>{
 const f=fixture(),p=await f.preparedSigned();const before=await f.terminalSnapshot();
 for(const mode of ['unsigned','signature','blockhash','instruction','lookup','extra']){
  const tx=VersionedTransaction.deserialize(p.wire);
  if(mode==='unsigned')tx.signatures[0]!.fill(0);
  if(mode==='signature')tx.signatures[0]![0]!^=1;
  if(mode==='blockhash')tx.message.recentBlockhash=Keypair.generate().publicKey.toBase58();
  if(mode==='instruction')tx.message.compiledInstructions[1]!.data[20]!^=1;
  if(mode==='lookup')tx.message.addressTableLookups[0]!.accountKey=Keypair.generate().publicKey;
  if(['blockhash','instruction','lookup'].includes(mode))tx.sign([p.payer]);
  const bytes=mode==='extra'?Buffer.concat([p.wire,Buffer.of(0)]):tx.serialize();
  await expect(f.store().accept(p.actor.wallet,p.consent.creationIntentId,bytes)).rejects.toMatchObject(signedRefusal('WIRE'));
 }
 expect(await f.signedRows()).toHaveLength(0);expect(await f.terminalSnapshot()).toEqual(before);
});

it('serializes duplicate signed returns and reopens the identical consent offline without another issuer call',async()=>{
 const f=fixture(),p=await f.preparedSigned(),peer=f.reopen();
 try{const other=createCharterCreationSignedStore(peer.db),receipts=await Promise.all([
  f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire),other.accept(p.actor.wallet,p.consent.creationIntentId,p.wire)]);
  expect(receipts[0]).toEqual(receipts[1]);expect(await other.get(p.actor.wallet,p.consent.creationIntentId)).toEqual(receipts[0]);
  expect(await other.accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).toEqual(receipts[0]);
 }finally{await peer.sql.end();}
 expect(await f.signedRows()).toHaveLength(1);expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);
});

it('copies wallet bytes before the first await so caller mutation cannot replace durable consent',async()=>{
 const f=fixture(),p=await f.preparedSigned(),caller=Buffer.from(p.wire),hex=caller.toString('hex');
 const pending=f.store().accept(p.actor.wallet,p.consent.creationIntentId,caller);caller.fill(0);
 const saved=await pending;expect(saved.signedTransactionHex).toBe(hex);
 expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toEqual(saved);
});

it('rejects a newly signed alternative packet after a valid receipt exists instead of silently treating it as a retry',async()=>{
 const f=fixture(),p=await f.preparedSigned(),saved=await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire);
 const other=VersionedTransaction.deserialize(p.wire);other.message.recentBlockhash=Keypair.generate().publicKey.toBase58();other.sign([p.payer]);
 await expect(f.store().accept(p.actor.wallet,p.consent.creationIntentId,other.serialize())).rejects.toMatchObject(signedRefusal('WIRE'));
 expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toEqual(saved);expect(await f.signedRows()).toHaveLength(1);
});

it('can first retain an old signed packet after transfer, pause and expiry without restoring current issuance authority',async()=>{
 const f=fixture(),p=await f.preparedSigned(),buyer=await f.actor();
 await transferStableBase(f.db,p.actor.baseId,p.actor.wallet,buyer.wallet,p.actor.deed,{...p.actor.proof(buyer.wallet,101),observedAtMs:Date.now()});
 process.env['PHASE_E_CHARTER_ENABLED']='false';process.env['MULTI_BASE_ENABLED']='false';p.bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);
 const before=await f.terminalSnapshot(),saved=await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire);
 expect(saved).toMatchObject(noSignedAuthority);expect(await f.terminalSnapshot()).toEqual(before);
 await expect(f.store().get(buyer.wallet,p.consent.creationIntentId)).rejects.toMatchObject(signedRefusal('PAYER'));
 expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);
});

it('composes actual signed retention with original finalized activation and burns escrow only once at terminal recovery',async()=>{
 const f=fixture(),p=await f.preparedSigned();await f.seedSpendQuests();
 const before=await f.terminalSnapshot(),burn=await f.balance('shard_burn');
 const signed=await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire);expect(await f.terminalSnapshot()).toEqual(before);
 const inventory=await f.inventory().read(p.actor.wallet,p.consent.creationIntentId),bank=terminalBank(inventory,true);
 const terminal=createCharterCreationTerminal(f.db,{chain:bank.chain}),result=await terminal.recover(p.actor.wallet,p.consent.creationIntentId);
 expect(result.state).toBe('activated');expect(await f.balance('charter_creation_escrow')).toBe(0n);
 expect(await f.balance('shard_burn')).toBe(burn+f.cost);expect((await f.spendProgress(p.actor.baseId)).map(x=>x.progress)).toEqual([Number(f.cost),Number(f.cost)]);
 const after=await f.terminalSnapshot();expect(await terminal.recover(p.actor.wallet,p.consent.creationIntentId)).toEqual(result);
 expect(await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).toEqual(signed);expect(await f.terminalSnapshot()).toEqual(after);
});

it('composes signed retention with strict expired absence and full original refund, retaining consent after terminal',async()=>{
 const f=fixture(),p=await f.preparedSigned(),before=await f.balance('base_shards',p.actor.baseId),burn=await f.balance('shard_burn');
 const signed=await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire);
 const bank=terminalBank(await f.inventory().read(p.actor.wallet,p.consent.creationIntentId));bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);
 const terminal=createCharterCreationTerminal(f.db,{chain:bank.chain});expect((await terminal.recover(p.actor.wallet,p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
 await p.actor.refresh();const result=await terminal.claimRefund(p.actor.wallet,p.consent.creationIntentId);
 expect(result.state).toBe('refunded');expect(await f.balance('base_shards',p.actor.baseId)).toBe(before+f.cost);
 expect(await f.balance('shard_burn')).toBe(burn);expect(await f.balance('charter_creation_escrow')).toBe(0n);
 const after=await f.terminalSnapshot();expect(await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire)).toEqual(signed);
 expect(await terminal.claimRefund(p.actor.wallet,p.consent.creationIntentId)).toEqual(result);expect(await f.terminalSnapshot()).toEqual(after);
});

it('first retains a late wallet response after activation or refund without repeating either terminal effect',async()=>{
 const f=fixture();
 // Get exercises the feature before the terminal assertions, retaining useful
 // intentional RED evidence while both insertion paths are tested on GREEN.
 for(const minted of [true,false]){
  const p=await f.preparedSigned();expect(await f.store().get(p.actor.wallet,p.consent.creationIntentId)).toBeNull();
  const bank=terminalBank(await f.inventory().read(p.actor.wallet,p.consent.creationIntentId),minted);
  bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);
  const terminal=createCharterCreationTerminal(f.db,{chain:bank.chain});await terminal.recover(p.actor.wallet,p.consent.creationIntentId);
  if(!minted){await p.actor.refresh();await terminal.claimRefund(p.actor.wallet,p.consent.creationIntentId);}
  const before=await f.terminalSnapshot();process.env['PHASE_E_CHARTER_ENABLED']='false';
  const saved=await f.store().accept(p.actor.wallet,p.consent.creationIntentId,p.wire);expect(saved).toMatchObject(noSignedAuthority);
  expect(await f.terminalSnapshot()).toEqual(before);process.env['PHASE_E_CHARTER_ENABLED']='true';
 }
 expect(await f.signedRows()).toHaveLength(2);
});

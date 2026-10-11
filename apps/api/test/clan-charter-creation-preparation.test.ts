/** D166 stops at durable unsigned v0 preparation. No wallet relay or live key. */
import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { verifyCharterCreationPacket } from '@shardkeep/chain/charter-creation-preparation';
import { refreshBaseOwnership,transferStableBase } from '../src/game/baseOwnership';
import { createCharterCreationPreparation } from '../src/game/clanCharterCreationPreparation';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { terminalBank } from './fixtures/charterCreationTerminal';
import { charterCreationPreparationFixture,noPreparationAuthority,preparationRefusal,type PreparationFixture } from './fixtures/charterCreationPreparation';
let active:PreparationFixture|undefined;
const fixture=()=>{if(!active)throw Error('Preparation fixture setup did not complete');return active;};
beforeEach(async()=>{active=undefined;active=await charterCreationPreparationFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const current=active;active=undefined;await current?.dispose();},120_000);

it('commits an original attempt before real kind5 signing and retains canonical v0 without money or quest effects',async()=>{
 const f=fixture(),p=await f.admitted();await f.seedSpendQuests();const before=await f.terminalSnapshot();
 p.hooks.beforePolicy=async()=>{const rows=await f.attempts();expect(rows).toHaveLength(1);expect(rows[0]!.reservation_id).toBe(p.consent.reservationId);};
 const saved=await p.service().prepare(p.actor.wallet,p.consent.creationIntentId);
 expect(saved).toMatchObject({version:1,admission:p.admission,attempt:{id:expect.any(String),policySigner:p.key.publicKey.toBase58(),candidateHex:p.candidate.toString('hex')},...noPreparationAuthority});
 expect(saved.preparation).not.toBeNull();if(!saved.preparation)throw Error('No issued preparation');
 const request=vi.mocked(p.issuer.issueOnce).mock.calls[0]![0];expect(Object.keys(request).sort()).toEqual(['kind','message','requestId']);
 expect(request).toEqual({kind:'charter-registration-v1',requestId:saved.attempt.id,message:p.candidate});
 expect(p.signatures()).toBe(1);expect(saved.preparation.policySignatureHex).toBe(Buffer.from(p.receipts.get(saved.attempt.id)!.signature).toString('hex'));
 const {candidateHex:_candidateHex,...packetInput}=saved.attempt.quote.packetInput;
 const input={...packetInput,candidate:p.candidate,policySignature:Buffer.from(saved.preparation.policySignatureHex,'hex')};
 expect(verifyCharterCreationPacket(input,saved.preparation.packet)).toEqual(saved.preparation.packet);
 expect(VersionedTransaction.deserialize(Buffer.from(saved.preparation.packet.unsignedTransactionHex,'hex')).version).toBe(0);
 expect(await f.attempts()).toHaveLength(1);expect(await f.preparations()).toHaveLength(1);expect(await f.terminalSnapshot()).toEqual(before);
 expect(Object.isFrozen(saved.attempt.quote.costs.allocations)).toBe(true);expect(Object.isFrozen(saved.preparation)).toBe(true);
});

it('reopens the exact artifact offline after flags, custody and policy change without new quotes or signatures',async()=>{
 const f=fixture(),p=await f.admitted(),saved=await p.service().prepare(p.actor.wallet,p.consent.creationIntentId),buyer=await f.actor();
 await transferStableBase(f.db,p.actor.baseId,p.actor.wallet,buyer.wallet,p.actor.deed,{...p.actor.proof(buyer.wallet,101),observedAtMs:Date.now()});
 process.env['PHASE_E_CHARTER_ENABLED']='false';process.env['MULTI_BASE_ENABLED']='false';p.bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);
 const reopened=f.reopen();try{const offline=createCharterCreationPreparation(reopened.db,{chain:null,issuer:null,monotonicNow:()=>{throw Error('History sampled new time');}});
  expect(await offline.read(p.actor.wallet,p.consent.creationIntentId)).toEqual(saved);expect(await offline.prepare(p.actor.wallet,p.consent.creationIntentId)).toEqual(saved);
  expect(await offline.recover(p.actor.wallet,p.consent.creationIntentId)).toEqual(saved);
  await expect(offline.read(buyer.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('PAYER'));
 }finally{await reopened.sql.end();}
 expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(p.rpc.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);
});

it('holds either pause, expired candidate and rotation even when the new configured key is current',async()=>{
 const f=fixture(),p=await f.admitted(),before=await f.inventorySnapshot(),control=p.bank.rows.find(r=>r.address.toBase58()===p.consent.chain.craftControl)!;
 const originalAuthority=Buffer.from(p.bank.row.data),originalClock=Buffer.from(p.bank.clock);
 for(const mode of ['policy-pause','craft-pause','rotation','expired']){
  originalAuthority.copy(p.bank.row.data);originalClock.copy(p.bank.clock);control.data[137]=0;
  if(mode==='policy-pause')p.bank.row.data[p.bank.offsets['paused']!]=1;
  if(mode==='craft-pause')control.data[137]=1;
  const rotated=Keypair.generate();if(mode==='rotation')rotated.publicKey.toBuffer().copy(p.bank.row.data,p.bank.offsets['current']!);
  if(mode==='expired')p.bank.clock.writeBigInt64LE(p.admission.candidate.expiry,32);
  const service=p.service({chain:{...p.chain,expectedCurrentSigner:mode==='rotation'?rotated.publicKey.toBase58():p.chain.expectedCurrentSigner}});
  await expect(service.prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
  expect(await f.attempts()).toHaveLength(0);expect(await f.inventorySnapshot()).toEqual(before);
 }
 expect(p.issuer.issueOnce).not.toHaveBeenCalled();
});

it('requires the original active paid custody epoch and refuses return after actual A-to-B-to-A transfer',async()=>{
 const f=fixture(),p=await f.admitted(),buyer=await f.actor();
 await refreshBaseOwnership(f.db,p.actor.baseId,async()=>null,p.actor.collection);
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 await p.actor.refresh();await f.sql`update base_slots set active=false where base_id=${p.actor.baseId}`;
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 await f.sql`update base_slots set active=true where base_id=${p.actor.baseId}`;
 await f.sql`update bases set land_paid_at=null where id=${p.actor.baseId}`;
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 await f.sql`update bases set land_paid_at=now() where id=${p.actor.baseId}`;
 await transferStableBase(f.db,p.actor.baseId,p.actor.wallet,buyer.wallet,p.actor.deed,{...p.actor.proof(buyer.wallet,101),observedAtMs:Date.now()});
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 await transferStableBase(f.db,p.actor.baseId,buyer.wallet,p.actor.wallet,p.actor.deed,{...p.actor.proof(p.actor.wallet,102),observedAtMs:Date.now()});
 expect((await p.actor.custody.read(p.actor.baseId))?.id).not.toBe(p.actor.epoch.id);
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 expect(await f.attempts()).toHaveLength(0);expect(p.issuer.issueOnce).not.toHaveBeenCalled();
 expect((await f.inventory().loadForCancellation(p.consent.creationIntentId)).permitInventory.messages).toEqual([p.candidate]);
});

it('refuses new preparation after terminal or flags-off before RPC and never adopts a bare non-admitted candidate',async()=>{
 const f=fixture(),p=await f.admitted(),inventory=await f.inventory().read(p.actor.wallet,p.consent.creationIntentId),bank=terminalBank(inventory);
 bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);
 expect((await createCharterCreationTerminal(f.db,{chain:bank.chain}).recover(p.actor.wallet,p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 expect(p.connect).not.toHaveBeenCalled();expect(p.issuer.issueOnce).not.toHaveBeenCalled();
 const q=await f.admitted(await f.actor());process.env['PHASE_E_CHARTER_ENABLED']='false';
 await expect(q.service().prepare(q.actor.wallet,q.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 expect(q.connect).not.toHaveBeenCalled();process.env['PHASE_E_CHARTER_ENABLED']='true';
 const r=await f.fund(await f.actor()),zero=await f.inventory().read(r.actor.wallet,r.consent.creationIntentId);
 await f.inventory().recordPrepared(r.actor.wallet,r.consent.creationIntentId,f.message(zero));
 await expect(q.service().prepare(r.actor.wallet,r.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
 expect(await f.attempts()).toHaveLength(0);
});

it('refuses unsupported cost profile or unreviewed ALT before committing an issuance attempt',async()=>{
 const f=fixture(),p=await f.admitted();
 for(const mode of ['profile','hash','mutable','cap']){
  const data=Buffer.from(p.lookup.data);if(mode==='mutable')data[21]=1;
  p.rpc.getAccountInfoAndContext=vi.fn(async()=>({context:{slot:150},value:{owner:new PublicKey(p.lookup.row.owner),executable:false,data}}));
  const chain={...p.chain,coreCostProfile:{...p.chain.coreCostProfile,...mode==='profile'?{reviewedProgramDataSha256:'ff'.repeat(32)}:{}},
   lookupTable:{...p.chain.lookupTable,...mode==='hash'?{dataSha256:'ff'.repeat(32)}:{}},costLimits:{...p.chain.costLimits,...mode==='cap'?{maxTotalLamports:1n}:{}}};
  await expect(async()=>p.service({chain}).prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
  expect(await f.attempts()).toHaveLength(0);
 }
 expect(p.issuer.issueOnce).not.toHaveBeenCalled();
});

it('quarantines wrong key, message, request and signature replies while preserving original exposure for lookup',async()=>{
 const f=fixture();
 for(const mode of ['key','message','request','signature']){
  const p=await f.admitted(await f.actor());p.hooks.reply=v=>({...v,publicKey:mode==='key'?Keypair.generate().publicKey.toBase58():v.publicKey,
   requestId:mode==='request'?randomUUID():v.requestId,message:mode==='message'?Buffer.alloc(161):v.message,
   signature:mode==='signature'?Buffer.alloc(64):v.signature});
  await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('HELD'));
  const pending=await p.service().read(p.actor.wallet,p.consent.creationIntentId);expect(pending?.preparation).toBeNull();
  expect((await f.inventory().loadForCancellation(p.consent.creationIntentId)).permitInventory.messages).toEqual([p.candidate]);
  const recovered=await p.service().recover(p.actor.wallet,p.consent.creationIntentId);expect(recovered.preparation).not.toBeNull();
  expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(p.signatures()).toBe(1);
 }
},120_000);

it('copies options and issuer reply bytes before later mutation and retains one immutable original',async()=>{
 const f=fixture(),p=await f.admitted(),service=p.service();Object.assign(p.chain.costLimits,{maxTotalLamports:1n});
 const saved=await service.prepare(p.actor.wallet,p.consent.creationIntentId),receipt=p.receipts.get(saved.attempt.id)!;
 receipt.message.fill(0);receipt.signature.fill(0);p.lookup.data.fill(0);p.bank.row.data.fill(0);
 expect(await createCharterCreationPreparation(f.db,{chain:null,issuer:null}).read(p.actor.wallet,p.consent.creationIntentId)).toEqual(saved);
 expect(saved.preparation).not.toBeNull();expect(Object.isFrozen(saved.attempt.quote.packetInput.lookupTable)).toBe(true);
});

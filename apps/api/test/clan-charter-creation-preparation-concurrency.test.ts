import { Keypair } from '@solana/web3.js';
import { PHASE_E_CHARTER_ADMISSION } from '@shardkeep/shared';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import type { Db } from '../src/db/client';
import { createCharterCreationPreparation } from '../src/game/clanCharterCreationPreparation';
import { createCharterCreationTerminal } from '../src/game/clanCharterCreationTerminal';
import { waitForPolicyLock } from './fixtures/charterCreationPolicyAdmission';
import { terminalBank } from './fixtures/charterCreationTerminal';
import { charterCreationPreparationFixture,gate,outcome,preparationRefusal,type PreparationFixture } from './fixtures/charterCreationPreparation';
let active:PreparationFixture|undefined;
const fixture=()=>{if(!active)throw Error('Preparation fixture setup did not complete');return active;};
beforeEach(async()=>{active=undefined;active=await charterCreationPreparationFixture();},120_000);
afterEach(async()=>{vi.restoreAllMocks();const current=active;active=undefined;await current?.dispose();},120_000);

it('overlaps two real quotes but commits one attempt and one first issuer call without SQL locks during signing',async()=>{
 const f=fixture(),p=await f.admitted(),quotes=gate(),signing=gate();let arrivals=0;
 const fee=p.rpc.getFeeForMessage;
 p.rpc.getFeeForMessage=vi.fn(async(message:Parameters<typeof fee>[0],commitment:Parameters<typeof fee>[1])=>{
  if(++arrivals===2)await quotes.enter();else await quotes.arrived;return fee(message,commitment);
 });
 p.hooks.beforePolicy=signing.enter;
 const a=outcome(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)),b=outcome(p.service().prepare(p.actor.wallet,p.consent.creationIntentId));
 try{
  await Promise.race([quotes.arrived,a.then(r=>{if(!r.ok)throw r.error;throw Error('First caller missed overlap');}),b.then(r=>{if(!r.ok)throw r.error;throw Error('Second caller missed overlap');})]);
  quotes.release();await Promise.race([signing.arrived,Promise.all([a,b]).then(results=>{
   for(const result of results)if(!result.ok)throw result.error;
   throw Error('Both callers returned without reaching issuer');
  })]);
  // The issuing caller is held before signing. Let the legitimate losing
  // caller finish its lookup-only transaction before probing the issuer's
  // locks; otherwise its short transaction can cause an unrelated 55P03.
  const loser=await Promise.race([a,b]);if(!loser.ok)throw loser.error;
  expect(loser.value.preparation).toBeNull();expect(p.issuer.lookup).toHaveBeenCalledTimes(1);
  const owner=await f.dedicatedOwner();try{
   await owner.sql`begin`;
   await owner.sql`select id from bases where id=${p.actor.baseId} for update nowait`;
   await owner.sql`select id from charter_creation_reservations where id=${p.consent.reservationId} for update nowait`;
  }finally{await owner.sql`rollback`;await owner.sql.end();}
  expect(arrivals).toBe(2);expect(await f.attempts()).toHaveLength(1);expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);
  signing.release();const results=await Promise.all([a,b]);for(const r of results){if(!r.ok)throw r.error;}
  const recovered=await p.service().recover(p.actor.wallet,p.consent.creationIntentId);expect(recovered.preparation).not.toBeNull();
  for(const r of results)if(r.ok){expect(r.value.attempt).toEqual(recovered.attempt);if(r.value.preparation)expect(r.value).toEqual(recovered);}
  expect(p.signatures()).toBe(1);expect(await f.preparations()).toHaveLength(1);
 }finally{quotes.release();signing.release();await Promise.all([a,b]);}
});

it('recovers a lost signed reply by lookup after reopen without resigning or selecting another blockhash',async()=>{
 const f=fixture(),p=await f.admitted();p.hooks.afterSign=async()=>{throw Error('Fixture lost reply after durable issuer receipt');};
 await expect(p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('UNCERTAIN'));
 const pending=await p.service().read(p.actor.wallet,p.consent.creationIntentId);expect(pending?.preparation).toBeNull();if(!pending)throw Error('Missing committed attempt');
 process.env['PHASE_E_CHARTER_ENABLED']='false';const reopened=f.reopen();try{
  const offline=createCharterCreationPreparation(reopened.db,{chain:null,issuer:p.issuer});const recovered=await offline.recover(p.actor.wallet,p.consent.creationIntentId);
  expect(recovered.attempt).toEqual(pending.attempt);expect(recovered.preparation).not.toBeNull();expect(await offline.prepare(p.actor.wallet,p.consent.creationIntentId)).toEqual(recovered);
 }finally{await reopened.sql.end();}
 expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(p.signatures()).toBe(1);expect(p.rpc.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);
});

it('keeps a timed-out ignored-abort issuer counted in original inventory and recovers only its original receipt',async()=>{
 const f=fixture(),p=await f.admitted(),reply=gate();p.hooks.afterSign=reply.enter;
 const work=outcome(p.service({timeoutMs:1000}).prepare(p.actor.wallet,p.consent.creationIntentId));
 try{
  await Promise.race([reply.arrived,work.then(r=>{if(!r.ok)throw r.error;throw Error('No actual signature before timeout');})]);
  expect(await work).toMatchObject({ok:false,error:preparationRefusal('UNCERTAIN')});
  expect((await f.inventory().loadForCancellation(p.consent.creationIntentId)).permitInventory).toMatchObject({count:1,revision:'1',messages:[p.candidate]});
  expect((await p.service().read(p.actor.wallet,p.consent.creationIntentId))?.preparation).toBeNull();reply.release();
  const recovered=await p.service().recover(p.actor.wallet,p.consent.creationIntentId);expect(recovered.preparation).not.toBeNull();
  expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);expect(p.signatures()).toBe(1);
 }finally{reply.release();await work;}
});

it('holds a stale post-commit pre-dispatch attempt and never signs it on lookup-null replay',async()=>{
 const f=fixture();
 for(const mode of ['immediate','microtask']){
  const p=await f.admitted(mode==='immediate'?f.source:await f.actor()),transact=f.db.transaction.bind(f.db);
  let observedCommitted=false,scheduled=false;
  // Delay only AFTER genuine commit; the second connection proves durability.
  const wrapper=async(...args:Parameters<Db['transaction']>)=>{
   const result=await transact(...args);
   if(!observedCommitted&&(await f.sql`select id from charter_creation_issuance_attempts where reservation_id=${p.consent.reservationId}`).length===1){
    observedCommitted=true;if(mode==='immediate')p.setTick(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs+0.9);
   }
   return result;
  };
  const monotonicNow=()=>{
   const value=p.monotonicNow();
   // This runs at the first postcommit sample. Its queued change occurs before
   // external's queued callback, so a check outside that callback is too early.
   if(mode==='microtask'&&observedCommitted&&!scheduled){scheduled=true;queueMicrotask(()=>p.setTick(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs+0.9));}
   return value;
  };
  const spy=vi.spyOn(f.db,'transaction').mockImplementation(wrapper as Db['transaction']);
  try{await expect(p.service({monotonicNow}).prepare(p.actor.wallet,p.consent.creationIntentId)).rejects.toMatchObject(preparationRefusal('STALE'));}
  finally{spy.mockRestore();}
  expect(observedCommitted).toBe(true);if(mode==='microtask')expect(scheduled).toBe(true);
  expect(await f.sql`select id from charter_creation_issuance_attempts where reservation_id=${p.consent.reservationId}`).toHaveLength(1);
  expect(p.issuer.issueOnce).not.toHaveBeenCalled();
  p.setTick(0);const recovered=await p.service().recover(p.actor.wallet,p.consent.creationIntentId);expect(recovered.preparation).toBeNull();
  expect(await p.service().prepare(p.actor.wallet,p.consent.creationIntentId)).toEqual(recovered);
  expect(p.issuer.lookup).toHaveBeenCalledTimes(2);expect(p.issuer.issueOnce).not.toHaveBeenCalled();expect(p.rpc.getLatestBlockhashAndContext).toHaveBeenCalledTimes(1);
 }
},120_000);

it('lets the independent issuer refuse delayed pause, rotation, expiry and full-precision stale signing',async()=>{
 const f=fixture();
 for(const mode of ['pause','rotation','expiry','age','backwards']){
  const p=await f.admitted(await f.actor()),delay=gate();p.hooks.beforePolicy=delay.enter;if(mode==='backwards')p.setIssuerTick(50);
  const work=outcome(p.service().prepare(p.actor.wallet,p.consent.creationIntentId));
  try{
   await Promise.race([delay.arrived,work.then(r=>{if(!r.ok)throw r.error;throw Error('Issuer delay not reached');})]);
   if(mode==='pause')p.bank.row.data[p.bank.offsets['paused']!]=1;
   if(mode==='rotation')Keypair.generate().publicKey.toBuffer().copy(p.bank.row.data,p.bank.offsets['current']!);
   if(mode==='expiry')p.bank.clock.writeBigInt64LE(p.admission.candidate.expiry,32);
   if(mode==='age')p.setIssuerTick(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs+0.9);
   if(mode==='backwards')p.setIssuerTick(49);
   delay.release();expect(await work).toMatchObject({ok:false,error:preparationRefusal('UNCERTAIN')});expect(p.signatures()).toBe(0);
   expect((await p.service().recover(p.actor.wallet,p.consent.creationIntentId)).preparation).toBeNull();
   expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);expect((await f.inventory().loadForCancellation(p.consent.creationIntentId)).permitInventory.messages).toEqual([p.candidate]);
  }finally{delay.release();await work;}
 }
},120_000);

it('retains an already-issued response arriving after expiry, cancellation and refund without repeating effects',async()=>{
 const f=fixture(),p=await f.admitted(),reply=gate();p.hooks.afterSign=reply.enter;
 const work=outcome(p.service().prepare(p.actor.wallet,p.consent.creationIntentId));
 try{
  await Promise.race([reply.arrived,work.then(r=>{if(!r.ok)throw r.error;throw Error('Actual signature not reached');})]);expect(p.signatures()).toBe(1);
  const inventory=await f.inventory().read(p.actor.wallet,p.consent.creationIntentId),bank=terminalBank(inventory);bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);
  const terminal=createCharterCreationTerminal(f.db,{chain:bank.chain});expect((await terminal.recover(p.actor.wallet,p.consent.creationIntentId)).state).toBe('cancelled_unpaid');
  await p.actor.refresh();expect((await terminal.claimRefund(p.actor.wallet,p.consent.creationIntentId)).state).toBe('refunded');
  const before=await f.terminalSnapshot();p.bank.clock.writeBigInt64LE(p.admission.candidate.expiry+1n,32);process.env['PHASE_E_CHARTER_ENABLED']='false';
  reply.release();const result=await work;if(!result.ok)throw result.error;expect(result.value.preparation).not.toBeNull();
  expect(await f.terminalSnapshot()).toEqual(before);expect(p.issuer.issueOnce).toHaveBeenCalledTimes(1);
  expect(await createCharterCreationPreparation(f.db,{chain:null,issuer:null}).prepare(p.actor.wallet,p.consent.creationIntentId)).toEqual(result.value);
 }finally{reply.release();await work;}
});

it('rechecks age, flags and active original slot after a real base lock wait before attempt commit',async()=>{
 const f=fixture(),p=await f.admitted(),owner=await f.dedicatedOwner();
 try{for(const mode of ['age','flags','slot']){
  await p.actor.refresh();p.setTick(0);await owner.sql`begin`;const [pid]=await owner.sql`select pg_backend_pid() pid`;
  await owner.sql`select id from bases where id=${p.actor.baseId} for update`;
  const work=outcome(p.service().prepare(p.actor.wallet,p.consent.creationIntentId));
  try{
   await waitForPolicyLock(f,Number(pid!.pid),work);
   if(mode==='age')p.setTick(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs+0.9);
   if(mode==='flags')process.env['PHASE_E_CHARTER_ENABLED']='false';if(mode==='slot')await owner.sql`update base_slots set active=false where base_id=${p.actor.baseId}`;
   await owner.sql`commit`;expect(await work).toMatchObject({ok:false,error:preparationRefusal(mode==='age'?'STALE':'HELD')});
  }finally{await owner.sql`rollback`;await work;process.env['PHASE_E_CHARTER_ENABLED']='true';}
  await f.sql`update base_slots set active=true where base_id=${p.actor.baseId}`;expect(await f.attempts()).toHaveLength(0);expect(p.issuer.issueOnce).not.toHaveBeenCalled();
 }}finally{await owner.sql.end();}
},120_000);

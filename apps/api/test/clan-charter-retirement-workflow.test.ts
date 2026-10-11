import {expect,it,vi} from 'vitest';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {createCharterCreationWorkflow} from '../src/game/clanCharterCreationWorkflow';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterMemberSettlement} from '../src/game/clanCharterMemberSettlement';
import {charterRetirementWorkflowFixture} from './fixtures/charterRetirementWorkflow';
import {saleGate} from './fixtures/charterSalesWorkflow';

it('delivers paid original retirement and removes the captured roster without a second member debit, preserving original receipts offline',async()=>{
 const f=await charterRetirementWorkflowFixture({positive:true});try{
  expect(f.cut).toBeGreaterThan(0n);expect(f.payment.totalShards).toBe(f.cut.toString());
  const history=await createCharterCreationWorkflow(f.db).read(f.actor,f.birth.consent.creationIntentId),ledger=await f.sql`select * from ledger_entries order by id`;
  const signed=await f.preparedSigned();expect(signed.status).toBe('signed');
  expect(await f.service().deliver(f.actor,f.cleared.id)).toMatchObject({status:'submitted',signature:signed.signed!.signature});
  expect(f.sent).toEqual([Buffer.from((await f.store.read(f.actor,f.cleared.id)).signed!.signedTransactionHex,'hex')]);
  await f.finalizeRetirement();const completed=await f.service().recover(f.actor,f.cleared.id);
  expect(completed).toMatchObject({status:'completed',terminal:{outcome:'completed'},retirementAuthorized:false});
  expect(await f.sql`select id from clans where id=${f.birth.consent.clanId}`).toHaveLength(0);
  expect(await f.sql`select player_wallet from clan_members where clan_id=${f.birth.consent.clanId}`).toHaveLength(0);
  expect(await f.sql`select * from ledger_entries order by id`).toEqual(ledger);
  f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const offline=f.service({chain:null,issuer:null,recovery:null,delivery:null});
  for(const method of ['read','prepare','recoverPreparation','recover','cancel'] as const)expect(await offline[method](f.actor,f.cleared.id)).toEqual(completed);
  expect(await offline.deliver(f.actor,f.cleared.id)).toMatchObject({status:'terminal',operation:completed});
  expect(await createCharterCreationWorkflow(f.db).read(f.actor,f.birth.consent.creationIntentId)).toEqual(history);
  expect(await createClanCharterMemberFences(f.db).read(f.fence.fenceId)).toEqual(f.fence);
  expect(await createClanCharterMemberSettlement(f.db).read(f.actor,f.fence.fenceId)).toEqual(f.payment);
  expect(f.signing).toHaveBeenCalledTimes(1);expect(f.sent).toHaveLength(1);
 }finally{await f.close();}
},120000);

it('keeps an uncertain broadcast recoverable after restart and observes finalized success while new admission is paused',async()=>{
 const f=await charterRetirementWorkflowFixture();try{
  await f.preparedSigned();const saved=await f.store.read(f.actor,f.cleared.id);
  f.retirementHooks.afterSend=async()=>{throw Error('Lost response after actual transport accepted exact wire');};
  expect(await f.service().deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN'});
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(saved);
  expect(await f.service().deliver(f.actor,f.cleared.id)).toMatchObject({status:'observed'});expect(f.sent).toHaveLength(1);
  await f.finalizeRetirement();vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
  expect(await f.service({chain:null,issuer:null,delivery:null}).recover(f.actor,f.cleared.id)).toMatchObject({status:'completed'});
  expect(f.signing).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
},120000);

it('requires complete original expiry and genuine absence before cancellation, retaining consent and member payment',async()=>{
 const f=await charterRetirementWorkflowFixture({positive:true});try{
  await f.preparedSigned();const saved=await f.store.read(f.actor,f.cleared.id);
  await expect(f.service().cancel(f.actor,f.cleared.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_HELD'});
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(saved);expect(f.sent).toHaveLength(0);
  await f.expire();expect(await f.service().deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'EXPIRED_UNRESOLVED'});
  const cancelled=await f.service().cancel(f.actor,f.cleared.id);expect(cancelled.status).toBe('cancelled');
  expect(await f.sql`select id from clans where id=${f.birth.consent.clanId}`).toHaveLength(1);
  const after=await f.store.read(f.actor,f.cleared.id);expect(after.inventory).toEqual(saved.inventory);expect(after.signed).toEqual(saved.signed);expect(after.memberPayment).toEqual(saved.memberPayment);
  f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await f.service({chain:null,issuer:null,recovery:null}).recover(f.actor,f.cleared.id)).toEqual(cancelled);
 }finally{await f.close();}
},120000);

it('refuses a substituted permanent receipt and cannot reinterpret an observed retirement as absent',async()=>{
 const f=await charterRetirementWorkflowFixture();try{
  await f.preparedSigned();const before=await f.store.read(f.actor,f.cleared.id);await f.finalizeRetirement();
  const receipt=f.bank.rows.find(row=>row.data.length===250)!;const original=Buffer.from(receipt.data);receipt.data[193]=receipt.data[193]!^1;
  await expect(f.service().recover(f.actor,f.cleared.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_HELD'});
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(before);expect(await f.sql`select id from clans where id=${f.birth.consent.clanId}`).toHaveLength(1);
  original.copy(receipt.data);expect(await f.service().recover(f.actor,f.cleared.id)).toMatchObject({status:'completed'});
 }finally{await f.close();}
},120000);

it('checks fresh delivery policy after previous awaits and holds changed pins or late pause without sending',async()=>{
 const f=await charterRetirementWorkflowFixture();try{
  await f.preparedSigned();const delivery=f.retirementOptions().delivery!;
  expect(await f.service({delivery:{...delivery,lookupTable:{...delivery.lookupTable,dataSha256:'00'.repeat(32)}}}).deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'IDENTITY'});
  let clock=0;const originalHeight=f.retirementRpc.getBlockHeight.getMockImplementation()!;
  f.retirementRpc.getBlockHeight.mockImplementation(async()=>{clock=PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs+1;return originalHeight();});
  expect(await f.service({monotonicNow:()=>clock}).deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'ADMISSION_HELD'});
  f.retirementRpc.getBlockHeight.mockImplementation(async()=>{vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');return originalHeight();});
  clock=0;vi.stubEnv('PHASE_E_CHARTER_ENABLED','true');expect(await f.service({monotonicNow:()=>clock}).deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'PAUSED'});
  expect(f.sent).toHaveLength(0);expect((await f.store.read(f.actor,f.cleared.id)).status).toBe('signed');
 }finally{await f.close();}
},120000);

it('retains the bounded transport slot after deadline while an ignored-abort RPC is still outstanding',async()=>{
 const f=await charterRetirementWorkflowFixture();const gate=saleGate();try{
  await f.preparedSigned();const delivery=f.retirementOptions().delivery!,service=f.service({delivery:{...delivery,timeoutMs:50}});
  f.retirementRpc.getSignatureStatuses.mockImplementation(async()=>{await gate.enter();return {context:{slot:150},value:[null]};});
  for(let i=0;i<PHASE_E_CHARTER_PREPARATION.maxPending;i++)expect(await service.deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'TIMEOUT'});
  expect(await service.deliver(f.actor,f.cleared.id)).toMatchObject({status:'held',reason:'BUSY'});expect(f.sent).toHaveLength(0);
  gate.release();await new Promise<void>(resolve=>setImmediate(resolve));
  // Prove the same bounded slot becomes usable without requiring the full SQL
  // clearance reread and delivery journey to fit this deliberate 50 ms deadline.
  f.retirementRpc.getSignatureStatuses.mockImplementation(async()=>({context:{slot:150},value:[{slot:150,confirmations:null,err:null,confirmationStatus:'finalized' as const}]}));
  expect(await service.deliver(f.actor,f.cleared.id)).toMatchObject({status:'observed',reason:'OBSERVED_TRANSACTION'});
 }finally{gate.release();await f.close();}
},120000);

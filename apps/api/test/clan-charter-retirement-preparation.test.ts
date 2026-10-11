/** Real prospective birth, database fence/payment/clearance and durable typed
 * issuer. Finalized bank bytes are fixtures; validator proof lives separately. */
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VersionedTransaction} from '@solana/web3.js';
import {expect,it,vi} from 'vitest';
import {sign} from '../../../packages/chain/src/testFixtures/charterPreparation';
import {createCharterPolicyIssuer} from '../src/charterPolicyIssuer';
import {initializeCharterIssuerJournal} from '../src/charterPolicyIssuerJournal';
import {createClanCharterMemberFences} from '../src/game/clanCharterMemberFences';
import {createClanCharterRetirementPreparation,type TypedCharterRetirementIssuer} from '../src/game/clanCharterRetirementPreparation';
import {createClanCharterRetirementsStore} from '../src/db/charterRetirements';
import {charterSalesWorkflowFixture} from './fixtures/charterSalesWorkflow';

async function fixture(){
 const f=await charterSalesWorkflowFixture(),directory=await mkdtemp(path.join(tmpdir(),'charter-retirement-prep-'));
 let issuer:Awaited<ReturnType<typeof createCharterPolicyIssuer>>|undefined;
 try{
  const actor=f.birth.actor.wallet,fence=await createClanCharterMemberFences(f.db).begin(actor,{clanId:f.birth.consent.clanId,idempotencyKey:randomUUID()});
  const payment=await f.memberSettlement().settle(actor,fence.fenceId),journalFile=path.join(directory,'issuer.jsonl');
  await initializeCharterIssuerJournal(journalFile,{genesisHash:f.chain.trust.expectedGenesisHash,economyProgram:f.chain.trust.economy.programId});
  const signing=vi.fn((bytes:Uint8Array)=>sign(f.policy,bytes));
  issuer=await createCharterPolicyIssuer({journalFile,trust:f.chain.trust,connect:f.connect,signer:{publicKey:f.policy.publicKey.toBase58(),sign:signing}});
  const typed:TypedCharterRetirementIssuer={issueOnce:vi.fn(issuer.issueOnce),lookup:vi.fn(issuer.lookup)},store=createClanCharterRetirementsStore(f.db);
  const service=(override:Partial<Parameters<typeof createClanCharterRetirementPreparation>[1]>={})=>createClanCharterRetirementPreparation(f.db,{chain:f.chain,issuer:typed,...override});
  const input={fenceId:fence.fenceId,idempotencyKey:randomUUID()},cleared=await service().create(actor,input);
  async function close(){try{await issuer?.close();}finally{try{await f.dispose();}finally{await rm(directory,{recursive:true,force:true});vi.restoreAllMocks();vi.unstubAllEnvs();}}}
  return {...f,actor,fence,payment,signing,typed,store,service,input,cleared,close};
 }catch(error){await issuer?.close();await f.dispose();await rm(directory,{recursive:true,force:true});vi.unstubAllEnvs();throw error;}
}
it('binds real paid clearance to one candidate, durable policy consent and exact leader wire without dissolving or releasing',async()=>{
 const f=await fixture();try{
  expect(f.cleared.status).toBe('cleared');expect(f.cleared.memberPayment).toMatchObject({id:f.payment.id,totalShards:'0'});
  const before=await f.salesSnapshot(),prepared=await f.service().prepare(f.actor,f.cleared.id);
  expect(prepared).toMatchObject({status:'prepared',signingAuthorized:false,relayAuthorized:false,retirementAuthorized:false,fenceReleaseAuthorized:false});
  expect(f.signing).toHaveBeenCalledTimes(1);expect(f.typed.issueOnce).toHaveBeenCalledWith(expect.objectContaining({kind:'charter-retirement-v1'}),expect.any(AbortSignal));
  const tx=VersionedTransaction.deserialize(Buffer.from(prepared.preparation!.packet.unsignedTransactionHex,'hex'));tx.sign([f.keys.get(f.actor)!]);
  const signed=await f.service().retainSigned(f.actor,f.cleared.id,tx.serialize());expect(signed.status).toBe('signed');
  expect(await f.service().retainSigned(f.actor,f.cleared.id,tx.serialize())).toEqual(signed);
  expect(await f.salesSnapshot()).toBe(before);const retained=await f.store.read(f.actor,f.cleared.id);expect(retained.inventory).toMatchObject({revision:'1',count:1});
  // Exposure is permanent even after an uncertain response; no caller input can
  // replace this one candidate or erase the inventory used for cancellation.
  expect(await f.store.beginAttempt(f.actor,f.cleared.id,null,{elapsedMs:NaN})).toEqual(retained);
  await expect(f.sql`delete from charter_retirement_attempts where retirement_id=${f.cleared.id}`).rejects.toThrow();
  await expect(f.sql`update charter_retirement_attempts set record=record where retirement_id=${f.cleared.id}`).rejects.toThrow();
  expect(await f.store.read(f.actor,f.cleared.id)).toEqual(retained);
  f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const offline=f.service({chain:null,issuer:null});
  expect(await offline.create(f.actor,f.input)).toEqual(signed);expect(await offline.read(f.actor,f.cleared.id)).toEqual(signed);
  expect(await offline.prepare(f.actor,f.cleared.id)).toEqual(signed);expect(f.signing).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
},120000);
it('recovers a durably issued consent after a lost response with lookup only, even when admission and current sources disappear',async()=>{
 const f=await fixture();try{
  const issue=vi.fn(async(...args:Parameters<TypedCharterRetirementIssuer['issueOnce']>)=>{await f.typed.issueOnce(...args);throw Error('Fixture response lost');});
  const interrupted=f.service({issuer:{issueOnce:issue,lookup:f.typed.lookup}});
  await expect(interrupted.prepare(f.actor,f.cleared.id)).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_HELD'});
  expect((await f.store.read(f.actor,f.cleared.id)).status).toBe('issuing');expect(f.signing).toHaveBeenCalledTimes(1);
  f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');const resumed=f.service({chain:null,issuer:{issueOnce:issue,lookup:f.typed.lookup}});
  const recovered=await resumed.prepare(f.actor,f.cleared.id);expect(recovered.status).toBe('prepared');
  expect(issue).toHaveBeenCalledTimes(1);expect(f.signing).toHaveBeenCalledTimes(1);expect(f.typed.lookup).toHaveBeenCalledTimes(1);
  expect((await f.store.read(f.actor,f.cleared.id)).inventory.count).toBe(1);
 }finally{await f.close();}
},120000);
it('refuses caller source fields, another wallet and unsigned bytes without exposing another permit or changing the clan',async()=>{
 const f=await fixture();try{
  const before=await f.salesSnapshot();await expect(f.service().create(f.actor,{...f.input,clearanceHash:'00'.repeat(32)})).rejects.toMatchObject({code:'CLAN_CHARTER_RETIREMENT_INPUT'});
  await expect(f.service().prepare(f.buyer.wallet,f.cleared.id)).rejects.toThrow();expect(f.signing).not.toHaveBeenCalled();
  const prepared=await f.service().prepare(f.actor,f.cleared.id);
  await expect(f.service().retainSigned(f.actor,f.cleared.id,Buffer.from(prepared.preparation!.packet.unsignedTransactionHex,'hex'))).rejects.toThrow();
  expect((await f.store.read(f.actor,f.cleared.id)).signed).toBeNull();expect(await f.salesSnapshot()).toBe(before);expect(f.signing).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
},120000);

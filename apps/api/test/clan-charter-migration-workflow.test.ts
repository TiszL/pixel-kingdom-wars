import {randomUUID} from 'node:crypto';
import {expect,it,vi} from 'vitest';
import {PHASE_E_CHARTER_ADMISSION,PHASE_E_CHARTER_PREPARATION} from '@shardkeep/shared';
import {createClanCharterMigrationWorkflow} from '../src/game/clanCharterMigrationWorkflow';
import {charterMigrationWorkflowFixture} from './fixtures/charterMigrationWorkflow';
import {gate} from './fixtures/charterCreationWorkflow';
it('existing landless original registers once, delivers exact bytes and cuts over the same roster with no repeated SHARDS charge',async()=>{
 const f=await charterMigrationWorkflowFixture();try{const service=f.service(),before=await f.salesSnapshot();expect(await service.create(f.actor,f.input)).toEqual(f.pending);
  const race=await Promise.allSettled([service.prepare(f.actor,f.pending.id),service.prepare(f.actor,f.pending.id)]);const winners=race.filter((r):r is PromiseFulfilledResult<Awaited<ReturnType<typeof service.prepare>>>=>r.status==='fulfilled');expect(winners.length).toBeGreaterThan(0);for(const refused of race.filter(r=>r.status==='rejected'))expect((refused as PromiseRejectedResult).reason).toMatchObject({code:'CLAN_CHARTER_MIGRATION_BUSY'});const same=await service.prepare(f.actor,f.pending.id);for(const winner of winners)expect(winner.value.attempt?.candidateHex).toBe(same.attempt?.candidateHex);expect(f.typed.issueOnce).toHaveBeenCalledTimes(1);
  const {bytes,state}=await f.signed();const changed=Buffer.from(bytes);changed[changed.length-1]=changed[changed.length-1]!^1;await expect(service.retainSigned(f.actor,state.id,changed)).rejects.toThrow();
  expect(await service.deliver(f.actor,state.id)).toMatchObject({status:'submitted',signature:state.signed!.signature});expect(Buffer.from(f.rpc.sendRawTransaction.mock.calls[0]![0])).toEqual(bytes);
  await f.finalize();const controlled=await service.recover(f.actor,state.id);expect(controlled.status).toBe('controlled');expect(await f.salesSnapshot()).toBe(before);
  expect(await f.sql`select * from charter_creation_reservations`).toHaveLength(0);expect(await f.sql`select * from charter_creation_funding_posts`).toHaveLength(0);expect(await f.sql`select * from bases where owner_wallet=${f.actor}`).toHaveLength(0);
  vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');f.setOnline(false);const offline=createClanCharterMigrationWorkflow(f.db);
  expect(await offline.recover(f.actor,state.id)).toEqual(controlled);expect(await offline.prepare(f.actor,state.id)).toEqual(controlled);expect(await offline.deliver(f.actor,state.id)).toMatchObject({status:'terminal'});expect(await offline.create(f.actor,f.input)).toEqual(controlled);
 }finally{await f.close();}
},120000);
it('lost issuance reply recovers only the saved candidate through lookup and never signs a replacement',async()=>{
 const f=await charterMigrationWorkflowFixture();try{f.hooks.afterIssue=async()=>{throw Error('Lost issue reply');};const service=f.service();await expect(service.prepare(f.actor,f.pending.id)).rejects.toThrow();const issued=await f.store.read(f.actor,f.pending.id);expect(issued.status).toBe('issuing');expect(issued.inventory.count).toBe(1);
  f.hooks.lookupNull=true;expect((await service.prepare(f.actor,issued.id)).status).toBe('issuing');expect(f.typed.issueOnce).toHaveBeenCalledTimes(1);
  f.hooks.lookupNull=false;const recovered=await f.service({chain:null}).recoverPreparation(f.actor,issued.id);expect(recovered.status).toBe('prepared');expect(recovered.attempt).toEqual(issued.attempt);expect(f.signing).toHaveBeenCalledTimes(1);expect(f.typed.issueOnce).toHaveBeenCalledTimes(1);
 }finally{await f.close();}
},120000);
it('complete exposed inventory must expire before cancellation and original history survives later membership and another migration',async()=>{
 const f=await charterMigrationWorkflowFixture();try{const service=f.service(),before=await f.salesSnapshot();await f.signed();await expect(service.cancel(f.actor,f.pending.id)).rejects.toThrow();expect((await f.store.read(f.actor,f.pending.id)).terminal).toBeNull();
  await f.expire();const cancelled=await service.cancel(f.actor,f.pending.id);expect(cancelled.status).toBe('cancelled');expect(await f.salesSnapshot()).toBe(before);
  await f.sql`insert into clan_members(player_wallet,clan_id) values(${f.buyer.wallet},${f.clanId})`;const next=await service.create(f.actor,{clanId:f.clanId,idempotencyKey:randomUUID()});expect(next.snapshot.memberCount).toBe(2);
  f.setOnline(false);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect(await createClanCharterMigrationWorkflow(f.db).cancel(f.actor,cancelled.id)).toEqual(cancelled);
 }finally{await f.close();}
},120000);
it('expired admission never reaches first issuer dispatch and keeps the committed candidate recoverable',async()=>{
 const f=await charterMigrationWorkflowFixture();try{const before=await f.salesSnapshot();let samples=0;const service=f.service({monotonicNow:()=>++samples>=5?PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs+0.1:0});await expect(service.prepare(f.actor,f.pending.id)).rejects.toThrow();expect(f.typed.issueOnce).not.toHaveBeenCalled();expect(f.signing).not.toHaveBeenCalled();expect((await f.store.read(f.actor,f.pending.id)).inventory.count).toBe(1);expect(await f.salesSnapshot()).toBe(before);f.hooks.lookupNull=true;expect((await f.service().recoverPreparation(f.actor,f.pending.id)).status).toBe('issuing');expect(f.typed.issueOnce).not.toHaveBeenCalled();
 }finally{await f.close();}
},120000);
it('relay rechecks current policy and preserves exact saved wire after an uncertain send',async()=>{
 const f=await charterMigrationWorkflowFixture();try{const {state}=await f.signed();const service=f.service();f.bank.setPaused(true);
  const held=await service.deliver(f.actor,state.id);expect(held.status).toBe('held');expect(f.rpc.sendRawTransaction).not.toHaveBeenCalled();f.bank.setPaused(false);
  f.hooks.afterSend=async()=>{throw Error('Lost send reply');};expect(await service.deliver(f.actor,state.id)).toMatchObject({status:'held',reason:'SEND_UNCERTAIN'});expect((await f.store.read(f.actor,state.id)).signed).toEqual(state.signed);
  expect(await service.deliver(f.actor,state.id)).toMatchObject({status:'observed',reason:'OBSERVED_TRANSACTION'});expect(f.rpc.sendRawTransaction).toHaveBeenCalledTimes(1);await f.finalize();expect((await service.recover(f.actor,state.id)).status).toBe('controlled');
 }finally{await f.close();}
},120000);
it('ignored issuer lookup aborts retain the persistent budget until actual work drains',async()=>{
 const f=await charterMigrationWorkflowFixture();const wait=gate();try{f.hooks.afterIssue=async()=>{throw Error('Lost reply');};await expect(f.service().prepare(f.actor,f.pending.id)).rejects.toThrow();f.hooks.beforeLookup=()=>wait.enter();const service=f.service({timeoutMs:20});
  for(let n=0;n<PHASE_E_CHARTER_PREPARATION.maxPending;n++)await expect(service.recoverPreparation(f.actor,f.pending.id)).rejects.toThrow();const count=f.typed.lookup.mock.calls.length;
  await expect(service.recoverPreparation(f.actor,f.pending.id)).rejects.toThrow();expect(f.typed.lookup).toHaveBeenCalledTimes(count);expect(count).toBe(PHASE_E_CHARTER_PREPARATION.maxPending);wait.release();await new Promise(resolve=>setTimeout(resolve,0));f.hooks.beforeLookup=async()=>{};
  expect((await service.recoverPreparation(f.actor,f.pending.id)).status).toBe('prepared');expect(f.typed.issueOnce).toHaveBeenCalledTimes(1);
 }finally{wait.release();await f.close();}
},120000);

import {randomUUID} from 'node:crypto';
import {createCharterTournamentEventsClient} from '../src/game/clanCharterTournamentEventsClient';
import {CharterTournamentEventsSchema,CharterTournamentParticipationSchema} from '@shardkeep/shared/charterTournamentApi';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {charterTournamentWorkflowFixture,type CharterTournamentWorkflowFixture} from './fixtures/charterTournamentWorkflow';
import type {CharterRecoverySource} from '../src/game/clanCharterRecoveryRuntime';
let f:CharterTournamentWorkflowFixture|undefined;
beforeEach(async()=>{f=await charterTournamentWorkflowFixture();},120000);
afterEach(async()=>{const previous=f;f=undefined;try{await previous?.dispose();}finally{vi.restoreAllMocks();vi.unstubAllEnvs();}},120000);
it('funded entry requires the exact retained leader wire and finalized set before freezing participation',async()=>{
 const c=f!,entry=await c.entry(),id=entry.state.set.original.operation.id;expect(entry.state.status).toBe('pending');
 expect(await c.sql`select * from charter_tournament_entry_completions`).toHaveLength(0);
 const prepared=await c.prepare(id);expect(prepared.status).toBe('prepared');
 await c.service().retainSigned(c.source.wallet,id,c.signed(prepared));expect((await c.service().deliver(c.source.wallet,id)).status).toBe('submitted');
 await c.finalizeLock(id);expect((await c.service().recover(c.source.wallet,id)).status).toBe('completed');
 const done=await c.service().readEntry(c.source.wallet,entry.state.id);expect(done.status).toBe('entered');expect(done.roster).toEqual([c.source.wallet]);
 expect(await c.sql`select revision::text from charter_sale_heads where clan_id=${c.birth.consent.clanId}`).toEqual([{revision:'1'}]);
 expect(await c.sql`select * from charter_tournament_entry_completions`).toHaveLength(1);
 expect((await c.service().createEntry(c.source.wallet,entry.input)).id).toBe(entry.state.id);
 await expect(c.store().create(c.source.wallet,{clanId:c.birth.consent.clanId,buyer:c.buyer.wallet,priceLamports:'100000003',sellerLeaves:true,idempotencyKey:randomUUID()},c.domain)).rejects.toThrow();
});
it('lost issuer response survives restart through lookup only and cannot reopen current admission',async()=>{
 const c=f!,entry=await c.entry(),id=entry.state.set.original.operation.id;c.lockHooks.afterIssue=async()=>{throw Error('lost issuer reply');};
 await expect(c.prepare(id)).rejects.toThrow();const saved=await c.tournamentStore.readOperation(c.source.wallet,id);expect(saved.status).toBe('issuing');expect(saved.inventory.count).toBe(1);
 c.lockHooks.lookupNull=true;expect((await c.service().prepare(c.source.wallet,id)).status).toBe('issuing');
 c.lockHooks.lookupNull=false;expect((await c.service().recoverPreparation(c.source.wallet,id)).status).toBe('prepared');expect(c.lockIssuer.issueOnce).toHaveBeenCalledTimes(1);
 vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');expect((await c.service({chain:null,issuer:null,delivery:null}).readOperation(c.source.wallet,id)).status).toBe('prepared');
});
it('an expired never-executed original releases its fence only under strict unchanged-registry cancellation',async()=>{
 const c=f!,entry=await c.entry(),id=entry.state.set.original.operation.id,prepared=await c.prepare(id),expiry=Buffer.from(prepared.attempt!.candidateHex,'hex').readBigInt64LE(121);
 c.bank.clock.writeBigInt64LE(expiry,32);await expect(c.service().cancel(c.source.wallet,id)).rejects.toThrow();
 c.bank.clock.writeBigInt64LE(expiry+1n,32);expect((await c.service().cancel(c.source.wallet,id)).status).toBe('cancelled');
 expect((await c.service().readEntry(c.source.wallet,entry.state.id)).status).toBe('cancelled');
 const next=await c.service().createEntry(c.source.wallet,c.request());expect(next.id).not.toBe(entry.state.id);
});

function originalRecovery(c:CharterTournamentWorkflowFixture){
 const rpc=c.lockRpc,connect=vi.fn<CharterRecoverySource['connect']>(()=>({getGenesisHash:rpc.getGenesisHash.bind(rpc),getSlot:rpc.getSlot.bind(rpc),
  getMultipleAccountsInfoAndContext:rpc.getMultipleAccountsInfoAndContext.bind(rpc),getTransaction:rpc.getTransaction.bind(rpc)}));
 return {trust:structuredClone(c.lockChain.trust),connect};
}
it('recovers a retained signed original with only read trust while paused and keeps explicit null closed',async()=>{
 const c=f!,entry=await c.entry(),id=entry.state.set.original.operation.id,prepared=await c.prepare(id),wire=c.signed(prepared);
 const retained=await c.service().retainSigned(c.source.wallet,id,wire);await c.finalizeLock(id);const recovery=originalRecovery(c);
 await expect(c.service({recovery:null}).recover(c.source.wallet,id)).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_CONFIGURATION'});
 const wrong={trust:{...recovery.trust,core:{...recovery.trust.core,reviewedProgramDataSha256:'00'.repeat(32)}},connect:recovery.connect};
 await expect(c.service({chain:null,issuer:null,delivery:null,recovery:wrong}).recover(c.source.wallet,id)).rejects.toThrow();expect(recovery.connect).not.toHaveBeenCalled();
 const service=c.service({chain:null,issuer:null,delivery:null,recovery});await expect(service.recover(c.buyer.wallet,id)).rejects.toMatchObject({statusCode:404});expect(recovery.connect).not.toHaveBeenCalled();
 Reflect.set(recovery.trust.core,'reviewedProgramDataSha256','00'.repeat(32));recovery.connect=vi.fn<CharterRecoverySource['connect']>(()=>{throw Error('caller retargeted recovery');});
 const issues=vi.mocked(c.lockIssuer.issueOnce).mock.calls.length,lookups=vi.mocked(c.lockIssuer.lookup).mock.calls.length;vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 const completed=await service.recover(c.source.wallet,id);expect(completed.status).toBe('completed');expect(completed.attempt).toEqual(retained.attempt);expect(completed.signed).toEqual(retained.signed);
 expect(vi.mocked(c.lockIssuer.issueOnce).mock.calls).toHaveLength(issues);expect(vi.mocked(c.lockIssuer.lookup).mock.calls).toHaveLength(lookups);expect(c.sent).toHaveLength(0);
 expect(await c.service({chain:null,issuer:null,delivery:null,recovery:null}).recover(c.source.wallet,id)).toEqual(completed);
 expect(await c.sql`select * from charter_tournament_entry_completions`).toHaveLength(1);
});
it('uses read-only recovery for strict original expiry cancellation without authorizing a new quote',async()=>{
 const c=f!,entry=await c.entry(),id=entry.state.set.original.operation.id,recovery=originalRecovery(c),service=c.service({chain:null,issuer:null,delivery:null,recovery});
 await expect(service.prepare(c.source.wallet,id)).rejects.toMatchObject({code:'CLAN_CHARTER_TOURNAMENT_HELD'});expect(c.lockIssuer.issueOnce).not.toHaveBeenCalled();expect(recovery.connect).not.toHaveBeenCalled();
 const prepared=await c.prepare(id),expiry=Buffer.from(prepared.attempt!.candidateHex,'hex').readBigInt64LE(121);vi.stubEnv('PHASE_E_CHARTER_ENABLED','false');
 c.bank.clock.writeBigInt64LE(expiry,32);await expect(service.cancel(c.source.wallet,id)).rejects.toThrow();expect((await service.readOperation(c.source.wallet,id)).attempt).toEqual(prepared.attempt);
 c.bank.clock.writeBigInt64LE(expiry+1n,32);const cancelled=await service.cancel(c.source.wallet,id);expect(cancelled.status).toBe('cancelled');expect(cancelled.attempt).toEqual(prepared.attempt);expect(c.lockIssuer.issueOnce).toHaveBeenCalledTimes(1);
 expect(await c.service({chain:null,issuer:null,delivery:null,recovery:null}).recover(c.source.wallet,id)).toEqual(cancelled);
});

it('discovers the funded event before entry and exposes only the actor participation without private funding witnesses',async()=>{
 const c=f!,client=createCharterTournamentEventsClient(c.db,{clock:c.clock});
 const activity=CharterTournamentEventsSchema.parse(await client.activity(c.source.wallet));
 expect(activity.events.map(event=>event.id)).toEqual([c.event.id]);expect(activity.nextCursor).toBeNull();
 expect(activity.events[0]).not.toHaveProperty('funding');
 expect(CharterTournamentParticipationSchema.parse(await client.participation(c.source.wallet,c.event.id))).toEqual({version:1,eventId:c.event.id,entry:null,prize:null,raids:[]});
 await expect(client.activity(c.source.wallet,Buffer.from(JSON.stringify({at:c.event.entryStartsAt,id:c.event.id,unexpected:true})).toString('base64url'))).rejects.toMatchObject({statusCode:400});
});

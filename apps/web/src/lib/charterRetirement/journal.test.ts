import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {RetirementJournalStore} from './journal';
import {retirementFixture} from './testFixture';
import {prepareRetirementSigning,signRetirement} from './signing';
beforeEach(()=>vi.stubGlobal('IDBKeyRange',IDBKeyRange));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){const f=await retirementFixture(),factory=new IDBFactory(),identity={origin:'https://game.example',api:'https://game.example/api',cluster:'devnet' as const,wallet:f.actor},store=new RetirementJournalStore(identity,factory);await store.begin(f.draft.request);return {...f,factory,identity,store};}
it('keeps the original request through restart and binds a reordered HTTP response to its saved key',async()=>{
 const f=await fixture();await f.store.close();const store=new RetirementJournalStore(f.identity,f.factory);
 await store.retain({...f.draft,request:{idempotencyKey:f.draft.request.idempotencyKey,clanId:f.draft.request.clanId}});expect((await store.read()).draft).toEqual(f.draft);
 await expect(store.retain({...f.draft,id:f.original.retirement.id})).rejects.toThrow('saved request');await store.close();
});
it('never repeats a wallet prompt after uncertainty and retains a late valid signature across restart',async()=>{
 const f=await fixture();await f.store.retain(f.draft);await f.store.beginSigning(f.packet.messageSha256);await expect(f.store.beginSigning(f.packet.messageSha256)).rejects.toThrow('Recover');
 const p=await prepareRetirementSigning(f.operation,f.trust,f.actor),wire=await signRetirement(p,{publicKey:f.leader.publicKey,signVersionedTransaction:async tx=>{tx.sign([f.leader]);return tx;}});
 await f.store.retainSigned(wire);await f.store.close();const reopened=new RetirementJournalStore(f.identity,f.factory);expect((await reopened.read()).signed).toEqual(wire);await reopened.close();
});
it('holds approval after a malformed terminal before parsing the rest of that response',async()=>{
 const f=await fixture();await f.store.retain(f.draft);await expect(f.store.retain({...f.draft,operation:{...f.operation,terminal:{id:f.draft.id,outcome:'completed'}}})).rejects.toThrow();
 expect((await f.store.read()).observed).toEqual(['completed']);await expect(f.store.beginSigning(f.packet.messageSha256)).rejects.toThrow('Recover');await expect(f.store.archive()).rejects.toThrow('unresolved');await f.store.close();
});
it('refuses changed member payouts, another actor and replacement preparation without erasing the original',async()=>{
 const f=await fixture();await f.store.retain(f.draft);
 for(const draft of [{...f.draft,actor:f.policy.publicKey.toBase58()},{...f.draft,totalShards:'101'},{...f.draft,shares:[{wallet:f.actor,shards:'99'}]},
  {...f.draft,operation:{...f.operation,preparation:{...f.operation.preparation!,policySignatureHex:'00'.repeat(64)}}}])await expect(f.store.retain(draft)).rejects.toThrow();
 expect((await f.store.read()).draft).toEqual(f.draft);await f.store.close();
});
it('archives a verified cancellation and preserves its payouts while allowing a new request',async()=>{
 const f=await fixture();await f.store.retain(f.draft);const cancelled={...f.draft,operation:{...f.operation,status:'cancelled' as const,terminal:{id:f.draft.id,outcome:'cancelled' as const}}};
 await f.store.retain(cancelled);await expect(f.store.retain(f.draft)).rejects.toThrow('evidence changed');await f.store.archive();
 expect((await f.store.archives())[0]?.draft?.memberPayment).toEqual(f.operation.memberPayment);await f.store.begin({...f.draft.request,idempotencyKey:f.original.retirement.id});expect((await f.store.read()).draft).toBeNull();await f.store.close();
});
it('fails closed when the durable pre-wallet marker cannot be written',async()=>{
 const f=await fixture();await f.store.retain(f.draft);const write=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw Error('Storage full');});
 await expect(f.store.beginSigning(f.packet.messageSha256)).rejects.toThrow('Storage full');write.mockRestore();expect((await f.store.read()).signingStarted).toBe(false);await f.store.close();
});

it('retains known terminal status despite a damaged outcome and keeps opaque finality held until exact terminal recovery',async()=>{
 const f=await fixture();await f.store.retain(f.draft);await expect(f.store.retain({...f.draft,operation:{...f.operation,terminal:{outcome:'damaged'}}})).rejects.toThrow();
 await f.store.retain(f.draft);expect((await f.store.read()).observed).toEqual(['unknown']);await expect(f.store.beginSigning(f.packet.messageSha256)).rejects.toThrow('Recover');
 await expect(f.store.retain({...f.draft,operation:{...f.operation,status:'cancelled',terminal:{outcome:'damaged'}}})).rejects.toThrow();await f.store.retain(f.draft);expect((await f.store.read()).observed).toEqual(['unknown','cancelled']);
 await f.store.retain({...f.draft,operation:{...f.operation,status:'cancelled',terminal:{id:f.draft.id,outcome:'cancelled'}}});expect((await f.store.read()).observed).toEqual(['cancelled']);await f.store.archive();await f.store.close();
});

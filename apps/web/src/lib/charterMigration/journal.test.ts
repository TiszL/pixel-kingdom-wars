import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {IDBFactory,IDBKeyRange,IDBObjectStore} from 'fake-indexeddb';
import {CharterMigrationSchema} from '@shardkeep/shared/charterMigrationApi';
import {MigrationJournalStore} from './journal';
import {migrationFixture} from './testFixture';
beforeEach(()=>vi.stubGlobal('IDBKeyRange',IDBKeyRange));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){const f=migrationFixture(),factory=new IDBFactory(),store=new MigrationJournalStore(f.identity,factory);await store.begin(f.migration.request);return {...f,factory,store};}
it('binds an existing clan snapshot to the leader and registration without inventing a funded reservation',()=>{
 const {migration:m}=migrationFixture();expect(CharterMigrationSchema.parse(m)).toEqual(m);
 for(const changed of [{...m,id:m.request.idempotencyKey},{...m,actor:m.signing!.policy.signer},{...m,snapshot:{...m.snapshot,commitment:'00'.repeat(32)}},{...m,snapshot:{...m.snapshot,clan:{...m.snapshot.clan,id:m.id}}},{...m,price:{shards:'5000'}},{...m,signingAuthorized:true},{...m,status:'controlled'},{...m,status:'signed'}])expect(CharterMigrationSchema.safeParse(changed).success).toBe(false);
});
it('retains the same request and immutable roster/chest snapshot across reply loss and restart',async()=>{
 const f=await fixture();await f.store.close();const s=new MigrationJournalStore(f.identity,f.factory);await s.retain({...f.migration,request:{idempotencyKey:f.migration.request.idempotencyKey,clanId:f.migration.request.clanId}});
 for(const field of ['memberCount','chestShards'] as const)await expect(s.retain({...f.migration,snapshot:{...f.migration.snapshot,[field]:field==='memberCount'?4:'218'}})).rejects.toThrow('terms changed');
 expect((await s.read()).migration).toEqual(f.migration);await s.close();
});
it('requires durable signing intent and saves only the exact valid late wallet wire',async()=>{
 const f=await fixture();await f.store.retain(f.migration);const wire=await f.sign();await expect(f.store.retainSigned(wire)).rejects.toThrow('Save');
 await f.store.beginSigning(f.creation.packet.messageSha256);await expect(f.store.beginSigning(f.creation.packet.messageSha256)).rejects.toThrow('Recover');
 await expect(f.store.retainSigned({...wire,messageSha256:'00'.repeat(32)})).rejects.toThrow();await f.store.retainSigned(wire);await f.store.close();
 const s=new MigrationJournalStore(f.identity,f.factory);expect((await s.read()).signed).toEqual(wire);await s.close();
});
it('keeps malformed terminal evidence through later nonterminal responses and restart',async()=>{
 const f=await fixture();await f.store.retain(f.migration);await expect(f.store.retain({...f.migration,status:'controlled',terminal:{outcome:'damaged'},snapshot:null})).rejects.toThrow();
 await f.store.retain(f.migration);await f.store.close();const s=new MigrationJournalStore(f.identity,f.factory);expect((await s.read()).observed).toEqual(['controlled']);await expect(s.beginSigning(f.creation.packet.messageSha256)).rejects.toThrow('Recover');await expect(s.archive()).rejects.toThrow('unresolved');await s.close();
});
it('does not open approval if the pre-wallet durable write fails',async()=>{
 const f=await fixture();await f.store.retain(f.migration);const write=vi.spyOn(IDBObjectStore.prototype,'put').mockImplementation(()=>{throw Error('Storage full');});
 await expect(f.store.beginSigning(f.creation.packet.messageSha256)).rejects.toThrow('Storage full');write.mockRestore();expect((await f.store.read()).signingStarted).toBe(false);await f.store.close();
});
it('archives controlled history without allowing another response to erase the terminal or existing balances',async()=>{
 const f=await fixture();await f.store.retain(f.migration);await f.store.retain({...f.migration,status:'controlled',terminal:{id:f.migration.id,outcome:'controlled'}});
 await expect(f.store.retain(f.migration)).rejects.toThrow('evidence changed');await f.store.archive();expect((await f.store.archives())[0]?.migration?.snapshot).toEqual(f.migration.snapshot);expect((await f.store.read()).migration).toBeNull();await f.store.close();
});

import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {MigrationController,type MigrationPorts} from './controller';
import {MigrationJournalStore} from './journal';
import {migrationFixture} from './testFixture';
beforeEach(()=>vi.stubGlobal('IDBKeyRange',IDBKeyRange));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){
 const f=migrationFixture(),store=new MigrationJournalStore(f.identity,new IDBFactory());
 let current=true,newActions=true;const requests:string[]=[],ports:MigrationPorts={capture:fresh=>()=>{if(!current||fresh&&!newActions)throw Error('View changed');},key:()=>f.migration.request.idempotencyKey,lock:async(_key,run)=>run(),
  request:async(request,guard,retain)=>{guard();requests.push(request.action);await retain(f.migration);return f.migration;},
  review:async()=>{await f.review();},sign:async()=>f.sign()};
 const controller=new MigrationController(store,ports);return {...f,store,ports,controller,requests,invalidate:()=>{current=false;},resume:()=>{current=true;},pause:()=>{newActions=false;}};
}
it('recovers a lost create response by its saved key without creating another draft',async()=>{
 const f=await fixture();f.ports.request=async r=>{f.requests.push(r.action);throw Error('Response lost');};
 await expect(f.controller.begin(f.migration.request)).rejects.toThrow('lost');expect((await f.store.read()).request).toEqual(f.migration.request);
 f.ports.request=async(r,_guard,retain)=>{f.requests.push(r.action);expect(r.key).toBe(f.migration.request.idempotencyKey);await retain(f.migration);return f.migration;};
 await f.controller.load();expect(f.requests).toEqual(['create','by-key']);expect(f.controller.getSnapshot().journal?.migrationId).toBe(f.migration.id);await f.store.close();
});
it('saves a late signature after navigation and resubmits only its original bytes',async()=>{
 const f=await fixture();await f.controller.begin(f.migration.request);await f.controller.review();const sign=f.ports.sign;let prompts=0;
 f.ports.sign=async(...args)=>{prompts++;const wire=await sign(...args);f.invalidate();return wire;};await expect(f.controller.sign()).rejects.toThrow('View changed');
 const signed=(await f.store.read()).signed;expect(signed).not.toBeNull();expect(f.requests).toEqual(['create']);f.resume();
 f.ports.request=async(r,_guard,retain)=>{f.requests.push(r.action);if(r.action==='signed')expect(r.body).toEqual({signedTransaction:signed!.signedTransaction});
  const draft={...f.migration,status:'signed' as const,wire:signed!};await retain(draft);return draft;};
 await f.controller.deliver();expect(f.requests).toEqual(['create','signed','deliver']);expect(prompts).toBe(1);await f.store.close();
});
it('does not open the wallet when the durable signing marker fails',async()=>{
 const f=await fixture();await f.controller.begin(f.migration.request);await f.controller.review();const wallet=vi.spyOn(f.ports,'sign');vi.spyOn(f.store,'beginSigning').mockRejectedValueOnce(Error('Storage full'));
 await expect(f.controller.sign()).rejects.toThrow('Storage full');expect(wallet).not.toHaveBeenCalled();await f.store.close();
});
it('keeps cached history and recovery available during pause and failed refresh',async()=>{
 const f=await fixture();await f.controller.begin(f.migration.request);f.pause();f.ports.request=async()=>{throw Error('Offline');};await expect(f.controller.load()).rejects.toThrow('Offline');
 expect(f.controller.getSnapshot().journal?.migration).toEqual(f.migration);await expect(f.controller.review()).rejects.toThrow('View changed');
 f.ports.request=async(_r,_guard,retain)=>{const draft={...f.migration,status:'cancelled' as const,terminal:{id:f.migration.id,outcome:'cancelled' as const}};await retain(draft);return draft;};
 await f.controller.command('cancel');expect(f.controller.getSnapshot().journal?.migration?.status).toBe('cancelled');await f.store.close();
});

it('refuses fresh preparation after malformed terminal evidence, while permitting original recovery',async()=>{
 const f=await fixture();await f.controller.begin(f.migration.request);await expect(f.store.retain({...f.migration,status:'controlled',terminal:{outcome:'damaged'}})).rejects.toThrow();
 await expect(f.controller.command('prepare')).rejects.toThrow('Recover');expect(f.requests).toEqual(['create']);await f.controller.command('recover');expect(f.requests).toEqual(['create','recover']);await f.store.close();
});

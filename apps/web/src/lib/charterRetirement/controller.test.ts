import {it,expect,vi,beforeEach,afterEach} from 'vitest';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {RetirementController,type RetirementPorts} from './controller';
import {RetirementJournalStore} from './journal';
import {retirementFixture} from './testFixture';
import {prepareRetirementSigning,signRetirement} from './signing';
beforeEach(()=>vi.stubGlobal('IDBKeyRange',IDBKeyRange));afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();});
async function fixture(){
 const f=await retirementFixture(),store=new RetirementJournalStore({origin:'https://game.example',api:'https://game.example/api',cluster:'devnet',wallet:f.actor},new IDBFactory());
 let current=true,newActions=true;const requests:string[]=[],ports:RetirementPorts={capture:fresh=>()=>{if(!current||fresh&&!newActions)throw Error('View changed');},key:()=>f.draft.request.idempotencyKey,lock:async(_key,run)=>run(),
  request:async(request,guard,retain)=>{guard();requests.push(request.action);await retain(f.draft);return f.draft;},
  review:async()=>{await prepareRetirementSigning(f.operation,f.trust,f.actor);},
  sign:async()=>signRetirement(await prepareRetirementSigning(f.operation,f.trust,f.actor),{publicKey:f.leader.publicKey,signVersionedTransaction:async tx=>{tx.sign([f.leader]);return tx;}})};
 const controller=new RetirementController(store,ports);return {...f,store,ports,controller,requests,invalidate:()=>{current=false;},resume:()=>{current=true;},pause:()=>{newActions=false;}};
}
it('recovers a lost create response by its saved key without creating another draft',async()=>{
 const f=await fixture();f.ports.request=async r=>{f.requests.push(r.action);throw Error('Response lost');};
 await expect(f.controller.begin(f.draft.request)).rejects.toThrow('lost');expect((await f.store.read()).request).toEqual(f.draft.request);
 f.ports.request=async(r,_guard,retain)=>{f.requests.push(r.action);expect(r.key).toBe(f.draft.request.idempotencyKey);await retain(f.draft);return f.draft;};
 await f.controller.load();expect(f.requests).toEqual(['create','by-key']);expect(f.controller.getSnapshot().journal?.draftId).toBe(f.draft.id);await f.store.close();
});
it('saves a late signature after navigation and resubmits only its original bytes',async()=>{
 const f=await fixture();await f.controller.begin(f.draft.request);await f.controller.review();const sign=f.ports.sign;let prompts=0;
 f.ports.sign=async(...args)=>{prompts++;const wire=await sign(...args);f.invalidate();return wire;};await expect(f.controller.sign()).rejects.toThrow('View changed');
 const signed=(await f.store.read()).signed;expect(signed).not.toBeNull();expect(f.requests).toEqual(['create']);f.resume();
 f.ports.request=async(r,_guard,retain)=>{f.requests.push(r.action);if(r.action==='signed')expect(r.body).toEqual({signedTransaction:Buffer.from(signed!.signedTransactionHex,'hex').toString('base64')});
  const draft={...f.draft,operation:{...f.operation,status:'signed' as const,signed:signed!}};await retain(draft);return draft;};
 await f.controller.deliver();expect(f.requests).toEqual(['create','signed','deliver']);expect(prompts).toBe(1);await f.store.close();
});
it('does not open the wallet when the durable signing marker fails',async()=>{
 const f=await fixture();await f.controller.begin(f.draft.request);await f.controller.review();const wallet=vi.spyOn(f.ports,'sign');vi.spyOn(f.store,'beginSigning').mockRejectedValueOnce(Error('Storage full'));
 await expect(f.controller.sign()).rejects.toThrow('Storage full');expect(wallet).not.toHaveBeenCalled();await f.store.close();
});
it('keeps cached history and recovery available during pause and failed refresh',async()=>{
 const f=await fixture();await f.controller.begin(f.draft.request);f.pause();f.ports.request=async()=>{throw Error('Offline');};await expect(f.controller.load()).rejects.toThrow('Offline');
 expect(f.controller.getSnapshot().journal?.draft).toEqual(f.draft);await expect(f.controller.review()).rejects.toThrow('View changed');
 f.ports.request=async(_r,_guard,retain)=>{const draft={...f.draft,operation:{...f.operation,status:'cancelled' as const,terminal:{id:f.draft.id,outcome:'cancelled' as const}}};await retain(draft);return draft;};
 await f.controller.command('cancel');expect(f.controller.getSnapshot().journal?.draft?.operation?.status).toBe('cancelled');await f.store.close();
});

it('blocks payout and preparation after uncertain terminal observation without blocking original recovery',async()=>{
 const f=await fixture();await f.controller.begin(f.draft.request);await expect(f.store.retain({...f.draft,operation:{...f.operation,status:'completed',terminal:{outcome:'damaged'}}})).rejects.toThrow();
 await expect(f.controller.command('prepare')).rejects.toThrow('Recover');await expect(f.controller.command('pay-members')).rejects.toThrow('Recover');expect(f.requests).toEqual(['create']);await f.controller.command('recover');expect(f.requests).toEqual(['create','recover']);await f.store.close();
});

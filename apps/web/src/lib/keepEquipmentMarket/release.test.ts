import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {KeepMarketController,type KeepMarketPorts} from './controller';
import {KeepMarketJournalStore,canRelease,complete,purchase} from './journal';
import {prepareKeepEquipmentSigning} from './signing';
import {keepMarketReleasedFixture} from './fixtures.testHelpers';
const stores:KeepMarketJournalStore[]=[];
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(async()=>{await Promise.all(stores.map(s=>s.close()));stores.length=0;vi.unstubAllGlobals();});
async function setup(signed=false,version:'legacy'|0='legacy',createAta=false){
 const f=keepMarketReleasedFixture(version,createAta),factory=new IDBFactory(),identity={origin:'http://localhost',api:'http://localhost/api',cluster:'devnet' as const,wallet:f.value.fill.buyerWallet};
 const store=new KeepMarketJournalStore(identity,factory);stores.push(store);const key='fill:'+f.value.fill.id;let original=signed?f.signed:f.reserved,paused=false,lost=false,late=false;
 await store.begin({kind:'fill',key:f.value.fill.id,request:{idempotencyKey:f.value.fill.id,listingId:f.value.fill.listingId,buyerBaseId:f.value.fill.buyerBaseId,quantity:'1'}});await store.retain(key,original);
 const calls:string[]=[],ports:KeepMarketPorts={capture:action=>{const guard=()=>{if(action&&paused||late)throw Error('view changed');};guard();return guard;},key:()=>f.value.fill.id,lock:async(_k,run)=>run(),
  request:async(r,guard,retain)=>{calls.push(r.action);guard();if(r.action==='release'){expect((await store.read()).pending[0]!.actions).toContain('release');original=signed?f.released:f.cancelled;if(lost){lost=false;throw Error('reply lost');}}
   if(r.action==='recover'&&signed)original=f.released;await retain(original);guard();return original;},review:vi.fn(async()=>{throw Error('must not review');}),sign:vi.fn(async()=>{throw Error('must not sign');})};
 const controller=new KeepMarketController(store,ports);controller.select(key);
 return {...f,store,key,controller,ports,calls,pause:()=>{paused=true;},drop:()=>{lost=true;},late:()=>{late=true;},reopen:()=>{const next=new KeepMarketJournalStore(identity,factory);stores.push(next);const c=new KeepMarketController(next,ports);c.select(key);return {store:next,controller:c};}};
}
it('cancels a never-prepared original while paused, retaining its terminal receipt and archive identity',async()=>{
 const f=await setup();f.pause();await f.controller.release();const op=(await f.store.read()).pending[0]!;expect(purchase(op)).toEqual(f.cancelled);expect(complete(op)).toBe(true);expect(canRelease(op)).toBe(false);
 await f.controller.archive();const reopened=f.reopen();expect((await reopened.store.read()).archive[0]!.command).toEqual(op.command);expect(f.ports.sign).not.toHaveBeenCalled();expect(f.calls).toEqual(['release']);
});
it.each(['legacy',0] as const)('a lost %s failed-payment release reply recovers and cannot restart payment',async version=>{
 const f=await setup(true,version,version===0);f.drop();f.pause();await expect(f.controller.release()).rejects.toThrow('reply lost');expect((await f.store.read()).pending[0]!.observedComplete).toBe(false);
 const reopened=f.reopen();await reopened.controller.recover();const op=(await reopened.store.read()).pending[0]!;expect(purchase(op)).toEqual(f.released);expect(op.observedComplete).toBe(true);
 for(const run of [()=>reopened.controller.prepare(),()=>reopened.controller.review(),()=>reopened.controller.sign(),()=>reopened.controller.upload(),()=>reopened.controller.deliver()])await expect(run()).rejects.toThrow();
 expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.review).not.toHaveBeenCalled();expect(f.calls).toEqual(['release','recover']);
});
it('refuses release for prepared-but-unknown wallet outcomes, without network or marker changes',async()=>{
 const f=await setup();await f.store.retain(f.key,f.value);await f.store.startSigning(f.key);expect(canRelease((await f.store.read()).pending[0]!)).toBe(false);
 await expect(f.controller.release()).rejects.toThrow('cannot yet be released');expect(f.calls).toEqual([]);expect((await f.store.read()).pending[0]!.signingStarted).toBe(true);
});
it('a terminal release discovered during delivery stops independent review and relay',async()=>{
 const f=await setup(true);await f.controller.deliver();expect(f.calls).toEqual(['recover']);expect(f.ports.review).not.toHaveBeenCalled();expect(purchase((await f.store.read()).pending[0]!)).toEqual(f.released);
});
it('late prepared or signed receipts cannot undo a released original after a durable reopen',async()=>{
 const f=await setup(true);await f.controller.release();const next=f.reopen();for(const raw of [f.value,f.signed])await expect(next.store.retain(f.key,raw)).rejects.toThrow();
 expect(purchase((await next.store.read()).pending[0]!)).toEqual(f.released);await expect(prepareKeepEquipmentSigning(f.released,f.trust,f.value.fill.buyerWallet)).rejects.toThrow();
});
it('a positive release remains held against re-signing when saving its receipt fails',async()=>{
 const f=await setup(true),original=f.store.change.bind(f.store);let fail=true;
 f.store.change=async(key,patch)=>{if(patch.original&&fail){fail=false;throw Error('disk full');}return original(key,patch);};
 await expect(f.store.retain(f.key,f.released)).rejects.toThrow('disk full');expect((await f.store.read()).pending[0]!.observedComplete).toBe(true);
 await expect(f.controller.deliver()).rejects.toThrow();await f.controller.recover();expect(purchase((await f.store.read()).pending[0]!)).toEqual(f.released);
});
it('never-prepared release cannot be attached to an already prepared or differently owned purchase',async()=>{
 const f=await setup();for(const raw of [{...f.cancelled,preparation:f.value.preparation},{...f.cancelled,release:{...f.cancelled.release!,fillId:crypto.randomUUID()}},{...f.released,release:{...f.released.release!,signature:f.buyer.publicKey.toBase58()}}])expect(KeepEquipmentPurchaseSchema.safeParse(raw).success).toBe(false);
 expect((await f.store.read()).pending[0]!.observedComplete).toBe(false);
});

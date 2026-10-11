import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {KEEP_MARKET_ITEM_IDS_V4,KEEP_MARKET_EQUIPMENT_IDS,KEEP_MARKET_CRAFTING_CATALOGUE_IDS,KeepEquipmentPurchaseSchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as MARKET,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as POLICY,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import {ApiError} from '../api';
import {KeepMarketController,type KeepMarketPorts} from './controller';
import {KeepMarketJournalStore,marketKey} from './journal';
import {prepareKeepEquipmentSigning,signKeepEquipment,type KeepEquipmentWire} from './signing';
import {keepMarketFixture} from './fixtures.testHelpers';
const stores:KeepMarketJournalStore[]=[];
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(async()=>{vi.restoreAllMocks();await Promise.all(stores.map(s=>s.close()));stores.length=0;vi.unstubAllGlobals();});
const policy={version:1,decimals:TOKEN.decimals,minFillBaseUnits:MARKET.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:POLICY.reviewMaxAgeMs};
async function fixture(){
 const f=keepMarketFixture(),factory=new IDBFactory(),identity={origin:'http://localhost',api:'http://localhost/api',cluster:'devnet' as const,wallet:f.value.fill.buyerWallet};
 const store=new KeepMarketJournalStore(identity,factory);stores.push(store);let valid=true,enabled=true,exists=false,current=KeepEquipmentPurchaseSchema.parse({...f.value,preparation:null,status:'reserved'});
 const calls:string[]=[],key='fill:'+f.value.fill.id;let dropped:string|null=null,late=false;
 const ports:KeepMarketPorts={capture:(action)=>{const guard=()=>{if(!valid||action&&!enabled)throw Error('view changed');};guard();return guard;},key:()=>f.value.fill.id,lock:async(_key,run)=>run(),
  request:async(r,guard,retain)=>{calls.push(r.action);guard();if(r.kind==='policy')return policy;if(r.kind==='history')return {wallet:identity.wallet,items:[],nextCursor:null};
   const saved=(await store.read()).pending[0]!;expect(saved.actions).toContain(r.action);expect(saved.command.key).toBe(f.value.fill.id);
   if(r.action==='create'){expect(saved.command.request).toEqual(r.body);exists=true;}else if(!exists)throw new ApiError(404,'missing','KEEP_EQUIPMENT_MARKET_NOT_FOUND');
   if(r.action==='prepare')current=structuredClone(f.value);
   if(r.action==='signed'){const wire=saved.wire!;expect(wire.signedTransactionHex).toBe((r.body as {signedTransactionHex:string}).signedTransactionHex);current=KeepEquipmentPurchaseSchema.parse({...current,status:'signed',wire:{...wire,recordedAt:f.value.fill.createdAt}});}
   if(dropped===r.action){dropped=null;throw Error('response lost');}
   if(late)valid=false;await retain(current);guard();return current;
  },review:async(_value,guard)=>{guard();return {...f.value.preparation!.costs,assertFresh:guard};},
  sign:async(value,guard,beforeWallet)=>{guard();await beforeWallet();expect((await store.read()).pending[0]!.signingStarted).toBe(true);return signKeepEquipment(await prepareKeepEquipmentSigning(value,f.trust,identity.wallet),f.signer);}};
 const controller=new KeepMarketController(store,ports),request={listingId:f.value.fill.listingId,buyerBaseId:f.value.fill.buyerBaseId,quantity:'1'};
 const begin=()=>controller.begin('fill',request);const ready=async()=>{await begin();await controller.prepare();await controller.review();};
 return {...f,store,ports,controller,key,request,calls,begin,ready,drop:(action:string)=>{dropped=action;},late:()=>{late=true;},paused:()=>{enabled=false;},stale:()=>{valid=false;},setCurrent:(value:typeof current)=>{current=value;exists=true;},reopen:()=>{const s=new KeepMarketJournalStore(identity,factory);stores.push(s);return new KeepMarketController(s,ports);}};
}
it('saves the original before create, retains the exact signed wire before upload and reopens the same destination',async()=>{
 const f=await fixture();await f.ready();await f.controller.sign();expect(f.calls).not.toContain('signed');const signed=(await f.store.read()).pending[0]!.wire!;
 await f.controller.upload();const reopened=f.reopen();reopened.select(f.key);await reopened.recover();const saved=(await f.store.read()).pending[0]!;
 expect(KeepEquipmentPurchaseSchema.parse(saved.original).wire?.signature).toBe(signed.signature);expect(saved.command.request).toEqual({...f.request,idempotencyKey:f.value.fill.id});
 expect(KeepEquipmentPurchaseSchema.parse(saved.original).fill.buyerBaseId).toBe(f.value.fill.buyerBaseId);
});
it('recovers a dropped create without creating another reservation or changing its quantity',async()=>{
 const f=await fixture();f.drop('create');await expect(f.begin()).rejects.toThrow('lost');expect((await f.store.read()).pending[0]!.original).toBeNull();
 await f.controller.recover(true);expect(f.calls.filter(c=>c==='create')).toHaveLength(1);expect(KeepEquipmentPurchaseSchema.parse((await f.store.read()).pending[0]!.original).fill.quantity).toBe('1');
});
it('a saved but undispatched command retries only after explicit not-found, using exactly the original body',async()=>{
 const f=await fixture(),command={kind:'fill' as const,key:f.value.fill.id,request:{...f.request,idempotencyKey:f.value.fill.id}};await f.store.begin(command);f.controller.select(marketKey(command));
 await f.controller.recover(true);expect(f.calls).toEqual(['read','create']);expect((await f.store.read()).pending[0]!.command).toEqual(command);
});
it('does not retry new stock mutations while paused but can recover their known originals',async()=>{
 const f=await fixture();await f.begin();f.paused();await f.controller.recover();await expect(f.controller.prepare()).rejects.toThrow('view changed');
 expect(f.calls).toEqual(['create','read']);
});
it('a malformed or failed create is never silently retried as a different reservation',async()=>{
 const f=await fixture();const request=f.ports.request;f.ports.request=async(r,g,retain)=>{if(r.action==='create')throw new ApiError(503,'busy','PAUSED');return request(r,g,retain);};
 await expect(f.begin()).rejects.toThrow('busy');expect((await f.store.read()).pending[0]!.command.key).toBe(f.value.fill.id);expect((await f.store.read()).pending).toHaveLength(1);
});
it('retains a late original even when the selected view changed before the response',async()=>{
 const f=await fixture();f.late();await expect(f.begin()).rejects.toThrow('view changed');expect((await f.store.read()).pending[0]!.original).not.toBeNull();
});
it('a wallet rejection after approval started never invites a second signature after restart',async()=>{
 const f=await fixture();await f.ready();const wallet=vi.fn(async()=>{throw Error('wallet outcome unknown');});f.ports.sign=async(_v,_g,before)=>{await before();return wallet();};
 await expect(f.controller.sign()).rejects.toThrow('unknown');const reopened=f.reopen();reopened.select(f.key);await expect(reopened.review()).rejects.toThrow();await expect(reopened.sign()).rejects.toThrow();expect(wallet).toHaveBeenCalledOnce();
 expect((await f.store.read()).pending[0]!.signingStarted).toBe(true);
});
it('a stale wallet response is retained before UI rejection instead of losing its signed packet',async()=>{
 const f=await fixture();await f.ready();const original=f.ports.sign;f.ports.sign=async(...args)=>{const result=await original(...args);f.stale();return result;};
 await expect(f.controller.sign()).rejects.toThrow('view changed');expect((await f.store.read()).pending[0]!.wire).not.toBeNull();expect(f.calls).not.toContain('signed');
});
it('does not permit wallet or transport calls when the durable signing claim fails',async()=>{
 const f=await fixture();await f.ready();const wallet=vi.fn();vi.spyOn(f.store,'startSigning').mockRejectedValue(Error('storage unavailable'));f.ports.sign=async(_v,_g,before)=>{await before();return wallet() as Promise<KeepEquipmentWire>;};
 await expect(f.controller.sign()).rejects.toThrow('storage unavailable');expect(wallet).not.toHaveBeenCalled();expect(f.calls).not.toContain('signed');
});
it('a dropped signed upload recovers the same signature without another wallet call',async()=>{
 const f=await fixture();await f.ready();f.ports.sign=vi.fn(f.ports.sign);await f.controller.sign();f.drop('signed');await expect(f.controller.upload()).rejects.toThrow('lost');f.paused();await f.controller.recover();
 expect(f.ports.sign).toHaveBeenCalledOnce();const op=(await f.store.read()).pending[0]!;expect(KeepEquipmentPurchaseSchema.parse(op.original).wire?.signature).toBe(op.wire?.signature);
});
it('delivery checks the original outcome before current wallet review or retransmission',async()=>{
 const f=await fixture();await f.ready();await f.controller.sign();await f.controller.upload();f.ports.review=vi.fn(async()=>{throw Error('independent wallet current proof unavailable');});
 await expect(f.controller.deliver()).rejects.toThrow('proof unavailable');expect(f.calls.at(-1)).toBe('recover');expect(f.calls).not.toContain('deliver');
});
it('retains remote original history with no guessed command and cannot replay an absent original request',async()=>{
 const f=await fixture();f.setCurrent(f.value);await f.controller.open({kind:'fill',id:f.value.fill.id,baseId:f.value.fill.buyerBaseId,itemId:'route_compass',createdAt:f.value.fill.createdAt});
 expect((await f.store.read()).pending[0]!.command.request).toBeNull();await expect(f.controller.recover(true)).rejects.toThrow('no original request');
});
it('new mutation amounts are strictly checked before saving or sending any command',async()=>{
 const f=await fixture();for(const quantity of ['0','-1','1.5','1e3','9223372036854775808'])expect(()=>f.controller.begin('fill',{...f.request,quantity})).toThrow();
 expect((await f.store.read()).pending).toHaveLength(0);expect(f.calls).toHaveLength(0);
});
it('review consent is cleared on dismiss and the original cannot be archived while payment is uncertain',async()=>{
 const f=await fixture();await f.ready();f.controller.dismiss();await expect(f.controller.sign()).rejects.toThrow();await expect(f.controller.archive()).rejects.toThrow();expect((await f.store.read()).pending).toHaveLength(1);
});

it('opts into twelve goods and preserves category filters before every offers/history cursor without changing originals',async()=>{
 const f=await fixture(),requests:unknown[]=[];await f.ready();const original=await f.store.read(),selection=f.controller.getSnapshot().selected,review=f.controller.getSnapshot().reviewed;
 f.ports.request=async(r,g)=>{g();requests.push(r);if(r.kind==='policy')return policy;if(r.kind==='stock')return {wallet:f.value.fill.buyerWallet,baseId:r.baseId,serverNow:f.value.fill.createdAt,policy,catalogueVersion:4,items:KEEP_MARKET_ITEM_IDS_V4.map(itemId=>({itemId,available:'0',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'}))};return r.kind==='history'?{wallet:f.value.fill.buyerWallet,items:[],nextCursor:null}:{items:[],nextCursor:null};};
 await f.controller.offers();await f.controller.history();f.controller.category('resources');expect(f.controller.getSnapshot()).toMatchObject({category:'resources',offers:null,history:null,selected:selection,reviewed:review});
 const cursor={before:f.value.fill.createdAt,beforeId:f.value.fill.listingId};await f.controller.offers(cursor);await f.controller.history({...cursor,beforeKind:'listing'});await f.controller.stock(f.value.fill.buyerBaseId);await f.controller.load();
 expect(requests).toContainEqual({kind:'offers',action:'read',query:{catalogueVersion:'4',category:'items'}});
 expect(requests).toContainEqual({kind:'offers',action:'read',query:{...cursor,catalogueVersion:'4',category:'resources'}});
 expect(requests).toContainEqual({kind:'history',action:'read',query:{...cursor,beforeKind:'listing',catalogueVersion:'4',category:'resources'}});
 expect(requests).toContainEqual({kind:'stock',action:'read',baseId:f.value.fill.buyerBaseId,query:{catalogueVersion:'4'}});
 expect(requests.at(-1)).toEqual({kind:'history',action:'read',query:{catalogueVersion:'4',category:'resources'}});expect((await f.store.read()).pending).toEqual(original.pending);
});
it('rejects a downgraded stock response and wrong-category page without replacing its saved payment',async()=>{
 const f=await fixture();await f.ready();const before=(await f.store.read()).pending;f.controller.category('resources');
 let version:2|undefined;f.ports.request=async r=>r.kind==='stock'?{wallet:f.value.fill.buyerWallet,baseId:r.baseId,serverNow:f.value.fill.createdAt,policy,...version?{catalogueVersion:version}:{},items:(version?KEEP_MARKET_CRAFTING_CATALOGUE_IDS:KEEP_MARKET_EQUIPMENT_IDS).map(itemId=>({itemId,available:'0',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'}))}:
  {wallet:f.value.fill.buyerWallet,items:[{kind:'fill',id:f.value.fill.id,baseId:f.value.fill.buyerBaseId,itemId:'route_compass',createdAt:f.value.fill.createdAt}],nextCursor:null};
 await expect(f.controller.stock(f.value.fill.buyerBaseId)).rejects.toThrow();version=2;await expect(f.controller.stock(f.value.fill.buyerBaseId)).rejects.toThrow();await expect(f.controller.history()).rejects.toThrow();expect(f.controller.getSnapshot().stock).toBeNull();expect(f.controller.getSnapshot().history).toBeNull();expect((await f.store.read()).pending).toEqual(before);
});

import {webcrypto} from 'node:crypto';
import {KEEP_MARKET_ITEM_IDS} from '@shardkeep/shared/keepEquipmentMarketApi';
import {Keypair} from '@solana/web3.js';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {KeepMarketJournalStore,marketKey} from './journal';
import {prepareKeepEquipmentSigning,signKeepEquipment} from './signing';
import {keepMarketFixture} from './fixtures.testHelpers';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));afterEach(()=>vi.unstubAllGlobals());
function fixture(){const f=keepMarketFixture(),factory=new IDBFactory(),identity={origin:'http://localhost',api:'http://localhost/api',cluster:'devnet' as const,wallet:f.value.fill.buyerWallet},store=new KeepMarketJournalStore(identity,factory);
 const command={kind:'fill' as const,key:f.value.fill.id,request:{idempotencyKey:f.value.fill.id,listingId:f.value.fill.listingId,buyerBaseId:f.value.fill.buyerBaseId,quantity:f.value.fill.quantity}};
 return {...f,factory,identity,store,command,key:marketKey(command)};
}
it('retains immutable command and signing marker through restart without granting a replacement signature',async()=>{
 const f=fixture();try{await f.store.begin(f.command);await f.store.retain(f.key,f.value);await f.store.startSigning(f.key);await f.store.close();
  const restored=new KeepMarketJournalStore(f.identity,f.factory);try{const saved=(await restored.read()).pending[0]!;expect(saved.command).toEqual(f.command);expect(saved.signingStarted).toBe(true);expect(saved.wire).toBeNull();
   await expect(restored.change(f.key,{signingStarted:false})).rejects.toThrow();await expect(restored.begin({...f.command,request:{...f.command.request,buyerBaseId:crypto.randomUUID()}})).rejects.toThrow();
  }finally{await restored.close();}
 }finally{await f.store.close();}
});
it('requires durable pre-wallet marker and retains the exact signature before any transport is available',async()=>{
 const f=fixture();try{await f.store.begin(f.command);await f.store.retain(f.key,f.value);
  const prepared=await prepareKeepEquipmentSigning(f.value,f.trust,f.identity.wallet),wire=await signKeepEquipment(prepared,f.signer);
  await expect(f.store.retainSigned(f.key,wire)).rejects.toThrow();await f.store.startSigning(f.key);await f.store.retainSigned(f.key,wire);
  expect((await f.store.read()).pending[0]!.wire).toEqual(wire);await expect(f.store.change(f.key,{wire:null})).rejects.toThrow();
  await expect(f.store.retainSigned(f.key,{...wire,signature:'1'.repeat(64)})).rejects.toThrow();
  await expect(f.store.archive(f.key)).rejects.toThrow();
 }finally{await f.store.close();}
});
it('binds receiving base, actor, listing and original message despite newer selections or foreign history',async()=>{
 const f=fixture();try{await f.store.begin(f.command);await f.store.retain(f.key,f.value);
  for(const field of ['buyerBaseId','listingId'] as const){const changed=structuredClone(f.value);changed.fill[field]=crypto.randomUUID();await expect(f.store.retain(f.key,changed)).rejects.toThrow();}
  const foreign=structuredClone(f.value);foreign.fill.buyerWallet=foreign.preparation!.original.buyer=Keypair.generate().publicKey.toBase58();await expect(f.store.retain(f.key,foreign)).rejects.toThrow();
  const revised=structuredClone(f.value);revised.preparation!.recordedAt='2036-01-01T00:00:00.000Z';await expect(f.store.retain(f.key,revised)).rejects.toThrow();
  const other=new KeepMarketJournalStore({...f.identity,wallet:Keypair.generate().publicKey.toBase58()},f.factory);try{expect((await other.read()).pending).toEqual([]);}finally{await other.close();}
 }finally{await f.store.close();}
});
it('allows exactly one competing-tab write and never silently overwrites recovery markers',async()=>{
 const f=fixture(),other=new KeepMarketJournalStore(f.identity,f.factory);try{await f.store.begin(f.command);await f.store.retain(f.key,f.value);
  const outcomes=await Promise.allSettled([f.store.mark(f.key,'review'),other.mark(f.key,'recover')]);expect(outcomes.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(outcomes.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await f.store.read()).pending[0]!.actions).toHaveLength(1);
 }finally{await other.close();await f.store.close();}
});
it('unknown remote purchase adoption keeps its permanent identity and cannot acquire a different command later',async()=>{
 const f=fixture();try{const c={...f.command,request:null};await f.store.begin(c);await f.store.retain(f.key,f.value);expect((await f.store.read()).pending[0]!.command.request).toBeNull();
  await expect(f.store.begin(f.command)).rejects.toThrow();await expect(f.store.retain(f.key,{...f.value,fill:{...f.value.fill,id:crypto.randomUUID()}})).rejects.toThrow();
 }finally{await f.store.close();}
});
it('listing receipts can advance stock counts but cannot rewrite price, quantity or original seller',async()=>{
 const f=fixture(),s=new KeepMarketJournalStore({...f.identity,wallet:f.value.fill.sellerWallet},f.factory);
 try{const request={idempotencyKey:f.value.fill.listingId,baseId:f.value.fill.sellerBaseId,itemId:'route_compass' as const,quantity:'3',unitPriceBaseUnits:'1000001'},command={kind:'listing' as const,key:request.idempotencyKey,request},key=marketKey(command);
  const row={id:command.key,sellerWallet:f.value.fill.sellerWallet,sellerBaseId:request.baseId,itemId:request.itemId,quantity:'3',unitPriceBaseUnits:request.unitPriceBaseUnits,createdAt:f.value.fill.createdAt,availableQuantity:'3',reservedQuantity:'0',cancelledQuantity:'0'};
  await s.begin(command);await s.retain(key,row);await s.retain(key,{...row,availableQuantity:'1',reservedQuantity:'2'});
  await expect(s.retain(key,row)).rejects.toThrow();await expect(s.retain(key,{...row,unitPriceBaseUnits:'1'})).rejects.toThrow();
  await s.archive(key);expect((await s.read()).archive[0]!.observedComplete).toBe(true);
 }finally{await s.close();await f.store.close();}
});

it.each(KEEP_MARKET_ITEM_IDS)('retains %s with its exact original wire through restart and rejects replacement item identity',async itemId=>{
 const f=fixture();f.value.fill.itemId=itemId;try{await f.store.begin(f.command);await f.store.retain(f.key,f.value);await f.store.startSigning(f.key);
  const wire=await signKeepEquipment(await prepareKeepEquipmentSigning(f.value,f.trust,f.identity.wallet),f.signer);await f.store.retainSigned(f.key,wire);await f.store.close();
  const reopened=new KeepMarketJournalStore(f.identity,f.factory);try{const op=(await reopened.read()).pending[0]!;expect(op.original).toEqual(f.value);expect(op.wire).toEqual(wire);
   await expect(reopened.retain(f.key,{...f.value,fill:{...f.value.fill,itemId:itemId==='survey_lens'?'route_compass':'survey_lens'}})).rejects.toThrow();expect((await reopened.read()).pending[0]!.wire).toEqual(wire);
  }finally{await reopened.close();}
 }finally{await f.store.close();}
});
it('reopens mixed old-equipment and new-crafting listing archives in the unchanged namespace',async()=>{
 const f=fixture(),s=new KeepMarketJournalStore({...f.identity,wallet:f.value.fill.sellerWallet},f.factory);const receipts=[];
 try{for(const itemId of KEEP_MARKET_ITEM_IDS){const id=crypto.randomUUID(),request={idempotencyKey:id,baseId:f.value.fill.sellerBaseId,itemId,quantity:'2',unitPriceBaseUnits:'1000001'},command={kind:'listing' as const,key:id,request};
  const row={id,sellerWallet:f.value.fill.sellerWallet,sellerBaseId:request.baseId,itemId,quantity:'2',unitPriceBaseUnits:request.unitPriceBaseUnits,createdAt:f.value.fill.createdAt,availableQuantity:'2',reservedQuantity:'0',cancelledQuantity:'0'};
  await s.begin(command);await s.retain(marketKey(command),row);await s.archive(marketKey(command));receipts.push(row);}
  await s.close();const reopened=new KeepMarketJournalStore({...f.identity,wallet:f.value.fill.sellerWallet},f.factory);try{expect((await reopened.read()).archive.map(op=>op.original)).toEqual(receipts);expect((await reopened.read()).pending).toEqual([]);}finally{await reopened.close();}
 }finally{await s.close();await f.store.close();}
});

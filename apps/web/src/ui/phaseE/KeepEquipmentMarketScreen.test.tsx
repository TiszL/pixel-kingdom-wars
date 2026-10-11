/** @vitest-environment happy-dom */
import {webcrypto} from 'node:crypto';
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory} from 'fake-indexeddb';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {PHASE_E_KEEP_EQUIPMENT_MARKET as M,PHASE_E_KEEP_EQUIPMENT_MARKET_CLIENT as P,PHASE_E_POLICY,TOKEN} from '@shardkeep/shared';
import {KEEP_MARKET_ITEM_IDS_V4} from '@shardkeep/shared/keepEquipmentMarketApi';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {keepMarketFixture,keepMarketReleasedFixture} from '../../lib/keepEquipmentMarket/fixtures.testHelpers';
import {KeepMarketJournalStore} from '../../lib/keepEquipmentMarket/journal';
import {browserKeepMarketIdentity} from '../../lib/keepEquipmentMarket/browser';
import {requestKeepMarket} from '../../lib/keepEquipmentMarket/transport';
import {KeepEquipmentMarketScreen} from './KeepEquipmentMarketScreen';
const mocks=vi.hoisted(()=>({wallet:{publicKey:null as unknown,signVersionedTransaction:vi.fn(),signMessage:null,sendTransaction:null,isEmbedded:false},checks:vi.fn(async(_v:unknown,_r:unknown,_s:unknown,guard:()=>void)=>guard())}));
vi.mock('../../auth/useGameWallet',()=>({useGameWallet:()=>mocks.wallet}));const connection={};vi.mock('@solana/wallet-adapter-react',()=>({useConnection:()=>({connection})}));
vi.mock('../../lib/keepEquipmentMarket/current',()=>({createKeepEquipmentCurrentChecks:()=>mocks.checks}));vi.mock('../../lib/keepEquipmentMarket/transport',()=>({requestKeepMarket:vi.fn()}));
const policy={version:1,decimals:TOKEN.decimals,minFillBaseUnits:M.minFillBaseUnits.toString(),sellerBps:PHASE_E_POLICY.taxes.keepMarket.sellerBps,basisPoints:PHASE_E_POLICY.basisPoints,reviewMaxAgeMs:P.reviewMaxAgeMs};
let host:HTMLDivElement,root:Root,f:ReturnType<typeof keepMarketFixture>,value:ReturnType<typeof keepMarketFixture>['value'],available:string,listing:unknown,releaseReply:ReturnType<typeof keepMarketFixture>['value']|null;
const button=(text:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===text),until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();}),click=async(text:string)=>{expect(button(text)?.disabled).toBe(false);await act(async()=>button(text)!.click());};
const store=()=>new KeepMarketJournalStore(browserKeepMarketIdentity(f.value.fill.buyerWallet));async function saved(){const s=store();try{return await s.read();}finally{await s.close();}}
async function seed(){const s=store();try{await s.begin({kind:'fill',key:f.value.fill.id,request:{idempotencyKey:f.value.fill.id,listingId:f.value.fill.listingId,buyerBaseId:f.value.fill.buyerBaseId,quantity:'1'}});await s.retain('fill:'+f.value.fill.id,value);}finally{await s.close();}}
async function mount(enabled=true,trust=true,strict=false){const component=<KeepEquipmentMarketScreen actionsEnabled={enabled} trust={trust?f.trust:null} onClose={()=>{}}/>;await act(async()=>root.render(strict?<StrictMode>{component}</StrictMode>:component));await until(()=>expect(button('REFRESH')?.disabled).toBe(false));}
async function select(){await click('history');await until(()=>expect(host.querySelector<HTMLButtonElement>('[aria-label="KEEP market history"] .sk-equipment-history')?.disabled).toBe(false));await act(async()=>host.querySelector<HTMLButtonElement>('[aria-label="KEEP market history"] .sk-equipment-history')!.click());await until(()=>expect(button('Check original outcome')?.disabled).toBe(false));}
async function field(label:string,value:string){const node=host.querySelector<HTMLInputElement>('input[aria-label="'+label+'"]')!;expect(node).not.toBeNull();await act(async()=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(node,value);node.dispatchEvent(new Event('input',{bubbles:true}));});}
beforeEach(()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('crypto',webcrypto);vi.stubGlobal('indexedDB',new IDBFactory());Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_n:string,_o:unknown,run:(lock:object)=>Promise<unknown>)=>run({})}});vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>{});
 f=keepMarketFixture();value=structuredClone(f.value);available='5';listing=null;releaseReply=null;mocks.wallet.publicKey=f.buyer.publicKey;mocks.wallet.signVersionedTransaction.mockReset().mockImplementation(async tx=>{tx.sign([f.buyer]);return tx;});mocks.checks.mockReset().mockImplementation(async(_v,_r,_s,guard)=>guard());
 useApp.getState().setAuth(f.value.fill.buyerWallet,true);useApp.getState().setScreen('bases');useApp.getState().setSelectedBaseId(f.value.fill.buyerBaseId,false);
 vi.mocked(requestKeepMarket).mockReset().mockImplementation(async input=>{
  input.isCurrent();const r=input.request;let response:unknown;
  if(r.kind==='policy')response=policy;
  else if(r.kind==='history')response={wallet:f.value.fill.buyerWallet,items:[],nextCursor:null};
  else if(r.kind==='offers')response={items:[],nextCursor:null};
  else if(r.kind==='stock')response={wallet:f.value.fill.buyerWallet,baseId:r.baseId,serverNow:f.value.fill.createdAt,policy,catalogueVersion:4,items:KEEP_MARKET_ITEM_IDS_V4.map(itemId=>({itemId,available,reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'}))};
  else if(r.kind==='listing'){const body=r.body as {idempotencyKey:string;baseId:string;itemId:string;quantity:string;unitPriceBaseUnits:string};if(r.action==='create'){expect((await saved()).pending.at(-1)!.command.request).toEqual(body);listing={id:body.idempotencyKey,sellerWallet:f.value.fill.buyerWallet,sellerBaseId:body.baseId,itemId:body.itemId,quantity:body.quantity,unitPriceBaseUnits:body.unitPriceBaseUnits,createdAt:f.value.fill.createdAt,availableQuantity:body.quantity,reservedQuantity:'0',cancelledQuantity:'0'};}response=listing;await input.retain(response);}
  else if(r.kind==='cancellation'){const body=r.body as {idempotencyKey:string;listingId:string};response={id:body.idempotencyKey,listingId:body.listingId,actorWallet:f.value.fill.buyerWallet,quantity:'2',createdAt:f.value.fill.createdAt};await input.retain(response);}
  else if(r.action==='review'){const {blockhashSlot:_slot,recordedAt:_at,...current}=value.preparation!;response={purchase:value,current:{...current,currentReviewPassed:true,finalityVerified:false},reviewedAt:value.preparation!.recordedAt,expiresAt:'2035-01-01T00:00:30.000Z'};await input.retain(value);}
  else{if(r.action==='release'&&releaseReply)value=releaseReply;if(r.action==='signed'){const op=(await saved()).pending[0]!;expect(op.wire).not.toBeNull();value={...value,status:'signed',wire:{...op.wire!,recordedAt:f.value.fill.createdAt}};}await input.retain(value);response=r.action==='deliver'?{purchase:value,status:'submitted',reason:null,broadcastAuthorized:false,fenceReleaseAuthorized:false}:value;}
  input.isCurrent();return response;
 });host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('reviews a listing before holding real stock and exposes only unsold cancellation',async()=>{
 await mount(true,true,true);await click('sell');await until(()=>expect(button('REVIEW LISTING')?.disabled).toBe(false));await field('Listing quantity','2');await field('KEEP per item','1.000000001');await click('REVIEW LISTING');
 expect((await saved()).pending).toHaveLength(0);expect(host.textContent).toContain('2.000000002 KEEP');await click('CONFIRM LISTING');await until(()=>expect(host.textContent).toContain('Listing created'));expect((await saved()).pending[0]!.command.request).toMatchObject({quantity:'2',unitPriceBaseUnits:'1000000001'});
 expect(document.activeElement).toBe(host.querySelector('[aria-label="Market consent and receipt"]'));await click('REVIEW CANCELLATION');await click('RETURN UNSOLD ITEMS');await until(()=>expect(host.textContent).toContain('Returned 2 unsold items'));expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('keeps exact wallet approval separate from durable upload and relay, then offers recovery as the primary action',async()=>{
 await seed();await mount();await select();await click('REVIEW PAYMENT');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));expect(host.textContent).toContain('0.000005 SOL');expect(document.activeElement).toBe(host.querySelector('[aria-label="Market consent and receipt"]'));expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
 await click('APPROVE IN WALLET');await until(()=>expect(button('SAVE APPROVED PAYMENT')?.disabled).toBe(false));expect((await saved()).pending[0]!.wire).not.toBeNull();await click('SAVE APPROVED PAYMENT');await until(()=>expect(button('SEND SAVED PAYMENT')?.disabled).toBe(false));await click('SEND SAVED PAYMENT');await until(()=>expect(button('CHECK PAYMENT OUTCOME')?.disabled).toBe(false));
 expect(button('Retry this same signed payment')).toBeDefined();expect(mocks.wallet.signVersionedTransaction).toHaveBeenCalledOnce();await act(async()=>root.render(null));await mount(false);await select();expect(button('APPROVE IN WALLET')).toBeUndefined();expect(button('Check original outcome')?.disabled).toBe(false);expect(button('Retry this same signed payment')?.disabled).toBe(true);
});
it('retains a late wallet approval after closing and never offers another signature after remount',async()=>{
 await seed();let finish!:()=>void;mocks.wallet.signVersionedTransaction.mockImplementation(tx=>new Promise(resolve=>{finish=()=>{tx.sign([f.buyer]);resolve(tx);};}));await mount();await select();await click('REVIEW PAYMENT');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));await click('APPROVE IN WALLET');await until(()=>expect(mocks.wallet.signVersionedTransaction).toHaveBeenCalledOnce());
 await act(async()=>root.render(null));finish();await vi.waitFor(async()=>expect((await saved()).pending[0]!.wire).not.toBeNull());await mount();await select();expect(button('APPROVE IN WALLET')).toBeUndefined();expect(mocks.wallet.signVersionedTransaction).toHaveBeenCalledOnce();
});
it('keeps local recovery and keyboard close reachable during pause and provider failure',async()=>{
 await seed();vi.mocked(requestKeepMarket).mockRejectedValue(Error('provider unavailable'));const opener=document.createElement('button');document.body.append(opener);opener.focus();await mount(false,false);await select();expect(button('REVIEW PAYMENT')?.disabled).toBe(true);expect(button('Check original outcome')?.disabled).toBe(false);
 expect(host.querySelector('[aria-label="Close KEEP market"]')).not.toBeNull();await act(async()=>root.render(null));expect(document.activeElement).toBe(opener);opener.remove();expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('cannot confirm a draft against a different selected kingdom or show stock as available without a server view',async()=>{
 await mount();await click('sell');await until(()=>expect(button('REVIEW LISTING')?.disabled).toBe(false));await field('Listing quantity','2');await field('KEEP per item','1');await click('REVIEW LISTING');
 await act(async()=>useApp.getState().setSelectedBaseId(crypto.randomUUID(),false));expect(button('CONFIRM LISTING')?.disabled).toBe(true);expect((await saved()).pending).toHaveLength(0);
});
it('zero available stock disables listing without hiding travelling or incoming stores',async()=>{
 available='0';await mount();await click('sell');await until(()=>expect(host.textContent).toContain('0 travelling'));expect(button('REVIEW LISTING')?.disabled).toBe(true);expect(host.textContent).toContain('0 incoming');expect((await saved()).pending).toHaveLength(0);
});
it('a second independent review failure does not touch the wallet or falsely mark approval started',async()=>{
 await seed();await mount();await select();await click('REVIEW PAYMENT');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));mocks.checks.mockRejectedValueOnce(Error('network costs changed'));
 await click('APPROVE IN WALLET');await until(()=>expect(host.textContent).toContain('network costs changed'));expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();expect((await saved()).pending[0]!.signingStarted).toBe(false);
});

it('focuses an insufficient-stock error without creating or silently changing the requested listing',async()=>{
 await mount();await click('sell');await until(()=>expect(button('REVIEW LISTING')?.disabled).toBe(false));await field('Listing quantity','6');await field('KEEP per item','1');await click('REVIEW LISTING');
 expect(host.textContent).toContain('Only available goods in your stores can be listed.');expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));expect((await saved()).pending).toHaveLength(0);expect(host.querySelector<HTMLInputElement>('[aria-label="Listing quantity"]')!.value).toBe('6');
});

it('cancels before payment preparation while paused, then preserves a readable terminal receipt',async()=>{
 value={...value,preparation:null,status:'reserved'};releaseReply={...value,status:'released',release:{fillId:value.fill.id,reason:'never_prepared',signature:null,proof:null,releasedAt:value.fill.createdAt}};
 await seed();await mount(false,false);await select();expect(button('CANCEL RESERVATION')?.disabled).toBe(false);await click('CANCEL RESERVATION');await until(()=>expect(host.textContent).toContain('Reservation cancelled'));
 expect(host.textContent).toContain('No payment was prepared.');expect(button('PREPARE PAYMENT')).toBeUndefined();expect(button('CANCEL RESERVATION')).toBeUndefined();expect(button('Keep receipt in history')?.disabled).toBe(false);expect(document.activeElement).toBe(host.querySelector('[aria-label="Market consent and receipt"]'));
 await click('Keep receipt in history');await until(()=>expect((button('Keep receipt in history'))).toBeUndefined());await click('history');expect(host.textContent).toContain('Released');expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('shows a verified failed payment with no pay-again control while keeping its original signature',async()=>{
 const next=keepMarketReleasedFixture(0,true);f=next;value=next.signed;releaseReply=next.released;mocks.wallet.publicKey=f.buyer.publicKey;useApp.getState().setAuth(f.value.fill.buyerWallet,true);useApp.getState().setSelectedBaseId(f.value.fill.buyerBaseId,false);
 await seed();await mount(false,false);await select();expect(button('CHECK FAILURE & RELEASE')?.disabled).toBe(false);await click('CHECK FAILURE & RELEASE');await until(()=>expect(host.textContent).toContain('Payment failed · reservation released'));
 expect(host.textContent).toContain('No KEEP was paid or burned; the network fee remains charged.');expect(host.textContent).toContain(next.signed.wire!.signature);expect(button('SEND SAVED PAYMENT')).toBeUndefined();expect(button('APPROVE IN WALLET')).toBeUndefined();expect(button('Retry this same signed payment')).toBeUndefined();expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('does not offer cancellation for a prepared original whose wallet outcome could still arrive',async()=>{
 await seed();const s=store();await s.startSigning('fill:'+f.value.fill.id);await s.close();await mount(false,false);await select();expect(host.textContent).toContain('outcome is unknown');expect(button('CANCEL RESERVATION')).toBeUndefined();expect(button('CHECK FAILURE & RELEASE')).toBeUndefined();expect(button('Check original outcome')?.disabled).toBe(false);
});

it('lists a named refined material only from available stock and keeps the exact draft across category navigation',async()=>{
 await mount();await click('Resources');await until(()=>expect(button('Resources')?.getAttribute('aria-pressed')).toBe('true'));await click('sell');await until(()=>expect(button('REVIEW LISTING')?.disabled).toBe(false));
 const selectGoods=host.querySelector<HTMLSelectElement>('[aria-label="Goods to list"]')!;
 expect(selectGoods.options.length).toBe(9);expect([...selectGoods.options].map(o=>o.textContent)).not.toContain(expect.stringContaining('Compass'));
 await act(async()=>{selectGoods.value='heartwood_beams';selectGoods.dispatchEvent(new Event('change',{bubbles:true}));});
 const stock=host.querySelector('[aria-label="Selected goods stock"]')!;expect(stock.textContent).toContain('Heartwood Beams');expect(stock.textContent).toContain('5 available');expect(stock.textContent).toContain('0 held for sale');expect(stock.textContent).toContain('0 incoming');expect(stock.textContent).not.toContain('travelling');
 await field('Listing quantity','2');await field('KEEP per item','1');await click('REVIEW LISTING');const review=host.querySelector('[aria-label="Market consent and receipt"]')!;expect(review.textContent).toContain('2 × Heartwood Beams');expect((await saved()).pending).toHaveLength(0);
 await click('sell');await until(()=>expect(button('Items')?.disabled).toBe(false));await click('Items');await until(()=>expect(button('Items')?.getAttribute('aria-pressed')).toBe('true'));await click('Review');expect(review.textContent).toContain('2 × Heartwood Beams');
 await click('CONFIRM LISTING');await until(()=>expect(host.textContent).toContain('Listing created'));expect((await saved()).pending[0]!.command.request).toMatchObject({itemId:'heartwood_beams',quantity:'2',unitPriceBaseUnits:'1000000000',baseId:f.value.fill.buyerBaseId});expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it.each([{itemId:'heartwood_beams',name:'Heartwood Beams'},{itemId:'crystal_fragment',name:'Crystal Fragments'}])('filters $itemId offers before pagination and reviews a partial purchase without starting payment',async({itemId,name})=>{
 const previous=vi.mocked(requestKeepMarket).getMockImplementation()!,cursor={before:f.value.fill.createdAt,beforeId:f.value.fill.listingId};
 const offer={id:f.value.fill.listingId,sellerWallet:f.value.fill.sellerWallet,sellerBaseId:f.value.fill.sellerBaseId,itemId,quantity:'3',unitPriceBaseUnits:f.value.fill.unitPriceBaseUnits,createdAt:f.value.fill.createdAt,availableQuantity:'3',reservedQuantity:'0',cancelledQuantity:'0'};
 vi.mocked(requestKeepMarket).mockImplementation(async input=>input.request.kind==='offers'?(input.request.query as {category?:string}).category==='resources'?{items:[offer],nextCursor:cursor}:{items:[],nextCursor:null}:previous(input));
 await mount();await click('Resources');await until(()=>expect(button('REVIEW PURCHASE')?.disabled).toBe(false));expect(host.textContent).toContain(name);expect(host.textContent).not.toContain('Return sooner with lighter cargo.');
 if(itemId==='crystal_fragment'){expect(host.textContent).toContain('PROTECTED RESOURCE');expect(host.textContent).not.toContain('Workshop recipes');}
 await click('MORE OFFERS');await until(()=>expect(button('REVIEW PURCHASE')?.disabled).toBe(false));expect(vi.mocked(requestKeepMarket).mock.calls.map(([i])=>i.request)).toContainEqual({kind:'offers',action:'read',query:{...cursor,catalogueVersion:'4',category:'resources'}});
 await click('REVIEW PURCHASE');expect(host.querySelector('[aria-label="Market consent and receipt"]')?.textContent).toContain('1 × '+name);expect((await saved()).pending).toHaveLength(0);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('keeps an old saved payment reachable across categories and rejects missing expanded stock instead of inventing zero',async()=>{
 await seed();const previous=vi.mocked(requestKeepMarket).getMockImplementation()!;
 vi.mocked(requestKeepMarket).mockImplementation(async input=>input.request.kind==='stock'?{wallet:f.value.fill.buyerWallet,baseId:input.request.baseId,serverNow:f.value.fill.createdAt,policy,items:['route_compass','survey_lens'].map(itemId=>({itemId,available:'5',reserved:'0',pendingOutput:'0',marketOutgoing:'0',marketIncoming:'0'}))}:previous(input));
 await mount();await click('Resources');await until(()=>expect(button('Resources')?.getAttribute('aria-pressed')).toBe('true'));await click('sell');await until(()=>expect(host.querySelector('[role="alert"]')).not.toBeNull());
 expect(button('REVIEW LISTING')?.disabled).toBe(true);expect(host.querySelector('[aria-label="Selected goods stock"]')).toBeNull();await select();expect(host.querySelector('[aria-label="Market consent and receipt"]')?.textContent).toContain('Route Compass');expect((await saved()).pending[0]!.original).toEqual(value);expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('lists only delivered available fragments with protected stock and preserves exact quantity, price and source consent',async()=>{
 const previous=vi.mocked(requestKeepMarket).getMockImplementation()!;vi.mocked(requestKeepMarket).mockImplementation(async input=>{const result=await previous(input);if(input.request.kind==='stock'){const stock=result as {items:Array<{itemId:string;marketOutgoing:string;marketIncoming:string}>};Object.assign(stock.items.find(i=>i.itemId==='crystal_fragment')!,{marketOutgoing:'4',marketIncoming:'2'});}return result;});
 await mount();await click('Resources');await until(()=>expect(button('Resources')?.getAttribute('aria-pressed')).toBe('true'));await click('sell');await until(()=>expect(button('REVIEW LISTING')?.disabled).toBe(false));
 const goods=host.querySelector<HTMLSelectElement>('[aria-label="Goods to list"]')!;await act(async()=>{goods.value='crystal_fragment';goods.dispatchEvent(new Event('change',{bubbles:true}));});
 const stock=host.querySelector('[aria-label="Selected goods stock"]')!;expect(stock.textContent).toContain('Crystal Fragments');expect(stock.textContent).toContain('5 available');expect(stock.textContent).toContain('4 held for sale');expect(stock.textContent).toContain('2 incoming');expect(stock.textContent).toContain('Protected from raids.');expect(stock.textContent).toContain('unclaimed personal shares stay separate');expect(stock.textContent).not.toMatch(/crafting|travelling|Workshop/);
 await field('Listing quantity','6');await field('KEEP per item','1.000000001');await click('REVIEW LISTING');expect(host.textContent).toContain('Only available goods in your stores can be listed.');expect((await saved()).pending).toHaveLength(0);
 await field('Listing quantity','2');await click('REVIEW LISTING');const review=host.querySelector('[aria-label="Market consent and receipt"]')!;expect(review.textContent).toContain('2 × Crystal Fragments');expect(review.textContent).toContain('2.000000002 KEEP');expect(review.textContent).toContain('From Selected kingdom');expect((await saved()).pending).toHaveLength(0);
 await click('CONFIRM LISTING');await until(()=>expect(host.textContent).toContain('Listing created'));expect((await saved()).pending[0]!.command.request).toMatchObject({itemId:'crystal_fragment',quantity:'2',unitPriceBaseUnits:'1000000001',baseId:f.value.fill.buyerBaseId});expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});
it('retains a fragment original through cold remount and paused providerless recovery without requesting another payment',async()=>{
 value.fill.itemId='crystal_fragment';await seed();vi.mocked(requestKeepMarket).mockRejectedValue(Error('provider unavailable'));await mount(false,false);await select();expect(host.querySelector('[aria-label="Market consent and receipt"]')?.textContent).toContain('Crystal Fragments');expect(button('REVIEW PAYMENT')?.disabled).toBe(true);expect(button('Check original outcome')?.disabled).toBe(false);
 await click('Check original outcome');await until(()=>expect(host.textContent).toContain('provider unavailable'));await act(async()=>root.render(null));await mount(false,false);await select();expect(host.querySelector('[aria-label="Market consent and receipt"]')?.textContent).toContain('Crystal Fragments');expect((await saved()).pending[0]!.original).toEqual(value);expect(button('APPROVE IN WALLET')).toBeUndefined();expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});

it.each([{id:'climate_kit',name:'Climate Kit'},{id:'expedition_kit',name:'Expedition Kit'}])('lists $name from the new item catalogue with explicit source and quantity consent',async({id,name})=>{
 await mount();await click('sell');await until(()=>expect(button('REVIEW LISTING')?.disabled).toBe(false));
 const goods=host.querySelector<HTMLSelectElement>('[aria-label="Goods to list"]')!;
 expect([...goods.options].map(o=>o.value)).toEqual(['route_compass','survey_lens','navigation_kit','climate_kit','expedition_kit']);
 await act(async()=>{goods.value=id;goods.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(host.querySelector('[aria-label="Selected goods stock"]')?.textContent).toContain(name);
 await field('Listing quantity','2');await field('KEEP per item','1');await click('REVIEW LISTING');
 expect(host.querySelector('[aria-label="Market consent and receipt"]')?.textContent).toContain('2 × '+name);expect((await saved()).pending).toHaveLength(0);
 await click('CONFIRM LISTING');await until(()=>expect(host.textContent).toContain('Listing created'));
 expect((await saved()).pending[0]!.command.request).toMatchObject({itemId:id,quantity:'2',baseId:f.value.fill.buyerBaseId});expect(mocks.wallet.signVersionedTransaction).not.toHaveBeenCalled();
});

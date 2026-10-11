// @vitest-environment happy-dom
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory} from 'fake-indexeddb';
import {Transaction,PublicKey} from '@solana/web3.js';
import {PHASE_E_POLICY,fmtDur} from '@shardkeep/shared';
import {REALM_SALE_REALMS} from '@shardkeep/shared/realmSaleOfferApi';
import {buildPhaseECatalogue} from '@shardkeep/shared/phaseE';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {api} from '../../lib/api';
import {RealmSaleJournalStore,type RealmSaleOperation} from '../../lib/realmSales/journal';
import {realmSaleIdentity} from '../../lib/realmSales/browser';
import {realmSaleSettlementFixture} from '../../lib/realmSales/settlement.test-support';
import {failedRealmSaleOriginal,prepareRealmSaleOriginal,savedRealmSaleOriginal,reviewRealmSaleOriginal,submitRealmSaleOriginal} from '../../lib/realmSales/transport';
import {RealmSalesScreen} from './RealmSalesScreen';
import {realmSaleBrowserFailureFixture} from '../../lib/realmSales/failure.test-support';
import {RealmSalesEntry} from './RealmSalesEntry';
const mocks=vi.hoisted(()=>({wallet:{publicKey:null as unknown,signTransaction:vi.fn()}}));
vi.mock('../../auth/useGameWallet',()=>({useGameWallet:()=>mocks.wallet}));
vi.mock('../../lib/realmSales/transport',()=>({failedRealmSaleOriginal:vi.fn(),prepareRealmSaleOriginal:vi.fn(),savedRealmSaleOriginal:vi.fn(),reviewRealmSaleOriginal:vi.fn(),submitRealmSaleOriginal:vi.fn()}));
let f:Awaited<ReturnType<typeof realmSaleSettlementFixture>>,root:Root,host:HTMLDivElement,settled:boolean;
const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent?.trim()===label);
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
const click=async(label:string)=>{expect(button(label)?.disabled).toBe(false);await act(async()=>button(label)!.click());};
const trust=()=>({genesisHash:f.preparation.source.genesisHash,programId:f.preparation.source.programId,developer:f.preparation.terms.developer,reviewedProgramDataSha256:f.preparation.source.programDataSha256,reviewedDeploymentSlot:f.preparation.source.reviewedDeploymentSlot,revision:f.preparation.source.revision});
const store=()=>new RealmSaleJournalStore(realmSaleIdentity(f.preparation.wallet));
async function read(){const s=store();try{return await s.read();}finally{await s.close();}}
function observation(path:string){const p=f.preparation,q=p.quote,t=p.terms,P=PHASE_E_POLICY.seekerIsland,url=new URL(path,'https://fixture.invalid'),realm=Number(url.searchParams.get('realm')),spot=Number(url.searchParams.get('spot'));
 const source={revision:p.source.revision,genesisHash:p.source.genesisHash,programId:p.source.programId,reviewedDeploymentSlot:p.source.reviewedDeploymentSlot,programDataSha256:p.source.programDataSha256};
 if(url.pathname.endsWith('/coverage'))return {version:1,wallet:p.wallet,realm,authorization:'none',status:'observed',coverage:{address:f.settlement.receipt.source.accounts[3]!.address,accountState:'absent',slot:p.source.admissionSlot,unixTimestamp:q.unixTimestamp,expiresAt:null,active:false,source}};
 return {version:1,wallet:p.wallet,spot,realm,authorization:'none',status:'available',reason:null,offer:{source,slot:p.source.admissionSlot,unixTimestamp:q.unixTimestamp,round:t.round,day:t.day,seller:t.seller,developer:t.developer,priorExpiry:t.priorExpiry,validUntil:t.validUntil,quotaRemaining:q.quotaRemaining,priceLamports:String(P.permitPriceLamports),sellerLamports:f.settlement.purchase.sellerLamports,developerLamports:f.settlement.purchase.developerLamports,durationSec:P.permitDurationSec,feeLamports:q.feeLamports,rentLamports:q.rentLamports,paymentDebitLamports:q.paymentDebitLamports,requiredLamports:q.requiredLamports,payerLamports:q.payerLamports}};
}
async function seedSettled(){const s=store(),p=f.preparation;let row=await s.compareAndSet(0,j=>({...j,operation:{request:{idempotencyKey:p.idempotencyKey,spot:p.spot,realm:p.realm},prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 const patches:Partial<RealmSaleOperation>[]=[{prepareAttempted:true},{preparation:p},{signingStarted:true},{signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}},{settlementObserved:true},{settlement:{wire:f.wire,value:f.settlement}}];
 for(const patch of patches)row=await s.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));await s.close();}
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,_options:unknown,run:(lock:object)=>Promise<unknown>)=>run({})}});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 f=await realmSaleSettlementFixture();settled=false;const p=f.preparation;vi.spyOn(crypto,'randomUUID').mockReturnValue(p.idempotencyKey as `${string}-${string}-${string}-${string}-${string}`);
 mocks.wallet.publicKey=f.sale.buyer.publicKey;mocks.wallet.signTransaction.mockReset().mockImplementation(async(tx:Transaction)=>{tx.partialSign(f.sale.buyer);return tx;});
 useApp.getState().setAuth(p.wallet,true);useApp.getState().setScreen('bases');
 vi.spyOn(api,'getPrivate').mockImplementation(async path=>(path==='/game/phase-e/catalogue'?buildPhaseECatalogue():observation(path)) as never);
 vi.mocked(failedRealmSaleOriginal).mockReset().mockImplementation(async i=>{const raw={wallet:p.wallet,idempotencyKey:i.idempotencyKey,failure:null};await i.retain(raw);i.isCurrent();return raw;});
 const envelope=()=>({wallet:p.wallet,idempotencyKey:p.idempotencyKey,preparation:p});
 vi.mocked(prepareRealmSaleOriginal).mockReset().mockImplementation(async i=>{i.isCurrent();const value=envelope();await i.retain(value);return value;});
 vi.mocked(savedRealmSaleOriginal).mockReset().mockImplementation(async i=>{const value={...envelope(),wire:settled?f.wire:null,settlement:settled?f.settlement:null};await i.retain(value);i.isCurrent();return value;});
 vi.mocked(reviewRealmSaleOriginal).mockReset().mockResolvedValue({version:1,saleId:p.saleId,wallet:p.wallet,idempotencyKey:p.idempotencyKey,messageSha256:p.quote.messageSha256,sourceRevision:p.source.revision,snapshotHash:p.source.snapshotHash,quoteSlot:p.source.admissionSlot,unixTimestamp:p.quote.unixTimestamp,validUntil:p.terms.validUntil,feeSlot:p.source.feeSlot,bracketSlot:p.source.admissionSlot,blockHeight:p.quote.lastValidBlockHeight,feeLamports:p.quote.feeLamports,rentLamports:p.quote.rentLamports,paymentDebitLamports:p.quote.paymentDebitLamports,requiredLamports:p.quote.requiredLamports,payerLamports:p.quote.payerLamports,quotaRemaining:p.quote.quotaRemaining,rents:p.quote.rents.map(r=>({address:r.address,lamports:r.maxIncreaseLamports})),admissionEligible:true,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false});
 vi.mocked(submitRealmSaleOriginal).mockReset().mockImplementation(async i=>{const value={wallet:p.wallet,idempotencyKey:p.idempotencyKey,wire:f.wire,settlement:null,delivery:'submitted'};await i.retain(value);return value;});
 host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('StrictMode only reads; preparation, original SOL review, wallet approval, submit, receipt and archive are explicit',async()=>{
 await act(async()=>root.render(<StrictMode><RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/></StrictMode>));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();expect(vi.mocked(api.getPrivate).mock.calls.every(([path])=>path.includes('spot=0&realm=0')||path.endsWith('realm=0'))).toBe(true);
 await click('PREPARE PURCHASE');await until(()=>expect(button('REVIEW ORIGINAL PURCHASE')?.disabled).toBe(false));expect(button('APPROVE IN WALLET')).toBeUndefined();
 await click('REVIEW ORIGINAL PURCHASE');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));const costs=host.querySelector('[aria-label="Approve original purchase"]')!;expect(costs.querySelector('.sk-economy-hero strong')?.textContent).toBe('0.016005 SOL');for(const [label,value]of [['Purchase price','0.01 SOL'],['Network fee limit','0.000005 SOL'],['Account rent limit','0.006 SOL']])expect([...costs.querySelectorAll('dt')].find(n=>n.textContent===label)?.nextElementSibling?.textContent).toBe(value);
 await click('APPROVE IN WALLET');await until(()=>expect(button('SUBMIT SAVED PURCHASE')?.disabled).toBe(false));expect(mocks.wallet.signTransaction).toHaveBeenCalledOnce();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
 await click('SUBMIT SAVED PURCHASE');await until(()=>expect(button('CHECK ORIGINAL PURCHASE')?.disabled).toBe(false));expect(submitRealmSaleOriginal).toHaveBeenCalledOnce();expect(button('SUBMIT SAVED PURCHASE')).toBeUndefined();
 settled=true;await click('CHECK ORIGINAL PURCHASE');await until(()=>expect(host.textContent).toContain('PURCHASE RECEIPT VERIFIED'));expect(host.textContent).toContain('Historical purchase receipt');expect(host.textContent).toContain('Current expedition access is checked separately');
 await until(()=>expect(button('ARCHIVE VERIFIED PURCHASE')?.disabled).toBe(false));await click('ARCHIVE VERIFIED PURCHASE');await until(()=>expect(button('OPEN PURCHASE HISTORY')?.disabled).toBe(false));expect((await read()).operation).toBeNull();await click('OPEN PURCHASE HISTORY');await until(()=>expect(host.textContent).toContain(f.wire.signature));
 expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.filter(([i])=>i.method==='POST')).toHaveLength(1);
});
it('paused providerless local recovery remains reachable, archives offline and reads one history record explicitly',async()=>{
 await seedSettled();mocks.wallet.publicKey=null;vi.mocked(api.getPrivate).mockRejectedValue(Error('offline'));const archived=vi.spyOn(RealmSaleJournalStore.prototype,'archived');
 await act(async()=>root.render(<RealmSalesEntry actionsEnabled={false}/>));await until(()=>expect(button('REALM ACCESS & HISTORY')).toBeDefined());await click('REALM ACCESS & HISTORY');await until(()=>expect(button('ARCHIVE VERIFIED PURCHASE')?.disabled).toBe(false));
 expect(host.textContent).toContain('Saved purchases can still be checked');await click('ARCHIVE VERIFIED PURCHASE');await until(()=>expect(button('OPEN PURCHASE HISTORY')?.disabled).toBe(false));const before=archived.mock.calls.length;
 await click('OPEN PURCHASE HISTORY');await until(()=>expect(host.textContent).toContain(f.wire.signature));expect(archived.mock.calls.length).toBe(before+1);expect(button('OLDER PURCHASE')).toBeUndefined();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it('catalogue discovery cannot supply signing trust, and unavailable coverage is never displayed as no permit',async()=>{
 vi.mocked(api.getPrivate).mockImplementation(async path=>(path==='/game/phase-e/catalogue'?buildPhaseECatalogue():path.endsWith('/coverage?realm=0')?{version:1,wallet:f.preparation.wallet,realm:0,authorization:'none',status:'unavailable',coverage:null}:observation(path)) as never);
 await act(async()=>root.render(<RealmSalesEntry actionsEnabled/>));await until(()=>expect(button('REALM ACCESS')).toBeDefined());await click('REALM ACCESS');await until(()=>expect(host.textContent).toContain('Current coverage is unavailable'));
 expect(button('PREPARE PURCHASE')?.disabled).toBe(true);expect(host.textContent).not.toContain('No current paid coverage');expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();
});
it('archives a declined original only after both saved reads, preserves refusal history, and needs a new explicit key',async()=>{
 const actual=await vi.importActual<typeof import('../../lib/realmSales/transport')>('../../lib/realmSales/transport');
 vi.mocked(prepareRealmSaleOriginal).mockImplementation(actual.prepareRealmSaleOriginal);vi.mocked(savedRealmSaleOriginal).mockImplementation(actual.savedRealmSaleOriginal);
 const nextKey='11111111-1111-4111-8111-111111111111',requests:{method:string;path:string;key:string}[]=[];
 vi.mocked(crypto.randomUUID).mockReturnValueOnce(f.preparation.idempotencyKey as ReturnType<typeof crypto.randomUUID>).mockReturnValue(nextKey);
 vi.stubGlobal('fetch',async(input:string|URL,init?:RequestInit)=>{
  expect(init?.credentials).toBe('include');expect(init?.cache).toBe('no-store');const path=new URL(String(input)).pathname,method=init?.method??'GET';
  const key=method==='POST'?JSON.parse(String(init?.body)).idempotencyKey:path.split('/').at(-1)!;requests.push({method,path,key});
  const value=method==='POST'?{error:{code:'INSUFFICIENT_SOL',message:'Insufficient SOL for this purchase.'}}:
   {wallet:f.preparation.wallet,idempotencyKey:key,preparation:null,...(path.includes('/prepare/')?{}:{wire:null,settlement:null})};
  return new Response(JSON.stringify(value),{status:method==='POST'?422:200,headers:{'content-type':'application/json'}});
 });
 await act(async()=>root.render(<StrictMode><RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/></StrictMode>));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 expect(requests).toEqual([]);await click('PREPARE PURCHASE');await until(()=>expect(button('CHECK & ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
 expect(host.textContent).toContain('PREPARATION DECLINED');expect(requests).toHaveLength(1);expect((await read()).operation?.prepareRefusal).toEqual({status:422,code:'INSUFFICIENT_SOL'});
 expect(button('PREPARE PURCHASE')).toBeUndefined();expect(button('REVIEW ORIGINAL PURCHASE')).toBeUndefined();expect(button('APPROVE IN WALLET')).toBeUndefined();
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled={false} onClose={()=>undefined}/>));await until(()=>expect(button('CHECK & ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
 expect((await read()).operation?.prepareRefusal).toEqual({status:422,code:'INSUFFICIENT_SOL'});const beforeArchive=requests.length;
 await click('CHECK & ARCHIVE DECLINED REQUEST');await until(()=>expect(button('OPEN PURCHASE HISTORY')?.disabled).toBe(false));
 expect(requests.slice(beforeArchive)).toEqual([{method:'GET',path:`/seeker/realm-sales/prepare/by-key/${f.preparation.idempotencyKey}`,key:f.preparation.idempotencyKey},
  {method:'GET',path:`/seeker/realm-sales/by-key/${f.preparation.idempotencyKey}`,key:f.preparation.idempotencyKey}]);
 expect((await read()).operation).toBeNull();await click('OPEN PURCHASE HISTORY');await until(()=>expect(host.textContent).toContain('DECLINED REQUEST ARCHIVED'));
 expect(host.textContent).not.toContain('PURCHASE RECEIPT VERIFIED');expect(host.textContent).toContain('No paid receipt was verified.');
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 await click('PREPARE PURCHASE');await until(()=>expect(button('CHECK & ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
 expect(requests.filter(r=>r.method==='POST').map(r=>r.key)).toEqual([f.preparation.idempotencyKey,nextKey]);expect((await read()).operation?.request.idempotencyKey).toBe(nextKey);
 expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it('keeps an unknown preparation error held even after both saved records are absent',async()=>{
 vi.mocked(prepareRealmSaleOriginal).mockImplementation(async input=>{if(input.method==='POST')throw Error('Unknown original response');
  const value={wallet:f.preparation.wallet,idempotencyKey:input.request.idempotencyKey,preparation:null};await input.retain(value);return value;});
 vi.mocked(savedRealmSaleOriginal).mockImplementation(async input=>{const value={wallet:f.preparation.wallet,idempotencyKey:input.idempotencyKey,preparation:null,wire:null,settlement:null};await input.retain(value);return value;});
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));await click('PREPARE PURCHASE');
 await until(()=>expect(button('CHECK ORIGINAL PURCHASE')?.disabled).toBe(false));await click('CHECK ORIGINAL PURCHASE');await until(()=>expect(button('CHECK ORIGINAL PURCHASE')?.disabled).toBe(false));
 expect(button('CHECK & ARCHIVE DECLINED REQUEST')).toBeUndefined();expect(button('PREPARE PURCHASE')).toBeUndefined();expect((await read()).operation?.prepareAttempted).toBe(true);
 expect((await read()).lastArchivedKey).toBeUndefined();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it('late offers for an old selection or account never replace the visible selection or enable purchase',async()=>{
 let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});vi.mocked(api.getPrivate).mockImplementation(async path=>{const original=observation(path);if(path.includes('/offer?spot=0'))await wait;return original as never;});
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(vi.mocked(api.getPrivate).mock.calls.length).toBeGreaterThan(0));
 await act(async()=>{const select=host.querySelector('[aria-label="Selling spot"]') as HTMLSelectElement;select.value='1';select.dispatchEvent(new Event('change',{bubbles:true}));});await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 await act(async()=>release());expect(host.textContent).toContain('Spot 2');expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();
 await act(async()=>useApp.getState().setAuth(new PublicKey(Buffer.alloc(32,9)).toBase58(),true));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(true));expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});
it('storage failure exposes recovery without automatic mutation or invented coverage',async()=>{
 vi.stubGlobal('indexedDB',undefined);vi.mocked(api.getPrivate).mockRejectedValue(Error('offline'));await act(async()=>root.render(<RealmSalesEntry actionsEnabled={false}/>));await until(()=>expect(button('REALM ACCESS & HISTORY')).toBeDefined());await click('REALM ACCESS & HISTORY');await until(()=>expect(host.textContent).toContain('Durable browser storage is unavailable'));
 expect(button('PREPARE PURCHASE')?.disabled).toBe(true);expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();
});

it('paused failed purchase uses game panels, records the charged fee and requires an explicit fresh check before saving history',async()=>{
 const failed=await realmSaleBrowserFailureFixture();f=failed;useApp.getState().setAuth(f.preparation.wallet,true);const identity=realmSaleIdentity(f.preparation.wallet),s=new RealmSaleJournalStore(identity,globalThis.indexedDB,'pkw-realm-sale-v1',failed.trust),p=f.preparation;
 let row=await s.compareAndSet(0,j=>({...j,operation:{request:{idempotencyKey:p.idempotencyKey,spot:p.spot,realm:p.realm},prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 for(const patch of [{prepareAttempted:true},{preparation:p},{signingStarted:true},{signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}},{submitAttempted:true}])row=await s.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));
 vi.mocked(prepareRealmSaleOriginal).mockImplementation(async i=>{const raw={wallet:p.wallet,idempotencyKey:p.idempotencyKey,preparation:p};await i.retain(raw);return raw;});
 vi.mocked(savedRealmSaleOriginal).mockImplementation(async i=>{const raw={wallet:p.wallet,idempotencyKey:p.idempotencyKey,preparation:p,wire:f.wire,settlement:null};await i.retain(raw);return raw;});
 vi.mocked(failedRealmSaleOriginal).mockImplementation(async i=>{const raw={wallet:p.wallet,idempotencyKey:p.idempotencyKey,failure:failed.failure};await i.retain(raw);i.isCurrent();return raw;});
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled={false} failureTrust={failed.trust} onClose={()=>undefined}/>));
 await until(()=>expect(button('CHECK & SAVE FAILED RECEIPT')?.disabled).toBe(false));expect(host.querySelector('[role="dialog"]')).not.toBeNull();expect(host.querySelector('.sk-equipment-header')).not.toBeNull();expect(host.textContent).toContain('PURCHASE FAILED');expect(host.textContent).toContain('No permit was purchased');expect(host.textContent).toContain('Network fee charged:');expect(button('SUBMIT SAVED PURCHASE')).toBeUndefined();
 const before=vi.mocked(failedRealmSaleOriginal).mock.calls.length;await click('CHECK & SAVE FAILED RECEIPT');await until(()=>expect(button('OPEN PURCHASE HISTORY')).toBeDefined());expect(vi.mocked(failedRealmSaleOriginal).mock.calls.length).toBeGreaterThan(before);await click('OPEN PURCHASE HISTORY');await until(()=>expect(host.textContent).toContain('PURCHASE FAILED'));expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();await s.close();
});

it('named current offers never replace the saved permit, recipients or costs at explicit approval',async()=>{
 const focus=vi.spyOn(HTMLElement.prototype,'focus');
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 const selected=host.querySelector('[aria-label="Selected realm offer"]')!;
 expect(selected.textContent).toContain(REALM_SALE_REALMS[0]!.name);expect(selected.textContent).toContain(`${fmtDur(PHASE_E_POLICY.seekerIsland.permitDurationSec)} realm permit`);
 expect(selected.querySelector('.sk-economy-hero strong')?.textContent).toBe('0.01 SOL');
 await click('PREPARE PURCHASE');await until(()=>expect(button('REVIEW ORIGINAL PURCHASE')?.disabled).toBe(false));const original=(await read()).operation!;
 expect([...host.querySelectorAll('details')].find(d=>d.querySelector('summary')?.textContent==='Original purchase limits & recipients')?.open).toBe(false);
 await act(async()=>{for(const [label,value]of [['Selling spot','1'],['Destination realm','1']]){const select=host.querySelector(`[aria-label="${label}"]`) as HTMLSelectElement;select.value=value!;select.dispatchEvent(new Event('change',{bubbles:true}));}});
 await until(()=>expect(host.querySelector('[aria-label="Selected realm offer"] .sk-economy-hero')?.textContent).toContain(REALM_SALE_REALMS[1]!.name));
 await click('REVIEW ORIGINAL PURCHASE');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));
 const review=host.querySelector('[aria-label="Approve original purchase"]')!;
 expect(document.activeElement).toBe(review);expect(focus).toHaveBeenCalledWith({preventScroll:true});expect(review.textContent).toContain(`Spot 1 · ${REALM_SALE_REALMS[0]!.name}`);expect(review.textContent).not.toContain(REALM_SALE_REALMS[1]!.name);
 expect(review.querySelector('.sk-economy-hero strong')?.textContent).toBe('0.016005 SOL');const recipients=review.querySelector('details')!;
 expect(recipients.open).toBe(false);expect(recipients.textContent).toContain(f.preparation.terms.seller);expect(recipients.textContent).toContain(f.preparation.terms.developer);
 const expiry=[...review.querySelectorAll('p')].find(p=>p.textContent?.startsWith('Original consent expires:'))!;
 expect(expiry.textContent).not.toMatch(/\d{4}-\d\d-\d\dT/);expect(expiry.textContent).toContain('1970');
 expect((await read()).operation?.preparation).toEqual(original.preparation);expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.filter(([i])=>i.method==='POST')).toHaveLength(1);
 expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it.each([
 ['PAUSED','New realm purchases are paused.'],['UNSOLD','This spot has no operating seller.'],['REALM','This spot cannot sell access to the selected realm.'],
 ['NO_QUOTA','This spot has no sales remaining for the observed UTC day.'],['INSUFFICIENT_SOL','Your wallet has insufficient SOL for this purchase and transaction costs.'],
])('displays the observed %s hold without inventing a price, sale quota or missing permit',async(reason,message)=>{
 vi.mocked(api.getPrivate).mockImplementation(async path=>path.includes('/offer?')?{version:1,wallet:f.preparation.wallet,spot:0,realm:0,authorization:'none',status:'blocked',reason,offer:null} as never:
  {version:1,wallet:f.preparation.wallet,realm:0,authorization:'none',status:'unavailable',coverage:null} as never);
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(host.textContent).toContain(message));
 const offer=host.querySelector('[aria-label="Selected realm offer"]')!;expect(offer.querySelector('.sk-economy-hero strong')?.textContent).toBe('Offer unavailable');
 expect(offer.textContent).toContain('No price or quota confirmed');expect(host.textContent).toContain('This does not mean you have no permit.');expect(host.textContent).not.toContain('No current paid coverage');
 expect(button('PREPARE PURCHASE')?.disabled).toBe(true);expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});

it.each([
 ['freeze','resume','document'],['pagehide','pageshow','window'],['visibilitychange','visibilitychange','visibility'],
] as const)('retires completed advisory offers on %s and only fresh resumed observations enable preparation',async(suspend,resume,target)=>{
 let visible=true;Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));
 await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 const panel=()=>host.querySelector('[aria-label="Selected realm offer"]')!;
 expect(panel().textContent).toContain('No current paid coverage was observed');
 const previous=vi.mocked(api.getPrivate).mock.calls.length;
 await act(async()=>{if(target==='visibility')visible=false;(target==='window'?window:document).dispatchEvent(new Event(suspend));});
 expect(button('PREPARE PURCHASE')?.disabled).toBe(true);expect(panel().textContent).not.toContain('0.01 SOL');
 expect(panel().textContent).not.toContain('No current paid coverage was observed');expect(vi.mocked(api.getPrivate).mock.calls).toHaveLength(previous);
 vi.mocked(api.getPrivate).mockRejectedValue(Error('Resumed provider unavailable'));
 await act(async()=>{visible=true;(target==='window'?window:document).dispatchEvent(new Event(resume));});
 await until(()=>expect(button('REFRESH SELECTED OFFER')?.disabled).toBe(false));
 expect(vi.mocked(api.getPrivate).mock.calls).toHaveLength(previous+2);expect(button('PREPARE PURCHASE')?.disabled).toBe(true);
 expect(panel().textContent).toContain('Offer unavailable');expect(panel().textContent).not.toContain('No current paid coverage was observed');
 vi.mocked(api.getPrivate).mockImplementation(async path=>observation(path) as never);await click('REFRESH SELECTED OFFER');
 await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));expect(panel().textContent).toContain('0.01 SOL');
 expect(panel().textContent).toContain('No current paid coverage was observed');
 expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it('suspension synchronously retires delayed GETs and their late replies cannot repair failed resumed reads',async()=>{
 let release!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),guards:Array<()=>boolean>=[];
 vi.mocked(api.getPrivate).mockImplementation(async(path,options)=>{const raw=observation(path);guards.push(options!.isCurrent!);await waiting;return raw as never;});
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(guards).toHaveLength(2));
 expect(guards.every(guard=>guard())).toBe(true);
 await act(async()=>{document.dispatchEvent(new Event('freeze'));expect(guards.every(guard=>!guard())).toBe(true);});
 vi.mocked(api.getPrivate).mockRejectedValue(Error('Fresh read failed'));
 await act(async()=>document.dispatchEvent(new Event('resume')));await until(()=>expect(button('REFRESH SELECTED OFFER')?.disabled).toBe(false));
 await act(async()=>release());
 expect(button('PREPARE PURCHASE')?.disabled).toBe(true);expect(host.textContent).not.toContain('No current paid coverage was observed');
 expect(host.querySelector('[aria-label="Selected realm offer"] .sk-economy-hero strong')?.textContent).toBe('Offer unavailable');
 expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it('refresh invalidates completed advisory context immediately while retaining the original saved permit for explicit review',async()=>{
 const guards:Array<()=>boolean>=[];vi.mocked(api.getPrivate).mockImplementation(async(path,options)=>{guards.push(options!.isCurrent!);return observation(path) as never;});
 await act(async()=>root.render(<RealmSalesScreen actionsEnabled trust={trust()} onClose={()=>undefined}/>));await until(()=>expect(button('PREPARE PURCHASE')?.disabled).toBe(false));
 await click('PREPARE PURCHASE');await until(()=>expect(button('REVIEW ORIGINAL PURCHASE')?.disabled).toBe(false));const original=(await read()).operation!;
 const oldGuards=[...guards];expect(oldGuards.every(guard=>guard())).toBe(true);
 vi.mocked(api.getPrivate).mockRejectedValue(Error('Current provider unavailable'));
 await act(async()=>{button('REFRESH SELECTED OFFER')!.click();expect(oldGuards.every(guard=>!guard())).toBe(true);});
 await until(()=>expect(button('REFRESH SELECTED OFFER')?.disabled).toBe(false));
 expect(host.querySelector('[aria-label="Selected realm offer"] .sk-economy-hero strong')?.textContent).toBe('Offer unavailable');
 expect((await read()).operation).toEqual(original);
 await click('REVIEW ORIGINAL PURCHASE');await until(()=>expect(button('APPROVE IN WALLET')?.disabled).toBe(false));
 expect(host.querySelector('[aria-label="Approve original purchase"]')?.textContent).toContain('Spot 1');
 expect((await read()).operation).toEqual(original);
 expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.filter(([input])=>input.method==='POST')).toHaveLength(1);
 expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });

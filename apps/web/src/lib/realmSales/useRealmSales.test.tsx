// @vitest-environment happy-dom
import {act,StrictMode} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {IDBFactory} from 'fake-indexeddb';
import {Transaction} from '@solana/web3.js';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {authCookies} from '../../auth/authCookieCoordinator';
import {useApp} from '../../state/store';
import {RealmSaleJournalStore,type RealmSaleOperation} from './journal';
import {realmSaleIdentity} from './browser';
import {realmSaleSettlementFixture} from './settlement.test-support';
import {failedRealmSaleOriginal,prepareRealmSaleOriginal,savedRealmSaleOriginal,reviewRealmSaleOriginal,submitRealmSaleOriginal} from './transport';
import {useRealmSales} from './useRealmSales';
const mocks=vi.hoisted(()=>({wallet:{publicKey:null as unknown,signTransaction:vi.fn()}}));
vi.mock('../../auth/useGameWallet',()=>({useGameWallet:()=>mocks.wallet}));
vi.mock('./transport',()=>({failedRealmSaleOriginal:vi.fn(),prepareRealmSaleOriginal:vi.fn(),savedRealmSaleOriginal:vi.fn(),reviewRealmSaleOriginal:vi.fn(),submitRealmSaleOriginal:vi.fn()}));
let f:Awaited<ReturnType<typeof realmSaleSettlementFixture>>,root:Root,host:HTMLDivElement;
let live:ReturnType<typeof useRealmSales>;
function Harness({enabled=true}:{enabled?:boolean}){live=useRealmSales(enabled,enabled?{genesisHash:f.preparation.source.genesisHash,programId:f.preparation.source.programId,developer:f.preparation.terms.developer,reviewedProgramDataSha256:f.preparation.source.programDataSha256,reviewedDeploymentSlot:f.preparation.source.reviewedDeploymentSlot,revision:f.preparation.source.revision}:null);return <p>{live.state.error}</p>;}
const until=(check:()=>void)=>vi.waitFor(async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,0));});check();});
const invoke=async(action:Parameters<typeof live.run>[0])=>{await act(async()=>live.run(action));await until(()=>expect(live.state.busy).toBe(false));};
const store=()=>new RealmSaleJournalStore(realmSaleIdentity(f.preparation.wallet));
async function read(){const s=store();try{return await s.read();}finally{await s.close();}}
async function seed(signed=true,settled=false){const s=store(),p=f.preparation;let row=await s.compareAndSet(0,j=>({...j,operation:{request:{idempotencyKey:p.idempotencyKey,spot:p.spot,realm:p.realm},prepareAttempted:false,preparation:null,signingStarted:false,signed:null,submitAttempted:false}}));
 const patches:Partial<RealmSaleOperation>[]=[{prepareAttempted:true},{preparation:p}];if(signed)patches.push({signingStarted:true},{signed:{wire:Buffer.from(f.wire.signedTransactionHex,'hex').toString('base64'),signature:f.wire.signature}});if(settled)patches.push({settlementObserved:true},{settlement:{wire:f.wire,value:f.settlement}});
 for(const patch of patches)row=await s.compareAndSet(row.revision,j=>({...j,operation:{...j.operation!,...patch}}));await s.close();}
beforeEach(async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('indexedDB',new IDBFactory());
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});
 Object.defineProperty(navigator,'locks',{configurable:true,value:{request:async(_name:string,_options:unknown,run:(lock:object)=>Promise<unknown>)=>run({})}});
 vi.spyOn(authCookies,'assertSession').mockReturnValue('session');vi.spyOn(authCookies,'assertResponse').mockImplementation(()=>undefined);
 f=await realmSaleSettlementFixture();const p=f.preparation;
 vi.spyOn(crypto,'randomUUID').mockReturnValue(p.idempotencyKey as `${string}-${string}-${string}-${string}-${string}`);
 mocks.wallet.publicKey=f.sale.buyer.publicKey;mocks.wallet.signTransaction.mockReset().mockImplementation(async(tx:Transaction)=>{tx.partialSign(f.sale.buyer);return tx;});
 useApp.getState().setAuth(p.wallet,true);useApp.getState().setScreen('bases');
 vi.mocked(failedRealmSaleOriginal).mockReset().mockImplementation(async i=>{const raw={wallet:p.wallet,idempotencyKey:i.idempotencyKey,failure:null};await i.retain(raw);i.isCurrent();return raw;});
 const envelope=()=>({wallet:p.wallet,idempotencyKey:p.idempotencyKey,preparation:p});
 vi.mocked(prepareRealmSaleOriginal).mockReset().mockImplementation(async i=>{i.isCurrent();const value=envelope();await i.retain(value);return value;});
 vi.mocked(savedRealmSaleOriginal).mockReset().mockImplementation(async i=>{const value={...envelope(),wire:null,settlement:null};await i.retain(value);i.isCurrent();return value;});
 vi.mocked(reviewRealmSaleOriginal).mockReset().mockResolvedValue({version:1,saleId:p.saleId,wallet:p.wallet,idempotencyKey:p.idempotencyKey,messageSha256:p.quote.messageSha256,sourceRevision:p.source.revision,snapshotHash:p.source.snapshotHash,quoteSlot:p.source.admissionSlot,unixTimestamp:p.quote.unixTimestamp,validUntil:p.terms.validUntil,feeSlot:p.source.feeSlot,bracketSlot:p.source.admissionSlot,blockHeight:p.quote.lastValidBlockHeight,feeLamports:p.quote.feeLamports,rentLamports:p.quote.rentLamports,paymentDebitLamports:p.quote.paymentDebitLamports,requiredLamports:p.quote.requiredLamports,payerLamports:p.quote.payerLamports,quotaRemaining:p.quote.quotaRemaining,rents:p.quote.rents.map(r=>({address:r.address,lamports:r.maxIncreaseLamports})),admissionEligible:true,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false});
 vi.mocked(submitRealmSaleOriginal).mockReset();host=document.createElement('div');document.body.append(host);root=createRoot(host);
});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();Reflect.deleteProperty(document,'visibilityState');Reflect.deleteProperty(navigator,'locks');useApp.getState().setAuth(null);});
it('StrictMode, focus and reopen never prepare or approve a purchase without an explicit action',async()=>{
 await act(async()=>root.render(<StrictMode><Harness/></StrictMode>));await until(()=>{expect(live.state.loaded).toBe(true);expect(live.state.busy).toBe(false);});await act(async()=>window.dispatchEvent(new Event('focus')));await until(()=>expect(live.state.busy).toBe(false));
 expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
 await invoke(c=>c.begin(f.preparation.spot,f.preparation.realm));expect((await read()).operation?.preparation).toEqual(f.preparation);expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.filter(([i])=>i.method==='POST')).toHaveLength(1);expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});
it('keeps storage alive for a late approved exact signature after unmount, without submitting it',async()=>{
 await seed(false);await act(async()=>root.render(<Harness/>));await until(()=>{expect(live.state.loaded).toBe(true);expect(live.state.busy).toBe(false);});await invoke(c=>c.review());expect(live.state.review).not.toBeNull();
 let release!:()=>void;mocks.wallet.signTransaction.mockImplementation((tx:Transaction)=>new Promise(resolve=>{release=()=>{tx.partialSign(f.sale.buyer);resolve(tx);};}));
 await act(async()=>live.run(c=>c.sign()));await until(()=>expect(mocks.wallet.signTransaction).toHaveBeenCalledOnce());await act(async()=>root.render(null));await act(async()=>release());
 await vi.waitFor(async()=>expect((await read()).operation?.signed?.signature).toBe(f.wire.signature));expect(submitRealmSaleOriginal).not.toHaveBeenCalled();
});
it('providerless paused recovery archives offline while preserving cryptographically bound history',async()=>{
 await seed(true,true);await act(async()=>root.render(<Harness enabled={false}/>));await until(()=>expect(live.state.journal?.operation?.settlement).toBeDefined());expect(live.actionsAllowed).toBe(false);
 await invoke(c=>c.archive());expect((await read()).operation).toBeNull();const s=store();expect((await s.archived(f.preparation.idempotencyKey))?.operation?.settlement?.value).toEqual(f.settlement);await s.close();
 expect(prepareRealmSaleOriginal).not.toHaveBeenCalled();expect(savedRealmSaleOriginal).not.toHaveBeenCalled();expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});
it('queues a recovery read after an obsolete visibility request drains',async()=>{
 await seed(false);let release!:()=>void;const wait=new Promise<void>(r=>{release=r;});vi.mocked(prepareRealmSaleOriginal).mockImplementationOnce(async i=>{await wait;const value={wallet:f.preparation.wallet,idempotencyKey:f.preparation.idempotencyKey,preparation:f.preparation};await i.retain(value);i.isCurrent();return value;});
 await act(async()=>root.render(<Harness/>));await until(()=>expect(prepareRealmSaleOriginal).toHaveBeenCalledOnce());
 await act(async()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
 await act(async()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
 await act(async()=>release());await until(()=>{expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.length).toBeGreaterThan(1);expect(live.state.busy).toBe(false);});
 expect(vi.mocked(prepareRealmSaleOriginal).mock.calls.every(([i])=>i.method==='GET')).toBe(true);expect(mocks.wallet.signTransaction).not.toHaveBeenCalled();
});

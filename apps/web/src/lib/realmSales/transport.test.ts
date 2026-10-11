/** Browser DTO assertions are bounds/consistency checks, not signer authority. */
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {PHASE_E_POLICY,PHASE_E_SEEKER_SALE,PHASE_E_MINING_PUBLICATION} from '@shardkeep/shared';

const P=PHASE_E_POLICY.seekerIsland,address=(n:string)=>n.repeat(32),wallet=address('2'),idempotencyKey='12345678-1234-4234-8234-123456789abc';
function fixture(){const now=BigInt(PHASE_E_MINING_PUBLICATION.daySec),payment=BigInt(P.permitPriceLamports);return {
 version:1 as const,wallet,idempotencyKey,saleId:'01'.repeat(16),spot:0,realm:0,
 terms:{round:'0',day:'1',seller:address('3'),developer:address('4'),priorExpiry:'0',validAfter:String(now),validUntil:String(now+BigInt(PHASE_E_SEEKER_SALE.quoteTtlSec))},
 source:{revision:'browser-fixture',genesisHash:address('5'),programId:address('6'),programDataSha256:'ab'.repeat(32),reviewedDeploymentSlot:1,termProofHash:'cd'.repeat(32),snapshotHash:'ef'.repeat(32),termSlot:2,initialSlot:3,blockhashSlot:4,feeSlot:5,costSlot:6,admissionSlot:7},
 quote:{blockhash:address('7'),lastValidBlockHeight:9,unixTimestamp:String(now),needsAccess:false,needsQuota:false,quotaRemaining:P.paidContractsPerSpotDayMax,messageHex:'01'+'ab'.repeat(99),messageSha256:'de'.repeat(32),packetBytes:165,
 rents:[{address:address('8'),space:294,minimumBalanceLamports:'12',existingLamports:'5',maxIncreaseLamports:'7'}],feeLamports:'3',rentLamports:'7',paymentDebitLamports:String(payment),requiredLamports:String(payment+10n),payerLamports:String(payment+20n)},state:'prepared' as const,currentSigningAuthorized:false as const,submissionAuthorized:false as const,
};}
const request={idempotencyKey,spot:0,realm:0},envelope=()=>({wallet,idempotencyKey,preparation:fixture()}),wire=btoa(String.fromCharCode(1)+'s'.repeat(64)+String.fromCharCode(1)+'m'.repeat(99));
const saved=()=>({...envelope(),wire:null,settlement:null});
const submitted=()=>({wallet,idempotencyKey,wire:{original:'controller validates'},settlement:null,delivery:'submitted',reconciliation:{status:'submitted',purchaseFinalized:false}});
const json=(v:unknown,status=200)=>new Response(JSON.stringify(v),{status});
const flush=async()=>{for(let i=0;i<60;i++)await Promise.resolve();};
function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(r=>{resolve=r;}),resolve};}
function stream(){let c!:ReadableStreamDefaultController<Uint8Array>;return {response:new Response(new ReadableStream<Uint8Array>({start(value){c=value;}})),write:(value:string)=>c.enqueue(new TextEncoder().encode(value)),end:()=>c.close()};}
function review(){const a=fixture();return {version:1,saleId:a.saleId,wallet,idempotencyKey,messageSha256:a.quote.messageSha256,sourceRevision:a.source.revision,snapshotHash:'bc'.repeat(32),quoteSlot:7,unixTimestamp:a.quote.unixTimestamp,validUntil:a.terms.validUntil,feeSlot:8,bracketSlot:9,blockHeight:9,feeLamports:a.quote.feeLamports,rentLamports:a.quote.rentLamports,paymentDebitLamports:a.quote.paymentDebitLamports,requiredLamports:a.quote.requiredLamports,payerLamports:a.quote.payerLamports,quotaRemaining:a.quote.quotaRemaining,rents:a.quote.rents.map(r=>({address:r.address,lamports:r.maxIncreaseLamports})),admissionEligible:true,signingAuthorized:false,paymentAuthorized:false,submissionAuthorized:false,reservation:false};}
beforeEach(()=>{vi.resetModules();vi.stubGlobal('navigator',{locks:{request:async(_n:unknown,_o:unknown,run:()=>Promise<unknown>)=>run()}});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});
describe('realm sale original response transport',()=>{
 it('sends exact prepare and signed bytes once, retains every success and treats acknowledgment only as raw recovery data',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json(envelope(),201));vi.stubGlobal('fetch',fetch);const t=await import('./transport'),retain=vi.fn(async()=>undefined);
  await t.prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>true,retain});expect(fetch.mock.calls[0]![1]).toMatchObject({method:'POST',credentials:'include',cache:'no-store',redirect:'error',body:JSON.stringify(request)});
  fetch.mockImplementation(async()=>json(submitted(),202));expect(await t.submitRealmSaleOriginal({request:{idempotencyKey,signedTransaction:wire},isCurrent:()=>true,retain})).toEqual(submitted());expect(fetch.mock.calls[1]![1]!.body).toBe(JSON.stringify({idempotencyKey,signedTransaction:wire}));
  fetch.mockImplementation(async()=>json(saved()));await t.savedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain});expect(fetch.mock.calls[2]![0]).toMatch(`/seeker/realm-sales/by-key/${idempotencyKey}`);expect(fetch.mock.calls[2]![1]!.method).toBe('GET');expect(fetch).toHaveBeenCalledTimes(3);expect(retain).toHaveBeenCalledTimes(3);
 });
 it('owns a late response body and completes durable retention before rejecting an obsolete view',async()=>{
  const s=stream(),persist=deferred<void>();vi.stubGlobal('fetch',vi.fn(async()=>s.response));const {savedRealmSaleOriginal}=await import('./transport');let current=true,finished=false;
  const retain=vi.fn(async()=>persist.promise),pending=savedRealmSaleOriginal({idempotencyKey,isCurrent:()=>current,retain}).catch(e=>e).finally(()=>{finished=true;});await flush();current=false;s.write(JSON.stringify(saved()).slice(0,40));await flush();expect(retain).not.toHaveBeenCalled();s.write(JSON.stringify(saved()).slice(40));s.end();await flush();expect(retain).toHaveBeenCalledWith(saved());expect(finished).toBe(false);persist.resolve();expect(await pending).toMatchObject({message:'Sign-in changed. Please try again.'});
 });
 it('awaits late prepare headers and preserves storage failure over an obsolete-view error',async()=>{
  const headers=deferred<Response>();vi.stubGlobal('fetch',vi.fn(()=>headers.promise));const {prepareRealmSaleOriginal}=await import('./transport');let current=true;const disk=Error('durable storage failed');
  const retain=vi.fn(async()=>{throw disk;}),pending=prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>current,retain}).catch(e=>e);await flush();current=false;headers.resolve(json(envelope(),201));expect(await pending).toBe(disk);expect(retain).toHaveBeenCalledWith(envelope());
 });
 it('hands positive unparsed settlement to the controller before malformed nested wire can mask its hold',async()=>{
  const raw={...submitted(),settlement:{unknown:'positive'},wire:{invalid:true}},fetch=vi.fn(async()=>json(raw,202));vi.stubGlobal('fetch',fetch);const {submitRealmSaleOriginal}=await import('./transport');let held=false,current=true;
  const error=Error('controller rejected signed evidence');await expect(submitRealmSaleOriginal({request:{idempotencyKey,signedTransaction:wire},isCurrent:()=>current,retain:async value=>{held=(value as typeof raw).settlement!==null;current=false;throw error;}})).rejects.toBe(error);expect(held).toBe(true);expect(fetch).toHaveBeenCalledOnce();
 });
 it('binds prepare and review to the original request and keeps review GET-only',async()=>{
  const fetch=vi.fn<typeof globalThis.fetch>(async()=>json({...envelope(),preparation:{...fixture(),spot:1}}));vi.stubGlobal('fetch',fetch);const t=await import('./transport'),retain=vi.fn(async()=>undefined);
  await expect(t.prepareRealmSaleOriginal({request,method:'GET',isCurrent:()=>true,retain})).rejects.toThrow();expect(retain).not.toHaveBeenCalled();
  fetch.mockImplementation(async()=>json(review()));expect(await t.reviewRealmSaleOriginal({preparation:fixture(),isCurrent:()=>true})).toEqual(review());expect(fetch.mock.calls[1]![0]).toMatch(`/seeker/realm-sales/review/by-key/${idempotencyKey}`);expect(fetch.mock.calls[1]![1]).toMatchObject({method:'GET',body:null});
  fetch.mockImplementation(async()=>json({...review(),messageSha256:'00'.repeat(32)}));await expect(t.reviewRealmSaleOriginal({preparation:fixture(),isCurrent:()=>true})).rejects.toThrow();
 });
 it('rejects invalid or injected requests before fetch and never alters or retries signed bytes',async()=>{
  const fetch=vi.fn(async()=>json(submitted(),202));vi.stubGlobal('fetch',fetch);const t=await import('./transport'),retain=vi.fn(async()=>undefined),input={request:{idempotencyKey,signedTransaction:wire},isCurrent:()=>true,retain};
  for(const signedTransaction of [wire+'\n','A'.repeat(1648),'AA==',wire.slice(0,-1)+'='])await expect(t.submitRealmSaleOriginal({...input,request:{...input.request,signedTransaction}})).rejects.toThrow();
  await expect(t.submitRealmSaleOriginal({...input,request:{...input.request,extra:true}} as typeof input)).rejects.toThrow();await expect(t.savedRealmSaleOriginal({idempotencyKey:idempotencyKey.toUpperCase(),isCurrent:()=>true,retain})).rejects.toThrow();
  await expect(t.prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>true,retain,headers:{}} as Parameters<typeof t.prepareRealmSaleOriginal>[0])).rejects.toThrow();await expect(t.submitRealmSaleOriginal({...input,retain:undefined} as unknown as typeof input)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
 });
 it('restricts its exact family and rejects query, fragment, redirect, extra fields and oversized response bodies',async()=>{
  const {requestRealmSaleOriginal,requestMiningClaimOriginal,requestUnpaidOriginal}=await import('../api'),observe=vi.fn(async()=>({})),base={method:'POST' as const,path:'/seeker/realm-sales/prepare',body:request,isCurrent:()=>true,observe,timeoutMs:1000},fetch=vi.fn(async()=>json({}));vi.stubGlobal('fetch',fetch);
  await expect(requestMiningClaimOriginal(base)).rejects.toThrow();await expect(requestUnpaidOriginal(base)).rejects.toThrow();
  for(const path of ['/claims/mining/prepare','/seeker/realm-sales/prepare?x=1','/seeker/realm-sales/submit#x','/seeker/realm-sales/../submit','/seeker/realm-sales/prepare/','//other/seeker/realm-sales/submit'])await expect(requestRealmSaleOriginal({...base,path})).rejects.toThrow();
  for(const path of [`/seeker/realm-sales/by-key/${idempotencyKey.toUpperCase()}`,`/seeker/realm-sales/review/by-key/${idempotencyKey}?x=1`])await expect(requestRealmSaleOriginal({...base,method:'GET',body:undefined,path})).rejects.toThrow();
  await expect(requestRealmSaleOriginal({...base,extra:true} as typeof base)).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
  fetch.mockImplementation(async()=>new Response('{}',{status:302,headers:{location:'https://other.example'}}));await expect(requestRealmSaleOriginal(base)).rejects.toThrow();
  fetch.mockImplementation(async()=>json({huge:'x'.repeat(1_048_576)}));await expect(requestRealmSaleOriginal(base)).rejects.toThrow(/byte limit/);expect(observe).not.toHaveBeenCalled();
 });
 it('reports ordinary API errors without retaining a refusal, clearing evidence or repeating a request',async()=>{
  const fetch=vi.fn(async()=>json({error:{code:'PHASE_E_DISABLED',message:'Paused'}},503));vi.stubGlobal('fetch',fetch);const t=await import('./transport'),retain=vi.fn(async()=>undefined),{ApiError}=await import('../api');
  for(const run of [()=>t.prepareRealmSaleOriginal({request,method:'POST',isCurrent:()=>true,retain}),()=>t.savedRealmSaleOriginal({idempotencyKey,isCurrent:()=>true,retain}),()=>t.submitRealmSaleOriginal({request:{idempotencyKey,signedTransaction:wire},isCurrent:()=>true,retain})]){const error=await run().catch(e=>e);expect(error).toBeInstanceOf(ApiError);expect(error).toMatchObject({status:503,code:'PHASE_E_DISABLED'});}
  expect(retain).not.toHaveBeenCalled();expect(fetch).toHaveBeenCalledTimes(3);
 });
});

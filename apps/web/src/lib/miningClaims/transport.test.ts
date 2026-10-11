import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { miningClaimFixture } from './fixtures.test-support';
beforeEach(() => { vi.resetModules(); vi.stubGlobal('navigator', { locks: { request: async (_n: unknown, _o: unknown, run: () => Promise<unknown>) => run() } }); });
afterEach(() => vi.unstubAllGlobals());
it('sends exact preparation and signed bytes once through the bounded original transport', async () => {
  const f = miningClaimFixture(), fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(f.preparation), { status: 201 }));
  vi.stubGlobal('fetch', fetch); const { prepareMiningClaimOriginal, submitMiningOriginal, claimMiningOriginal } = await import('./transport');
  const request = { idempotencyKey: f.preparation.idempotencyKey }, retain = vi.fn(async () => undefined);
  await prepareMiningClaimOriginal({ request, method: 'POST', isCurrent: () => true, retain });
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(request);
  const body = { claimId: f.preparation.claimId, signedTransaction: f.signed().wire };
  fetch.mockImplementation(async () => new Response(JSON.stringify({ claimId: body.claimId, signature: f.signed().signature, delivery: 'held', reason: 'SEND_UNCERTAIN', serverNow: f.preparation.serverNow }), { status: 202 }));
  expect(await submitMiningOriginal({ request: body, isCurrent: () => true })).toMatchObject({ delivery: 'held' });
  expect(JSON.parse(fetch.mock.calls[1]![1]!.body as string)).toEqual(body);
  fetch.mockImplementation(async () => new Response(JSON.stringify(f.claim('retained'))));
  await claimMiningOriginal({ claimId: body.claimId, isCurrent: () => true, retain });
  expect(fetch.mock.calls[2]![1]!.method).toBe('GET'); expect(fetch).toHaveBeenCalledTimes(3);
});
it('awaits durable original preparation retention before an obsolete session rejects its view', async () => {
  const f = miningClaimFixture(); let current = true, saved = false;
  vi.stubGlobal('fetch', vi.fn(async () => { current = false; return new Response(JSON.stringify(f.preparation), { status: 201 }); }));
  const { prepareMiningClaimOriginal } = await import('./transport');
  await expect(prepareMiningClaimOriginal({ request: { idempotencyKey: f.preparation.idempotencyKey }, method: 'POST', isCurrent: () => current,
    retain: async () => { await Promise.resolve(); saved = true; } })).rejects.toThrow(); expect(saved).toBe(true);
});
it('retains only recognized first prepare refusal and never treats submit or GET errors as absence', async () => {
  const f = miningClaimFixture(), refusal = vi.fn(async () => undefined), retain = vi.fn(async () => undefined);
  const fetch = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'INSUFFICIENT_SOL', message: 'Fund this wallet' } }), { status: 422 }));
  vi.stubGlobal('fetch', fetch); const { prepareMiningClaimOriginal, submitMiningOriginal } = await import('./transport');
  const options = { request: { idempotencyKey: f.preparation.idempotencyKey }, isCurrent: () => true, retain, refusal };
  await expect(prepareMiningClaimOriginal({ ...options, method: 'POST' })).rejects.toThrow(); expect(refusal).toHaveBeenCalledOnce();
  await expect(prepareMiningClaimOriginal({ ...options, method: 'GET' })).rejects.toThrow();
  await expect(submitMiningOriginal({ request: { claimId: f.preparation.claimId, signedTransaction: f.signed().wire }, isCurrent: () => true })).rejects.toThrow();
  expect(refusal).toHaveBeenCalledOnce(); expect(retain).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledTimes(3);
});
it('keeps claim routes out of the unpaid allowlist and rejects other families, malformed paths and redirected replies', async () => {
  const f = miningClaimFixture(), { requestUnpaidOriginal, requestMiningClaimOriginal } = await import('../api');
  const observe = vi.fn(async () => ({})), input = { method: 'POST' as const, path: '/claims/mining/prepare', body: { idempotencyKey: f.preparation.idempotencyKey }, timeoutMs: 1000, observe, isCurrent: () => true };
  const fetch = vi.fn(async () => new Response('{}', { status: 302, headers: { location: 'https://other.example' } })); vi.stubGlobal('fetch', fetch);
  await expect(requestUnpaidOriginal(input)).rejects.toThrow();
  for (const path of ['/claims/genesis/prepare', '/claims/mining/prepare?wallet=x', '/claims/mining/../submit', '/deposits']) await expect(requestMiningClaimOriginal({ ...input, path })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled(); await expect(requestMiningClaimOriginal(input)).rejects.toThrow(); expect(observe).not.toHaveBeenCalled();
});
it('retains reused blockhash only as a first prepare 409 refusal and never retries it', async () => {
  const f=miningClaimFixture(),refusal=vi.fn(async()=>undefined),retain=vi.fn(async()=>undefined);
  const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{code:'CLAIM_BLOCKHASH_REUSED',message:'A newly observed blockhash is required'}}),{status:409}));
  vi.stubGlobal('fetch',fetch);const {prepareMiningClaimOriginal,submitMiningOriginal}=await import('./transport');
  const options={request:{idempotencyKey:f.preparation.idempotencyKey},isCurrent:()=>true,retain,refusal};
  await expect(prepareMiningClaimOriginal({...options,method:'POST'})).rejects.toThrow();expect(refusal).toHaveBeenCalledExactlyOnceWith({status:409,code:'CLAIM_BLOCKHASH_REUSED'});
  await expect(prepareMiningClaimOriginal({...options,method:'GET'})).rejects.toThrow();
  await expect(submitMiningOriginal({request:{claimId:f.preparation.claimId,signedTransaction:f.signed().wire},isCurrent:()=>true})).rejects.toThrow();
  fetch.mockImplementation(async()=>new Response(JSON.stringify({error:{code:'CLAIM_BLOCKHASH_REUSED',message:'Wrong status'}}),{status:503}));
  await expect(prepareMiningClaimOriginal({...options,method:'POST'})).rejects.toThrow();expect(refusal).toHaveBeenCalledOnce();expect(fetch).toHaveBeenCalledTimes(4);expect(retain).not.toHaveBeenCalled();
});

it('continues through only the exact mining POST/GET paths and retains a late original child',async()=>{
 const {orderedMiningFixture}=await import('./ordered.test-support'),f=orderedMiningFixture(),link=f.continuation(),result={version:1,wallet:f.identity.wallet,parentClaimId:f.preparation.claimId,status:'continued',continuation:link,serverNow:link.createdAt};
 let current=true;const retain=vi.fn(async()=>undefined),fetch=vi.fn<typeof globalThis.fetch>(async()=>{current=false;return new Response(JSON.stringify(result),{status:201});});vi.stubGlobal('fetch',fetch);
 const {continueMiningOriginal}=await import('./transport'),input={parentClaimId:f.preparation.claimId,request:{idempotencyKey:link.childPreparation.idempotencyKey},isCurrent:()=>current,retain};
 await expect(continueMiningOriginal(input)).rejects.toThrow();expect(retain).toHaveBeenCalledExactlyOnceWith(result);expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(input.request);
 current=true;fetch.mockImplementation(async()=>new Response(JSON.stringify(result)));await continueMiningOriginal({...input,request:null});expect(fetch.mock.calls[1]![1]!.method).toBe('GET');
 const {requestMiningClaimOriginal,requestUnpaidOriginal}=await import('../api'),base={method:'POST' as const,path:`/claims/mining/${f.preparation.claimId}/continue`,isCurrent:()=>true,timeoutMs:1000,observe:async()=>({})};await expect(requestUnpaidOriginal(base)).rejects.toThrow();for(const path of [base.path+'/',base.path+'?x=1',base.path+'#x'])await expect(requestMiningClaimOriginal({...base,path})).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
});
it('records only guaranteed no-child refusals, never network or storage uncertainty',async()=>{
 const f=miningClaimFixture(),refusal=vi.fn(async()=>undefined),retain=vi.fn(async()=>undefined);let code='MINING_CLAIM_NOT_EXPIRED',status=409;
 const fetch=vi.fn(async()=>new Response(JSON.stringify({error:{code,message:'Held'}}),{status}));vi.stubGlobal('fetch',fetch);const {continueMiningOriginal}=await import('./transport');
 const input={parentClaimId:f.preparation.claimId,request:{idempotencyKey:crypto.randomUUID()},isCurrent:()=>true,retain,refusal};await expect(continueMiningOriginal(input)).rejects.toThrow();expect(refusal).toHaveBeenCalledTimes(1);
 for(const next of ['MINING_CLAIM_BUSY','MINING_CLAIM_TIMEOUT','MINING_CLAIM_STORAGE_UNAVAILABLE','MINING_CLAIM_SOURCE_CONFLICT']){code=next;await expect(continueMiningOriginal(input)).rejects.toThrow();}
 code='MINING_CLAIM_NOT_EXPIRED';status=503;await expect(continueMiningOriginal(input)).rejects.toThrow();status=409;await expect(continueMiningOriginal({...input,request:null})).rejects.toThrow();expect(refusal).toHaveBeenCalledTimes(1);expect(retain).not.toHaveBeenCalled();
});
it('delivers an owned malformed terminal to durable retention before schema rejection',async()=>{
 const f=miningClaimFixture(),raw={...f.claim('prepared'),state:'settled'},retain=vi.fn(async()=>undefined);vi.stubGlobal('fetch',vi.fn(async()=>new Response(JSON.stringify(raw))));const {claimMiningOriginal}=await import('./transport');
 await expect(claimMiningOriginal({claimId:f.preparation.claimId,isCurrent:()=>true,retain})).rejects.toThrow();expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
});

import { Buffer } from 'buffer';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fixtures from '../../../../../packages/shared/src/testFixtures/miningTaxClaimRecoveryApi.json';

const p = fixtures.combined.preparation;
const identity = { origin: 'https://game.test', api: 'http://localhost:8787', cluster: 'devnet' as const, wallet: p.wallet };
const request = { idempotencyKey: p.idempotencyKey, round: p.round, spot: p.spot, caps: p.caps };
const prepared = { wallet: p.wallet, idempotencyKey: p.idempotencyKey, status: 'prepared', preparation: p, serverNow: p.preparedAt };
const submitted = { wallet: p.wallet, idempotencyKey: p.idempotencyKey, claimId: p.claimId, wire: fixtures.combined.wires[0], delivery: 'submitted', serverNow: p.preparedAt };
const signed = { idempotencyKey: p.idempotencyKey, signedTransaction: Buffer.from(fixtures.combined.wires[0]!.signedTransactionHex, 'hex').toString('base64') };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const deferred = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };

beforeEach(() => {
 vi.resetModules();
 vi.stubGlobal('navigator', { locks: { request: async (_name: unknown, _options: unknown, run: () => Promise<unknown>) => run() } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

it('uses only exact authenticated tax routes and immutable original POST bytes without retries', async () => {
 const fetch = vi.fn<typeof globalThis.fetch>(async () => response(prepared, 201)); vi.stubGlobal('fetch', fetch);
 const t = await import('./transport'), retain = vi.fn(async () => undefined), options = { identity, isCurrent: () => true, retain };
 await t.prepareMiningTaxClaimOriginal({ ...options, request, method: 'POST' });
 await t.prepareMiningTaxClaimOriginal({ ...options, request, method: 'GET' });
 fetch.mockImplementation(async () => response(fixtures.combined));
 await t.savedMiningTaxClaimOriginal({ ...options, idempotencyKey: p.idempotencyKey });
 fetch.mockImplementation(async () => response(submitted, 202));
 await t.submitMiningTaxClaimOriginal({ ...options, request: signed });
 expect(fetch.mock.calls.map(([url]) => url)).toEqual([
  `${identity.api}/claims/mining-tax/prepare`, `${identity.api}/claims/mining-tax/prepare/by-key/${p.idempotencyKey}`,
  `${identity.api}/claims/mining-tax/by-key/${p.idempotencyKey}`, `${identity.api}/claims/mining-tax/submit`,
 ]);
 for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ credentials: 'include', cache: 'no-store', redirect: 'error' });
 expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual(request);
 expect(fetch.mock.calls[1]![1]!.body).toBeNull();
 expect(JSON.parse(fetch.mock.calls[3]![1]!.body as string)).toEqual(signed);
 expect(retain).toHaveBeenCalledTimes(4);
});
it('reads only the selected current-review ordinal and preserves unavailable as a non-authorizing observation', async () => {
 const raw = { wallet: p.wallet, idempotencyKey: p.idempotencyKey, ordinal: 1, status: 'unavailable', review: null, reason: 'SETUP_REQUIRED', serverNow: p.preparedAt };
 const fetch = vi.fn<typeof globalThis.fetch>(async () => response(raw)); vi.stubGlobal('fetch', fetch);
 const t = await import('./transport');
 expect(await t.reviewMiningTaxClaimOriginal({ identity, idempotencyKey: p.idempotencyKey, ordinal: 1, isCurrent: () => true })).toEqual(raw);
 expect(fetch).toHaveBeenCalledWith(`${identity.api}/claims/mining-tax/review/by-key/${p.idempotencyKey}/1`, expect.objectContaining({ method: 'GET', body: null }));
 fetch.mockImplementation(async () => response({ ...raw, ordinal: 0 }));
 await expect(t.reviewMiningTaxClaimOriginal({ identity, idempotencyKey: p.idempotencyKey, ordinal: 1, isCurrent: () => true })).rejects.toThrow(/packet/);
});
it('awaits original retention before an obsolete response or malformed adjacent receipt rejects', async () => {
 const raw = { ...fixtures.combined, settlement: { broken: true } }, gate = deferred<void>();
 let current = true, finished = false;
 vi.stubGlobal('fetch', vi.fn(async () => { current = false; return response(raw); }));
 const t = await import('./transport'), retain = vi.fn(async () => { await gate.promise; finished = true; });
 const work = t.savedMiningTaxClaimOriginal({ identity, idempotencyKey: p.idempotencyKey, isCurrent: () => current, retain });
 const failure = expect(work).rejects.toThrow();
 await vi.waitFor(() => expect(retain).toHaveBeenCalledExactlyOnceWith(raw));
 expect(finished).toBe(false); gate.resolve(); await failure; expect(finished).toBe(true);
});
it('passes positive custody through its owner before outer actor validation and propagates storage failure', async () => {
 const raw = { ...fixtures.combined, wallet: p.identity.keepMint };
 vi.stubGlobal('fetch', vi.fn(async () => response(raw)));
 const t = await import('./transport'), retain = vi.fn(async () => { throw Error('durable wire save failed'); });
 await expect(t.savedMiningTaxClaimOriginal({ identity, idempotencyKey: p.idempotencyKey, isCurrent: () => true, retain })).rejects.toThrow('durable wire save failed');
 expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
});
it('keeps STORAGE_UNCERTAIN as raw held custody and never turns delivery into terminal proof', async () => {
 const raw = { wallet: p.wallet, idempotencyKey: p.idempotencyKey, claimId: null, wire: null, delivery: 'held', reason: 'STORAGE_UNCERTAIN', serverNow: p.preparedAt };
 vi.stubGlobal('fetch', vi.fn(async () => response(raw, 202)));
 const t = await import('./transport'), retain = vi.fn(async () => undefined);
 expect(await t.submitMiningTaxClaimOriginal({ identity, request: signed, isCurrent: () => true, retain })).toEqual(raw);
 expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
});
it('rejects changed configured base, malformed routes, noncanonical bytes and absent evidence ownership before fetch', async () => {
 const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
 const t = await import('./transport'), options = { identity, isCurrent: () => true, retain: async () => undefined };
 await expect(t.savedMiningTaxClaimOriginal({ ...options, identity: { ...identity, api: 'https://foreign.test' }, idempotencyKey: p.idempotencyKey })).rejects.toThrow();
 await expect(t.savedMiningTaxClaimOriginal({ ...options, idempotencyKey: `${p.idempotencyKey}?wallet=x` })).rejects.toThrow();
 await expect(t.reviewMiningTaxClaimOriginal({ identity, isCurrent: () => true, idempotencyKey: p.idempotencyKey, ordinal: 2 })).rejects.toThrow();
 await expect(t.submitMiningTaxClaimOriginal({ ...options, request: { ...signed, signedTransaction: `${signed.signedTransaction}\n` } })).rejects.toThrow();
 await expect(t.prepareMiningTaxClaimOriginal({ ...options, request, method: 'POST', retain: undefined } as never)).rejects.toThrow();
 expect(fetch).not.toHaveBeenCalled();
});
it('rejects redirects, foreign final URLs and oversized or invalid UTF-8 bodies without exposing them as proof', async () => {
 const t = await import('./transport'), retain = vi.fn(async () => undefined), options = { identity, idempotencyKey: p.idempotencyKey, isCurrent: () => true, retain };
 const foreign = response(fixtures.combined); Object.defineProperty(foreign, 'url', { value: 'https://foreign.test/claims/mining-tax/by-key/x' });
 for (const result of [new Response('{}', { status: 302 }), foreign, new Response('x'.repeat(1_048_577)), new Response(Uint8Array.of(0xff))]) {
  vi.stubGlobal('fetch', vi.fn(async () => result)); await expect(t.savedMiningTaxClaimOriginal(options)).rejects.toThrow();
 }
 expect(retain).not.toHaveBeenCalled();
});
it('bounds a stalled body without holding the authenticated cookie drain forever', async () => {
 vi.useFakeTimers();
 const cancel = vi.fn(), body = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel });
 const fetch = vi.fn(async () => new Response(body)); vi.stubGlobal('fetch', fetch);
 const t = await import('./transport'), retain = vi.fn(async () => undefined);
 const failure = expect(t.savedMiningTaxClaimOriginal({ identity, idempotencyKey: p.idempotencyKey, isCurrent: () => true, retain })).rejects.toThrow(/timed out/);
 await vi.advanceTimersByTimeAsync(LAND_CHECKOUT_RECOVERY.requestTimeoutMs); await failure;
 expect(retain).not.toHaveBeenCalled(); expect(fetch).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
});
it('keeps error responses uncertain, retains any positive evidence on them, and never retries', async () => {
 const fetch = vi.fn(async () => response({ error: { code: 'MINING_TAX_UNAVAILABLE', message: 'Recover original' } }, 503)); vi.stubGlobal('fetch', fetch);
 const t = await import('./transport'), retain = vi.fn(async () => undefined), options = { identity, isCurrent: () => true, retain };
 await expect(t.prepareMiningTaxClaimOriginal({ ...options, request, method: 'POST' })).rejects.toThrow();
 expect(retain).not.toHaveBeenCalled();
 fetch.mockImplementation(async () => response({ ...fixtures.combined, settlement: { broken: true } }, 503));
 await expect(t.savedMiningTaxClaimOriginal({ ...options, idempotencyKey: p.idempotencyKey })).rejects.toThrow();
 expect(retain).toHaveBeenCalledOnce(); expect(fetch).toHaveBeenCalledTimes(2);
});
it('reads failed history only from its exact authenticated GET route',async()=>{
 const raw={recovery:fixtures.combined,failures:[]},fetch=vi.fn(async()=>response(raw));vi.stubGlobal('fetch',fetch);
 const t=await import('./transport'),retain=vi.fn(async()=>undefined);
 expect(await t.failedMiningTaxClaimOriginal({identity,idempotencyKey:p.idempotencyKey,isCurrent:()=>true,retain})).toEqual(raw);
 expect(fetch).toHaveBeenCalledExactlyOnceWith(`${identity.api}/claims/mining-tax/failures/by-key/${p.idempotencyKey}`,expect.objectContaining({method:'GET',body:null,credentials:'include',cache:'no-store'}));
 expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
});
it.each([200,503])('drains nested failure custody on HTTP%s before rejecting a malformed retired response',async status=>{
 const raw={recovery:fixtures.combined,failures:[{ordinal:0,broken:true}]},gate=deferred<void>();let current=true,finished=false;
 vi.stubGlobal('fetch',vi.fn(async()=>{current=false;return response(raw,status);}));const t=await import('./transport'),retain=vi.fn(async()=>{await gate.promise;finished=true;});
 const pending=expect(t.failedMiningTaxClaimOriginal({identity,idempotencyKey:p.idempotencyKey,isCurrent:()=>current,retain})).rejects.toThrow();
 await vi.waitFor(()=>expect(retain).toHaveBeenCalledExactlyOnceWith(raw));expect(finished).toBe(false);gate.resolve();await pending;expect(finished).toBe(true);
});
it('retains attributed failure observations on errors even without readable nested recovery',async()=>{
 const raw={failures:[{ordinal:1}]};vi.stubGlobal('fetch',vi.fn(async()=>response(raw,503)));const t=await import('./transport'),retain=vi.fn(async()=>undefined);
 await expect(t.failedMiningTaxClaimOriginal({identity,idempotencyKey:p.idempotencyKey,isCurrent:()=>true,retain})).rejects.toThrow();expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
});
it.each(['signed','setup','settled'])('retains malformed nested %s status on a non-success response before account retirement',async status=>{
 const raw={recovery:{status},failures:[]};let current=true;vi.stubGlobal('fetch',vi.fn(async()=>{current=false;return response(raw,503);}));
 const t=await import('./transport'),retain=vi.fn(async()=>undefined);await expect(t.failedMiningTaxClaimOriginal({identity,idempotencyKey:p.idempotencyKey,isCurrent:()=>current,retain})).rejects.toThrow();expect(retain).toHaveBeenCalledExactlyOnceWith(raw);
});
it('posts exact continuation consent once and recovers only its parent link by authenticated GET',async()=>{
 const {default:raw}=await import('../../../../../packages/shared/src/testFixtures/miningTaxClaimContinuationApi.json'),parent=raw.parentIdempotencyKey,child=raw.continuation!.childPreparation;
 const fetch=vi.fn<typeof globalThis.fetch>(async()=>response(raw,201));vi.stubGlobal('fetch',fetch);const t=await import('./transport'),retain=vi.fn(async()=>undefined),options={identity:{...identity,wallet:raw.wallet},parentIdempotencyKey:parent,isCurrent:()=>true,retain};
 await t.prepareMiningTaxClaimContinuation({...options,request:{idempotencyKey:child.idempotencyKey,caps:child.caps}});await t.savedMiningTaxClaimContinuation(options);
 expect(fetch.mock.calls.map(([url])=>url)).toEqual([`${identity.api}/claims/mining-tax/continue/${parent}`,`${identity.api}/claims/mining-tax/continuations/by-key/${parent}`]);expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toEqual({idempotencyKey:child.idempotencyKey,caps:child.caps});expect(fetch.mock.calls[1]![1]!.body).toBeNull();expect(retain).toHaveBeenCalledTimes(2);
});
it.each([200,503])('drains positive continuation evidence before invalid actor/session on HTTP%s',async status=>{
 const raw={wallet:'bad',status:'continued',continuation:{broken:true}},gate=deferred<void>();let current=true,finished=false;vi.stubGlobal('fetch',vi.fn(async()=>{current=false;return response(raw,status);}));const t=await import('./transport'),retain=vi.fn(async()=>{await gate.promise;finished=true;});
 const pending=expect(t.savedMiningTaxClaimContinuation({identity,parentIdempotencyKey:p.idempotencyKey,isCurrent:()=>current,retain})).rejects.toThrow();await vi.waitFor(()=>expect(retain).toHaveBeenCalledExactlyOnceWith(raw));expect(finished).toBe(false);gate.resolve();await pending;expect(finished).toBe(true);
});

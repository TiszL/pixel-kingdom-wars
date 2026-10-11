/** Tax-only authenticated original response drain. No retries, arbitrary routes,
 * wallet operations, current admission or terminal/archival decisions. */
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { MiningTaxClaimPrepareRequestSchema, MiningTaxClaimPreparationEnvelopeSchema, type MiningTaxClaimPrepareRequest } from '@shardkeep/shared/miningTaxClaimsApi';
import { MiningTaxClaimSubmitRequestSchema, MiningTaxClaimSubmitResponseSchema, validateMiningTaxClaimRecoveryEnvelope } from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import { MiningTaxClaimReviewResponseSchema } from '@shardkeep/shared/miningTaxClaimReviewApi';
import { MiningTaxClaimFailureEnvelopeSchema } from '@shardkeep/shared/miningTaxClaimFailureApi';
import { MiningTaxClaimContinuationEnvelopeSchema,MiningTaxClaimContinuationRequestSchema,type MiningTaxClaimContinuationRequest } from '@shardkeep/shared/miningTaxClaimContinuationApi';
import { authCookies } from '../../auth/authCookieCoordinator';
import { AuthChangedError } from '../../auth/authCookieCoordinatorCore';
import { API_URL, ApiError } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { parseMiningTaxClaimIdentity, type MiningTaxClaimIdentity } from './journal';

type Current = { identity: MiningTaxClaimIdentity; isCurrent: () => boolean; isResponseCurrent?: () => boolean };
type Retain = { retain: (raw: unknown) => Promise<void> };
const key = (value: unknown) => MiningTaxClaimPrepareRequestSchema.shape.idempotencyKey.parse(value);
function need(value: unknown, message: string): asserts value { if (!value) throw Error(message); }
function options(input: unknown, fields: string[]) {
 need(input && typeof input === 'object' && !Array.isArray(input), 'Invalid original tax options.');
 const own = Reflect.ownKeys(input);
 need(fields.every(k => Object.hasOwn(input, k)) && own.every(k => typeof k === 'string' && [...fields, 'isResponseCurrent'].includes(k) && 'value' in Object.getOwnPropertyDescriptor(input, k)!), 'Invalid original tax option fields.');
 const value = input as Current & Partial<Retain>;
 need(typeof value.isCurrent === 'function' && (value.isResponseCurrent === undefined || typeof value.isResponseCurrent === 'function') && (!fields.includes('retain') || typeof value.retain === 'function'), 'Original tax evidence ownership is required.');
}
function scope(raw: MiningTaxClaimIdentity): MiningTaxClaimIdentity {
 const identity = parseMiningTaxClaimIdentity(raw);
 need(identity.api === new URL(API_URL, identity.origin).href.replace(/\/$/, '') && identity.cluster === SOLANA_CLUSTER
  && (typeof window === 'undefined' || identity.origin === window.location.origin), 'Tax recovery belongs to another origin, API or network.');
 return identity;
}
function actor(value: { wallet: string; idempotencyKey: string }, identity: MiningTaxClaimIdentity, idempotencyKey: string) {
 need(value.wallet === identity.wallet && value.idempotencyKey === idempotencyKey, 'Tax response belongs to another original wallet or key.');
}
function positive(raw: unknown): boolean {
 if (!raw || typeof raw !== 'object') return false;
 const field = (name: string) => Object.getOwnPropertyDescriptor(raw, name)?.value;
 const recovery=field('recovery'),failures=field('failures');
 return field('continuation')!=null||field('status')==='continued'||recovery!=null && (Object.getOwnPropertyDescriptor(recovery,'settlement')?.value!=null || Object.getOwnPropertyDescriptor(recovery,'wires')?.value?.length>0
   || ['signed','setup','settled'].includes(Object.getOwnPropertyDescriptor(recovery,'status')?.value))
  || failures!=null && (!Array.isArray(failures)||failures.length>0)
  || field('settlement') != null || field('wire') != null || Array.isArray(field('wires')) && field('wires').length > 0
  || ['signed', 'setup', 'settled'].includes(field('status')) || ['held', 'submitted', 'setup', 'settled'].includes(field('delivery'));
}
async function request<T>(input: Current & { method: 'GET' | 'POST'; path: string; body?: unknown; observe(raw: unknown): Promise<T>; retainError?: Retain['retain'] }): Promise<T> {
 const identity = scope(input.identity), url = `${identity.api}${input.path}`, revision = authCookies.assertSession();
 const current = (responseOwned = false) => {
  authCookies.assertResponse(revision);
  if (!(responseOwned ? input.isResponseCurrent ?? input.isCurrent : input.isCurrent)()) throw new AuthChangedError();
 };
 let owned: Promise<T> | undefined;
 try {
  return await authCookies.session(() => {
   current();
   owned = (async () => {
    const abort = new AbortController(), timeout = new ApiError(0, 'Original tax response timed out. Keep the original request.', 'ORIGINAL_RESPONSE_TIMEOUT');
    const timer = setTimeout(() => abort.abort(timeout), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    const bounded = <V,>(pending: Promise<V>): Promise<V> => new Promise((resolve, reject) => {
     const stop = () => { abort.signal.removeEventListener('abort', stop); reject(abort.signal.reason); };
     abort.signal.addEventListener('abort', stop, { once: true });
     pending.then(value => { abort.signal.removeEventListener('abort', stop); resolve(value); }, error => { abort.signal.removeEventListener('abort', stop); reject(error); });
     if (abort.signal.aborted) stop();
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
     current();
     const response = await bounded(fetch(url, {
      method: input.method, credentials: 'include', cache: 'no-store', redirect: 'error', signal: abort.signal,
      headers: { 'x-sim-version': String(SIM_VERSION), ...(input.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      body: input.method === 'POST' ? JSON.stringify(input.body) : null,
     }));
     need(!response.redirected && !(response.status >= 300 && response.status < 400) && (!response.url || response.url === url) && response.body, 'Invalid original tax response destination.');
     // After headers, the bounded body belongs to this original request even
     // after its view retires. The cookie lock stays held through durable save.
     reader = response.body.getReader();
     const decoder = new TextDecoder('utf-8', { fatal: true });
     let bytes = 0, text = '';
     while (true) {
      const part = await bounded(reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      need(bytes <= 1_048_576, 'Original tax response exceeds byte limit.'); // Transport bound, not game policy.
      text += decoder.decode(part.value, { stream: true });
     }
     text += decoder.decode();
     const raw: unknown = JSON.parse(text);
     clearTimeout(timer);
     if (!response.ok) {
      if (positive(raw)) await input.retainError?.(raw);
      current(true);
      throw new ApiError(response.status, 'Tax recovery is unavailable. Keep the original request.', 'MINING_TAX_UNAVAILABLE');
     }
     const value = await input.observe(raw);
     current(true);
     return value;
    } finally {
     clearTimeout(timer); abort.abort(); void reader?.cancel().catch(() => undefined);
    }
   })();
   return owned;
  });
 } finally {
  // Keep storage failure visible and never let a retired session detach an
  // already received signature/positive observation from its original journal.
  if (owned) await owned;
 }
}

export async function prepareMiningTaxClaimOriginal(input: Current & Retain & { request: MiningTaxClaimPrepareRequest; method: 'GET' | 'POST' }): Promise<unknown> {
 options(input, ['identity', 'request', 'method', 'isCurrent', 'retain']);
 need(input.method === 'GET' || input.method === 'POST', 'Invalid original tax preparation method.');
 const original = MiningTaxClaimPrepareRequestSchema.parse(input.request), identity = scope(input.identity), { method, isCurrent, retain } = input;
 return request({ identity, method, path: method === 'POST' ? '/claims/mining-tax/prepare' : `/claims/mining-tax/prepare/by-key/${original.idempotencyKey}`,
  ...(method === 'POST' ? { body: original } : {}), isCurrent, ...(input.isResponseCurrent ? { isResponseCurrent: input.isResponseCurrent } : {}), retainError: retain,
  observe: async raw => {
   await retain(raw);
   const value = MiningTaxClaimPreparationEnvelopeSchema.parse(raw); actor(value, identity, original.idempotencyKey);
   if (value.preparation) {
    const p = value.preparation;
    need(p.round === original.round && p.spot === original.spot && Object.entries(original.caps).every(([name, cap]) => p.caps[name as keyof typeof p.caps] === cap), 'Tax preparation changed original intent or caps.');
   } else need(method === 'GET', 'Tax preparation response has no original consent.');
   return value;
  } });
}
export async function savedMiningTaxClaimOriginal(input: Current & Retain & { idempotencyKey: string }): Promise<unknown> {
 options(input, ['identity', 'idempotencyKey', 'isCurrent', 'retain']);
 const original = key(input.idempotencyKey), identity = scope(input.identity), { isCurrent, retain } = input;
 return request({ identity, method: 'GET', path: `/claims/mining-tax/by-key/${original}`, isCurrent, ...(input.isResponseCurrent ? { isResponseCurrent: input.isResponseCurrent } : {}), retainError: retain, observe: async raw => {
  await retain(raw); const value = validateMiningTaxClaimRecoveryEnvelope(raw); actor(value, identity, original); return value;
 } });
}
export async function reviewMiningTaxClaimOriginal(input: Current & { idempotencyKey: string; ordinal: number }) {
 options(input, ['identity', 'idempotencyKey', 'ordinal', 'isCurrent']);
 const original = key(input.idempotencyKey), identity = scope(input.identity), { ordinal, isCurrent } = input;
 need(ordinal === 0 || ordinal === 1, 'Invalid original tax review ordinal.');
 return request({ identity, method: 'GET', path: `/claims/mining-tax/review/by-key/${original}/${ordinal}`, isCurrent, ...(input.isResponseCurrent ? { isResponseCurrent: input.isResponseCurrent } : {}), observe: async raw => {
  const value = MiningTaxClaimReviewResponseSchema.parse(raw); actor(value, identity, original);
  need(value.ordinal === ordinal, 'Tax review belongs to another original packet.'); return value;
 } });
}
export async function failedMiningTaxClaimOriginal(input: Current & Retain & { idempotencyKey: string }): Promise<unknown> {
 options(input, ['identity', 'idempotencyKey', 'isCurrent', 'retain']);
 const original=key(input.idempotencyKey),identity=scope(input.identity),{isCurrent,retain}=input;
 return request({identity,method:'GET',path:`/claims/mining-tax/failures/by-key/${original}`,isCurrent,...(input.isResponseCurrent?{isResponseCurrent:input.isResponseCurrent}:{}),retainError:retain,observe:async raw=>{
  await retain(raw);const value=MiningTaxClaimFailureEnvelopeSchema.parse(raw);actor(value.recovery,identity,original);return value;
 }});
}
export async function submitMiningTaxClaimOriginal(input: Current & Retain & { request: { idempotencyKey: string; signedTransaction: string } }): Promise<unknown> {
 options(input, ['identity', 'request', 'isCurrent', 'retain']);
 const original = MiningTaxClaimSubmitRequestSchema.parse(input.request), identity = scope(input.identity), { isCurrent, isResponseCurrent, retain } = input;
 return request({ identity, method: 'POST', path: '/claims/mining-tax/submit', body: original, isCurrent, ...(isResponseCurrent ? { isResponseCurrent } : {}), retainError: retain, observe: async raw => {
  await retain(raw); const value = MiningTaxClaimSubmitResponseSchema.parse(raw); actor(value, identity, original.idempotencyKey); return value;
 } });
}

export async function savedMiningTaxClaimContinuation(input:Current&Retain&{parentIdempotencyKey:string}):Promise<unknown>{
 options(input,['identity','parentIdempotencyKey','isCurrent','retain']);const parent=key(input.parentIdempotencyKey),identity=scope(input.identity),{isCurrent,retain}=input;
 return request({identity,method:'GET',path:`/claims/mining-tax/continuations/by-key/${parent}`,isCurrent,...(input.isResponseCurrent?{isResponseCurrent:input.isResponseCurrent}:{}),retainError:retain,observe:async raw=>{
  await retain(raw);const value=MiningTaxClaimContinuationEnvelopeSchema.parse(raw);actor({wallet:value.wallet,idempotencyKey:value.parentIdempotencyKey},identity,parent);return value;
 }});
}
export async function prepareMiningTaxClaimContinuation(input:Current&Retain&{parentIdempotencyKey:string;request:MiningTaxClaimContinuationRequest}):Promise<unknown>{
 options(input,['identity','parentIdempotencyKey','request','isCurrent','retain']);const parent=key(input.parentIdempotencyKey),child=MiningTaxClaimContinuationRequestSchema.parse(input.request),identity=scope(input.identity),{isCurrent,retain}=input;
 need(parent!==child.idempotencyKey,'Continuation requires distinct additional consent.');
 return request({identity,method:'POST',path:`/claims/mining-tax/continue/${parent}`,body:child,isCurrent,...(input.isResponseCurrent?{isResponseCurrent:input.isResponseCurrent}:{}),retainError:retain,observe:async raw=>{
  await retain(raw);const value=MiningTaxClaimContinuationEnvelopeSchema.parse(raw);actor({wallet:value.wallet,idempotencyKey:value.parentIdempotencyKey},identity,parent);const p=value.continuation?.childPreparation;
  need(p&&p.idempotencyKey===child.idempotencyKey&&Object.entries(child.caps).every(([k,v])=>p.caps[k as keyof typeof child.caps]===v),'Continuation differs from the saved child consent.');return value;
 }});
}

import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { MiningClaimContinuationRequestSchema,MiningClaimContinuationEnvelopeSchema,MiningClaimPrepareRequestSchema, MiningClaimPreparationViewSchema, MiningClaimPreparationEnvelopeSchema, MiningClaimSubmitRequestSchema,
  MiningClaimSubmitResponseSchema, MiningClaimViewSchema, type MiningClaimPrepareRequest, type MiningClaimSubmitRequest } from '@shardkeep/shared/miningClaimsApi';
import { requestMiningClaimOriginal } from '../api';
import { miningContinuationRefusalDefinitive,miningClaimPrepareRefusalDefinitive } from './journal';
type Current = { isCurrent: () => boolean };
type Retain = { retain: (raw: unknown) => Promise<void> };
function refusal(raw: unknown): { code: string; message: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length !== 1 || !('error' in raw)) throw Error('Invalid mining claim error response.');
  const error = raw.error;
  if (!error || typeof error !== 'object' || Array.isArray(error) || Object.keys(error).some(k => !['code', 'message'].includes(k))
    || !('code' in error) || typeof error.code !== 'string' || !('message' in error) || typeof error.message !== 'string' || !error.message) throw Error('Invalid mining claim refusal.');
  return { code: error.code, message: error.message };
}
/** The controller already persisted its sole attempt marker before this POST. */
export function prepareMiningClaimOriginal(input: Current & Retain & { request: MiningClaimPrepareRequest; method: 'GET' | 'POST';
  refusal?: (value: { status: number; code: string }) => Promise<void> }): Promise<unknown> {
  const request = MiningClaimPrepareRequestSchema.parse(input.request);
  return requestMiningClaimOriginal({ method: input.method,
    path: input.method === 'POST' ? '/claims/mining/prepare' : `/claims/mining/prepare/by-key/${encodeURIComponent(request.idempotencyKey)}`,
    ...(input.method === 'POST' ? { body: request } : {}), isCurrent: input.isCurrent, timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
    observe: async (status, raw) => {
      if (status >= 200 && status < 300) {
        const value = input.method === 'POST' ? MiningClaimPreparationViewSchema.parse(raw) : MiningClaimPreparationEnvelopeSchema.parse(raw);
        if (value.idempotencyKey !== request.idempotencyKey) throw Error('The mining response belongs to another original request.');
        await input.retain(value); return value;
      }
      const error = refusal(raw);
      if (input.method === 'POST' && miningClaimPrepareRefusalDefinitive(status, error.code)) await input.refusal?.({ status, code: error.code });
      return undefined;
    } });
}
export function claimMiningOriginal(input: Current & Retain & { claimId: string }): Promise<unknown> {
  return requestMiningClaimOriginal({ method: 'GET', path: `/claims/mining/${encodeURIComponent(input.claimId)}`,
    isCurrent: input.isCurrent, timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs, observe: async (status, raw) => {
      if (status < 200 || status >= 300) { refusal(raw); return undefined; }
      // Retain an owned terminal hint before strict parsing can throw. The journal
      // latches a hold if a terminal cannot be authenticated; it never treats it as payment.
      if(raw&&typeof raw==='object'&&'claimId' in raw&&raw.claimId===input.claimId)await input.retain(raw);
      const claim = MiningClaimViewSchema.parse(raw); if (claim.claimId !== input.claimId) throw Error('The payment response belongs to another claim.');
      return claim;
    } });
}
/** An acknowledgment is not terminal evidence. The caller recovers via GET. */
export function submitMiningOriginal(input: Current & { request: MiningClaimSubmitRequest }): Promise<unknown> {
  const request = MiningClaimSubmitRequestSchema.parse(input.request);
  return requestMiningClaimOriginal({ method: 'POST', path: '/claims/mining/submit', body: request,
    isCurrent: input.isCurrent, timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs, observe: async (status, raw) => {
      if (status < 200 || status >= 300) { refusal(raw); return undefined; }
      const response = MiningClaimSubmitResponseSchema.parse(raw);
      if (response.claimId !== request.claimId) throw Error('The response belongs to another signed claim.'); return response;
    } });
}

/** A continuation POST is attempted once; a lost reply uses the parent's GET. */
export function continueMiningOriginal(input:Current&Retain&{parentClaimId:string;request:{idempotencyKey:string}|null;refusal?:(raw:{status:number;code:string})=>Promise<void>}):Promise<unknown>{
 const request=input.request===null?null:MiningClaimContinuationRequestSchema.parse(input.request);
 return requestMiningClaimOriginal({method:request?'POST':'GET',path:`/claims/mining/${encodeURIComponent(input.parentClaimId)}/${request?'continue':'continuation'}`,
  ...(request?{body:request}:{}),isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,observe:async(status,raw)=>{
   if(status<200||status>=300){const error=refusal(raw);if(request&&miningContinuationRefusalDefinitive(status,error.code))await input.refusal?.({status,code:error.code});return undefined;}
   const result=MiningClaimContinuationEnvelopeSchema.parse(raw);if(result.parentClaimId!==input.parentClaimId)throw Error('Continuation belongs to another original.');
   await input.retain(result);return result;
  }});
}

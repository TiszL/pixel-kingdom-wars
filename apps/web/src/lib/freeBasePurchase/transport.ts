import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { FreeBasePurchaseReceiptSchema, FreeBasePurchaseReceiptEnvelopeSchema, FreeBasePurchaseRequestSchema, type FreeBasePurchaseRequest } from '@shardkeep/shared/freeBasePurchaseApi';
import { requestUnpaidOriginal } from '../api';
import { freeBasePurchaseRefusalDefinitive, type FreeBasePurchaseProof } from './journal';
/** Exact wire boundary. The controller's retention callback binds all receipt terms
 * to the durable original before a superseded session/view can reject publication. */
export async function purchaseOriginal(input:{request:FreeBasePurchaseRequest;method:'GET'|'POST';firstAttempt:boolean;isCurrent:()=>boolean;
  retain:(proof:FreeBasePurchaseProof)=>Promise<void>;refusal:(value:{status:number;code:string})=>Promise<void>}):Promise<FreeBasePurchaseProof> {
 const request=FreeBasePurchaseRequestSchema.parse(input.request);
 return requestUnpaidOriginal({method:input.method,path:input.method==='POST'?'/bases/free-purchases':`/bases/free-purchases/by-key/${encodeURIComponent(request.idempotencyKey)}`,
  ...(input.method==='POST'?{body:request}:{}),isCurrent:input.isCurrent,timeoutMs:LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
  observe:async(status,raw)=>{
   if(status>=200&&status<300){
    const receipt=input.method==='POST'?FreeBasePurchaseReceiptSchema.parse(raw):FreeBasePurchaseReceiptEnvelopeSchema.parse(raw).receipt;
    const proof:FreeBasePurchaseProof=receipt?{status:'accepted',receipt}:{status:'unknown',receipt:null};
    await input.retain(proof);return proof;
   }
   if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length!==1||!('error' in raw)) throw new Error('Invalid purchase error envelope');
   const error=(raw as {error?:{code?:unknown;message?:unknown}}).error;
   if(!error||typeof error!=='object'||Array.isArray(error)||Object.keys(error).some(k=>!['code','message'].includes(k))
     ||typeof error.code!=='string'||typeof error.message!=='string'||!error.message)throw new Error('Invalid purchase refusal');
   if(input.method==='POST'&&input.firstAttempt&&typeof error?.code==='string'&&typeof error.message==='string'
     &&freeBasePurchaseRefusalDefinitive(status,error.code))await input.refusal({status,code:error.code});
   return undefined;
  }});
}

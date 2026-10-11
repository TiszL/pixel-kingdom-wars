/** Exact original-response ownership. The controller's mandatory retain callback
 * validates saved evidence before any view guard. No retries or terminal policy. */
import {LAND_CHECKOUT_RECOVERY} from '@shardkeep/shared';
import {RealmSalePrepareRequestSchema,RealmSalePreparationEnvelopeSchema,RealmSalePreparationSchema,type RealmSalePrepareRequest,type RealmSalePreparationView} from '@shardkeep/shared/realmSalesApi';
import {validateRealmSaleReview} from '@shardkeep/shared/realmSaleReviewApi';
import {RealmSaleFailureEnvelopeSchema} from '@shardkeep/shared/realmSaleFailureApi';
import {requestRealmSaleOriginal} from '../api';
import {realmSalePrepareRefusalResponse,type RealmSalePrepareRefusal} from './refusal';
type Current={isCurrent:()=>boolean};
type Retain={retain:(raw:unknown)=>Promise<void>};
const timeoutMs=LAND_CHECKOUT_RECOVERY.requestTimeoutMs;
function own(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid original realm sale request.');const keys=Reflect.ownKeys(value);
 if(!required.every(k=>Object.hasOwn(value,k))||!keys.every(k=>typeof k==='string'&&[...required,...optional].includes(k)))throw Error('Invalid original realm sale fields.');return value as Record<string,unknown>;
}
function options(input:unknown,fields:string[],retain=true,optional:string[]=[]){const o=own(input,fields,optional);if(typeof o.isCurrent!=='function'||retain&&typeof o.retain!=='function')throw Error('Original realm sale evidence owner is required.');}
function id(value:unknown){return RealmSalePrepareRequestSchema.shape.idempotencyKey.parse(value);}
function signedRequest(value:unknown):{idempotencyKey:string;signedTransaction:string}{
 const v=own(value,['idempotencyKey','signedTransaction']),idempotencyKey=id(v.idempotencyKey),text=v.signedTransaction;
 if(typeof text!=='string'||text.length<88||text.length>1644||text.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text))throw Error('Invalid original signed transaction encoding.');
 const bytes=atob(text);if(bytes.length<66||bytes.length>1232||btoa(bytes)!==text)throw Error('Noncanonical original signed transaction encoding.');return {idempotencyKey,signedTransaction:text};
}
function savedEnvelope(raw:unknown,key:string,submit:boolean){
 const r=own(raw,submit?['wallet','idempotencyKey','wire','settlement','delivery']:['wallet','idempotencyKey','preparation','wire','settlement'],submit?['reason','reconciliation']:[]);
 if(typeof r.wallet!=='string'||r.wallet.length<32||r.wallet.length>44||!/^[1-9A-HJ-NP-Za-km-z]+$/.test(r.wallet)||id(r.idempotencyKey)!==key)throw Error('Saved realm sale belongs to another original request.');
 if(submit&&!['held','submitted','settled'].includes(r.delivery as string))throw Error('Invalid original delivery response.');
 // Do not inspect nested proof before retention: an unparsed positive settlement
 // must reach the controller's hold latch even when the wire is malformed.
 return raw;
}
export async function prepareRealmSaleOriginal(input:Current&Retain&{request:RealmSalePrepareRequest;method:'GET'|'POST';refusal?:(value:RealmSalePrepareRefusal)=>Promise<void>}):Promise<unknown>{
 options(input,['request','method','isCurrent','retain'],true,['refusal']);if(input.refusal!==undefined&&typeof input.refusal!=='function')throw Error('Invalid refusal evidence owner.');if(input.method!=='GET'&&input.method!=='POST')throw Error('Invalid original preparation method.');
 const request=RealmSalePrepareRequestSchema.parse(input.request),{method,isCurrent,retain,refusal}=input;
 return requestRealmSaleOriginal({method,path:method==='POST'?'/seeker/realm-sales/prepare':`/seeker/realm-sales/prepare/by-key/${request.idempotencyKey}`,...(method==='POST'?{body:request}:{}),isCurrent,timeoutMs,
  observe:async(status,raw)=>{if(status<200||status>=300){const value=method==='POST'?realmSalePrepareRefusalResponse(status,raw):null;if(value)await refusal?.(value);return undefined;}const value=RealmSalePreparationEnvelopeSchema.parse(raw);
   if(value.idempotencyKey!==request.idempotencyKey||value.preparation&&(value.preparation.spot!==request.spot||value.preparation.realm!==request.realm))throw Error('Preparation differs from the original realm or spot.');
   if(method==='POST'&&value.preparation===null)throw Error('Preparation response has no original consent.');await retain(value);return value;
  }});
}
export async function savedRealmSaleOriginal(input:Current&Retain&{idempotencyKey:string}):Promise<unknown>{
 options(input,['idempotencyKey','isCurrent','retain']);const key=id(input.idempotencyKey),{isCurrent,retain}=input;
 return requestRealmSaleOriginal({method:'GET',path:`/seeker/realm-sales/by-key/${key}`,isCurrent,timeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;const value=savedEnvelope(raw,key,false);await retain(value);return value;
 }});
}
/** Own the outer identity before retention, but leave nested positive evidence
 * untouched so its original controller can hold it before strict parsing. */
export async function failedRealmSaleOriginal(input:Current&Retain&{idempotencyKey:string}):Promise<unknown>{
 options(input,['idempotencyKey','isCurrent','retain']);const key=id(input.idempotencyKey),{isCurrent,retain}=input;
 return requestRealmSaleOriginal({method:'GET',path:`/seeker/realm-sales/failures/by-key/${key}`,isCurrent,timeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;const value=own(raw,['wallet','idempotencyKey','failure']);RealmSalePreparationSchema.shape.wallet.parse(value.wallet);
  if(id(value.idempotencyKey)!==key)throw Error('Failure belongs to another original request.');
  // The mandatory owner binds the outer wallet to its captured journal before
  // latching. This transport never learns wallet identity from a current view.
  await retain(value);return RealmSaleFailureEnvelopeSchema.parse(value);
 }});
}
export async function reviewRealmSaleOriginal(input:Current&{preparation:RealmSalePreparationView}):Promise<ReturnType<typeof validateRealmSaleReview>>{
 options(input,['preparation','isCurrent'],false);const preparation=RealmSalePreparationSchema.parse(input.preparation),{isCurrent}=input;
 return requestRealmSaleOriginal({method:'GET',path:`/seeker/realm-sales/review/by-key/${preparation.idempotencyKey}`,isCurrent,timeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;return validateRealmSaleReview(preparation,raw);
 }});
}
/** The controller durably marks its single submit attempt before this call.
 * An acknowledgment remains raw recovery data, never proof of successful payment. */
export async function submitRealmSaleOriginal(input:Current&Retain&{request:{idempotencyKey:string;signedTransaction:string}}):Promise<unknown>{
 options(input,['request','isCurrent','retain']);const request=signedRequest(input.request),{isCurrent,retain}=input;
 return requestRealmSaleOriginal({method:'POST',path:'/seeker/realm-sales/submit',body:request,isCurrent,timeoutMs,observe:async(status,raw)=>{
  if(status<200||status>=300)return undefined;const value=savedEnvelope(raw,request.idempotencyKey,true);await retain(value);return value;
 }});
}

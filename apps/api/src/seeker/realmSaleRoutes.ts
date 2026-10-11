/** Authenticated original sale consent, optional bounded relay and historical recovery. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {TWOFA} from '@shardkeep/shared';
import type {Db} from '../db/client';
import {phaseESeekerEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {createRealmSalePreparer,realmSalePreparationRequestSchema,RealmSalePreparationError,type RealmSalePreparationSources} from './realmSalePreparation';
import {getRealmSalePreparation,RealmSalePreparationStoreError} from './realmSalePreparationStore';
import {acceptRealmSaleSigned,getRealmSaleSigned,RealmSaleSignedStoreError} from './realmSaleSignedStore';
import {getRealmSaleSettlement} from './realmSaleSettlement';
import {createRealmSaleReconciler,type RealmSaleRelaySources} from './realmSaleReconcile';
import {registerRealmSaleReviewRoutes} from './realmSaleReviewRoutes';
import {registerRealmSaleOfferRoutes} from './realmSaleOfferRoutes';
import {registerRealmSaleFailureRoutes} from './realmSaleFailureRoutes';
import {getRealmSaleFailure} from './realmSaleFailure';
function refused(error:unknown):never{
 if(error instanceof RealmSaleSignedStoreError){
  if(error.code==='INVALID_INPUT')throw new HttpError(400,'Invalid signed realm access request','INVALID_INPUT');
  if(error.code==='INVALID_WIRE')throw new HttpError(422,'The signature does not match the saved purchase','PAYMENT_INSTRUCTIONS_REJECTED');
  if(error.code==='NOT_FOUND')throw new HttpError(404,'No purchase belongs to this wallet','REALM_SALE_UNKNOWN');
  if(error.code==='SIGNED_CONFLICT')throw new HttpError(409,'The original signed request is already retained','REALM_SALE_SIGNED_CONFLICT');
 }

 if(error instanceof RealmSalePreparationError||error instanceof RealmSalePreparationStoreError){
  if(error.code==='INVALID_INPUT')throw new HttpError(400,'Invalid realm access request','INVALID_INPUT');
  if(error.code==='REQUEST_CONFLICT')throw new HttpError(409,'The saved request has different realm or spot details','REALM_SALE_REQUEST_CONFLICT');
  if(error.code==='DISABLED')throw new HttpError(503,'Realm access purchases are paused','PHASE_E_DISABLED');
  // These named quote failures precede artifact creation and persistence. They
  // extend only the exact initial unsigned refusal contract, never a signed
  // delivery or ambiguous storage/timeout response.
  if(error instanceof RealmSalePreparationError&&error.code==='QUOTE_UNAVAILABLE'){
   if(error.reason==='INSUFFICIENT_SOL')throw new HttpError(422,'SOL is required for this purchase and transaction costs','INSUFFICIENT_SOL');
   if(error.reason==='NO_QUOTA')throw new HttpError(422,'This spot has no purchase quota remaining for the current day','REALM_SALE_NO_QUOTA');
   if(error.reason==='UNSOLD')throw new HttpError(422,'This spot has no seller for the current term','REALM_SALE_UNSOLD');
   if(error.reason==='REALM')throw new HttpError(422,'This spot does not sell access to the selected realm','REALM_SALE_REALM_UNAVAILABLE');
  }
 }
 throw new HttpError(503,'Realm access preparation is unavailable; check the saved request','REALM_SALE_UNAVAILABLE');
}
export function registerRealmSaleRoutes(app:FastifyInstance,db:Db,sources?:RealmSalePreparationSources|null,relaySources?:RealmSaleRelaySources|null){
 registerRealmSaleFailureRoutes(app,db);
 registerRealmSaleReviewRoutes(app,db,sources??relaySources?.admission);
 registerRealmSaleOfferRoutes(app,sources??relaySources?.admission);
 const prepare=sources?createRealmSalePreparer(db,sources):null;
 const reconcile=relaySources?createRealmSaleReconciler(db,relaySources):null;
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 app.post('/seeker/realm-sales/prepare',{...auth,bodyLimit:1024,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},async(req,reply)=>{
  parse(z.object({}).strict(),req.query);const input=parse(realmSalePreparationRequestSchema,req.body);
  try{
   const prior=await getRealmSalePreparation(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey});
   if(prior){if(prior.spot!==input.spot||prior.realm!==input.realm)throw new RealmSalePreparationStoreError('REQUEST_CONFLICT');return reply.code(201).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,preparation:prior});}
   if(!phaseESeekerEnabled())throw new RealmSalePreparationError('DISABLED');
   if(!prepare)throw new HttpError(503,'Realm access preparation is unavailable','REALM_SALE_UNAVAILABLE');
   return reply.code(201).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,preparation:await prepare.prepare(req.wallet,input)});
  }catch(error){refused(error);}
 });
 app.get('/seeker/realm-sales/prepare/by-key/:key',auth,async req=>{
  const {key}=parse(z.object({key:z.uuid().transform(v=>v.toLowerCase())}).strict(),req.params);parse(z.object({}).strict(),req.query);
  try{return {wallet:req.wallet,idempotencyKey:key,preparation:await getRealmSalePreparation(db,{wallet:req.wallet,idempotencyKey:key})};}catch(error){refused(error);}
 });
 // Retention is allowed while paused or offline. Optional delivery refreshes
 // admission for the original wire; HTTP never receives a finality writer.
 app.post('/seeker/realm-sales/submit',{...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},async(req,reply)=>{
  parse(z.object({}).strict(),req.query);
  const input=parse(z.object({idempotencyKey:z.uuid().transform(v=>v.toLowerCase()),signedTransaction:z.string().min(88).max(1644).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)}).strict(),req.body);
  const bytes=Buffer.from(input.signedTransaction,'base64');if(bytes.toString('base64')!==input.signedTransaction)throw new HttpError(400,'Invalid signed transaction encoding','INVALID_INPUT');
  try{const wire=await acceptRealmSaleSigned(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey,signedTransaction:bytes});
   // The original wire is already committed. A failed historical receipt read
   // must retain that identity rather than suggest submission was rejected.
   let settlement;try{
    const failure=await getRealmSaleFailure(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey});
    if(failure)return reply.code(202).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,wire,settlement:null,delivery:'held',reason:'FINALIZED_FAILURE',...(reconcile?{reconciliation:{status:'held',wallet:req.wallet,idempotencyKey:input.idempotencyKey,signature:wire.signature,reason:'FINALIZED_FAILURE'}}:{})});
    settlement=await getRealmSaleSettlement(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey});
   }
   catch{return reply.code(202).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,wire,settlement:null,delivery:'held',reason:'SOURCE_UNAVAILABLE',...(reconcile?{reconciliation:{status:'held',wallet:req.wallet,idempotencyKey:input.idempotencyKey,signature:wire.signature,reason:'SOURCE_UNAVAILABLE'}}:{})});}
   if(settlement)return reply.code(200).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,wire,settlement,delivery:'settled',...(reconcile?{reconciliation:{status:'settled',wallet:req.wallet,idempotencyKey:input.idempotencyKey,signature:wire.signature,settlement}}:{})});
   if(reconcile){
    try{const result=await reconcile({wallet:req.wallet,idempotencyKey:input.idempotencyKey});
     return reply.code(result.status==='settled'?200:202).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,wire,settlement:result.status==='settled'?result.settlement:null,delivery:result.status,reconciliation:result,...(result.status==='held'?{reason:result.reason}:{})});
    }catch{return reply.code(202).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,wire,settlement:null,delivery:'held',reason:'SOURCE_UNAVAILABLE',reconciliation:{status:'held',wallet:req.wallet,idempotencyKey:input.idempotencyKey,signature:wire.signature,reason:'SOURCE_UNAVAILABLE'}});}
   }
   return reply.code(202).send({wallet:req.wallet,idempotencyKey:input.idempotencyKey,wire,settlement:null,delivery:'held',reason:'DELIVERY_UNAVAILABLE'});
  }catch(error){refused(error);}
 });
 app.get('/seeker/realm-sales/by-key/:key',auth,async req=>{
  const {key}=parse(z.object({key:z.uuid().transform(v=>v.toLowerCase())}).strict(),req.params);parse(z.object({}).strict(),req.query);
  try{const saved=await getRealmSaleSigned(db,{wallet:req.wallet,idempotencyKey:key});const settlement=await getRealmSaleSettlement(db,{wallet:req.wallet,idempotencyKey:key});return {wallet:req.wallet,idempotencyKey:key,preparation:saved?.preparation??null,wire:saved?.wire??null,settlement};}catch(error){refused(error);}
 });

}

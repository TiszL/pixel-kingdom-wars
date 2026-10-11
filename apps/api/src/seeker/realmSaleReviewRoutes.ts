/** Current measured facts for reviewing an existing immutable purchase. This
 * read-only route cannot sign, relay, persist an outcome or renew consent. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {TWOFA} from '@shardkeep/shared';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {getRealmSalePreparation} from './realmSalePreparationStore';
import {getRealmSaleFailure} from './realmSaleFailure';
import {createRealmSaleAdmissionReader,RealmSaleAdmissionError,type RealmSaleAdmissionSources} from './realmSaleAdmission';
export function registerRealmSaleReviewRoutes(app:FastifyInstance,db:Db,sources?:RealmSaleAdmissionSources|null){
 const read=sources?createRealmSaleAdmissionReader(sources):null;
 app.get('/seeker/realm-sales/review/by-key/:key',{
  preHandler:[app.authenticate],config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}},
  onSend:async(_request,reply,payload)=>{reply.header('Cache-Control','private, no-store');return payload;},
 },async req=>{
  const {key}=parse(z.object({key:z.uuid().transform(v=>v.toLowerCase())}).strict(),req.params);parse(z.object({}).strict(),req.query);
  try{
   const p=await getRealmSalePreparation(db,{wallet:req.wallet,idempotencyKey:key});
   if(!p)throw new HttpError(404,'No purchase belongs to this wallet','REALM_SALE_UNKNOWN');
   const held=async()=>{if(await getRealmSaleFailure(db,{wallet:req.wallet,idempotencyKey:key}))throw new HttpError(409,'The original purchase failed; check its saved outcome','REALM_SALE_REVIEW_HELD');};
   await held();
   if(!read)throw new HttpError(503,'Current purchase review is unavailable; keep the saved request','REALM_SALE_REVIEW_UNAVAILABLE');
   const a=await read(p);
   await held();
   return {...a,idempotencyKey:key,validUntil:p.terms.validUntil,unixTimestamp:a.unixTimestamp.toString(),feeLamports:a.feeLamports.toString(),rentLamports:a.rentLamports.toString(),paymentDebitLamports:a.paymentDebitLamports.toString(),requiredLamports:a.requiredLamports.toString(),payerLamports:a.payerLamports.toString(),rents:a.rents.map(r=>({address:r.address,lamports:r.lamports.toString()}))};
  }catch(error){
   if(error instanceof HttpError)throw error;
   if(error instanceof RealmSaleAdmissionError){
    if(error.code==='DISABLED')throw new HttpError(503,'Realm purchases are paused; keep the saved request','PHASE_E_DISABLED');
    if(['RECOVERY_REQUIRED','CONSENT_CHANGED','COST_EXCEEDED','BLOCKHASH_EXPIRED','QUOTE_UNAVAILABLE'].includes(error.code))throw new HttpError(409,'The original purchase cannot be approved now; check its saved outcome','REALM_SALE_REVIEW_HELD');
   }
   throw new HttpError(503,'Current purchase review is unavailable; keep the saved request','REALM_SALE_REVIEW_UNAVAILABLE');
  }
 });
}

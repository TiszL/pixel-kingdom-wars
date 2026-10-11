/** Read-only current review of original consent. No signature persistence,
 * relay, owner receipt writer, replacement quote or expiry extension. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {TWOFA} from '@shardkeep/shared';
import {MiningTaxClaimReviewResponseSchema,MiningTaxClaimReviewReasonSchema,validateMiningTaxClaimCurrentReview,type MiningTaxClaimReviewReason} from '@shardkeep/shared/miningTaxClaimReviewApi';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {parse} from '../lib/validation';
import {getMiningTaxClaimPreparation} from './taxClaimPreparationStore';
import {createMiningTaxClaimReview,MiningTaxClaimReviewError,type MiningTaxClaimReviewSources} from './taxClaimReview';
const params=z.object({key:z.uuid().refine(v=>v===v.toLowerCase()),ordinal:z.enum(['0','1']).transform(Number)}).strict(),empty=z.object({}).strict();
export function registerMiningTaxClaimReviewRoutes(app:FastifyInstance,db:Db,sources?:MiningTaxClaimReviewSources|null){
 const read=sources?createMiningTaxClaimReview(db,sources):null,now=sources?.now??(()=>new Date());
 function clock():string|null{
  try{const value=now();if(!(value instanceof Date)||!Number.isFinite(+value))return null;const stamp=new Date(+value).toISOString();return MiningTaxClaimReviewResponseSchema.shape.serverNow.safeParse(stamp).success?stamp:null;}catch{return null;}
 }
 app.get('/claims/mining-tax/review/by-key/:key/:ordinal',{
  preHandler:[app.authenticate],config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}},
  onSend:async(_request,reply,payload)=>{reply.header('Cache-Control','private, no-store');return payload;},
 },async req=>{
  const {key,ordinal}=parse(params,req.params);parse(empty,req.query);const identity={wallet:req.wallet,idempotencyKey:key,ordinal};
  // An invalid injected clock can never produce a ready reply. A fallback wall
  // timestamp merely dates an unavailable response; it grants no freshness.
  const unavailable=(reason:MiningTaxClaimReviewReason)=>MiningTaxClaimReviewResponseSchema.parse({...identity,status:'unavailable',review:null,reason,serverNow:clock()??new Date().toISOString()});
  try{
   const preparation=await getMiningTaxClaimPreparation(db,{wallet:req.wallet,idempotencyKey:key});
   if(!preparation||!preparation.transactions[ordinal])return unavailable('NOT_PREPARED');
   if(!phaseEMiningEnabled())return unavailable('DISABLED');if(!read)return unavailable('PROVIDER_UNAVAILABLE');
   const review=await read(identity),serverNow=clock();
   if(!phaseEMiningEnabled())return unavailable('DISABLED');if(!serverNow)return unavailable('SOURCE_CONFLICT');
   return validateMiningTaxClaimCurrentReview(preparation,{...identity,status:'ready',review:{...review,
    feeLamports:review.feeLamports.toString(),rentLamports:review.rentLamports.toString(),totalLamports:review.totalLamports.toString(),paidFeeLamports:review.paidFeeLamports.toString(),paidRentLamports:review.paidRentLamports.toString()},serverNow});
  }catch(error){
   const reason=error instanceof MiningTaxClaimReviewError?MiningTaxClaimReviewReasonSchema.safeParse(error.code):null;
   return unavailable(reason?.success?reason.data:'SOURCE_CONFLICT');
  }
 });
}

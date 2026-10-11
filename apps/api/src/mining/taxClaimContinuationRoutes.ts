/** Explicit additional unsigned consent; recovery remains available while paused.
 * No public receipt/failure writer or client signing authority is introduced. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {TWOFA} from '@shardkeep/shared';
import {MiningTaxClaimContinuationRequestSchema,MiningTaxClaimContinuationEnvelopeSchema,type MiningTaxClaimContinuation,type MiningTaxClaimContinuationRequest} from '@shardkeep/shared/miningTaxClaimContinuationApi';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {MiningTaxClaimPreparationSources} from './taxClaimPreparation';
import {createMiningTaxClaimContinuation,getMiningTaxClaimContinuation,MiningTaxClaimContinuationError} from './taxClaimContinuation';
const params=z.object({key:z.uuid().refine(v=>v===v.toLowerCase())}).strict(),empty=z.object({}).strict();
function refused(error:unknown):never{
 if(error instanceof MiningTaxClaimContinuationError){
  if(error.code==='INVALID_INPUT')throw new HttpError(400,'Invalid KEEP tax continuation request','INVALID_INPUT');
  if(error.code==='NOT_PREPARED')throw new HttpError(404,'No claim belongs to this wallet','MINING_TAX_UNKNOWN');
  if(error.code==='DISABLED')throw new HttpError(503,'Mining claims are paused','PHASE_E_DISABLED');
  if(['REQUEST_CONFLICT','SETUP_REQUIRED','PARENT_SIGNED','NOT_EXPIRED','CLAIM_BLOCKHASH_REUSED'].includes(error.code))throw new HttpError(409,'The saved claim cannot continue with this request',`MINING_TAX_${error.code}`);
 }
 throw new HttpError(503,'KEEP tax claim recovery is unavailable; keep the saved request','MINING_TAX_UNAVAILABLE');
}
function matches(saved:MiningTaxClaimContinuation,input:MiningTaxClaimContinuationRequest){return saved.childPreparation.idempotencyKey===input.idempotencyKey&&(['maxFeeLamports','maxRentLamports','maxTotalLamports'] as const).every(k=>saved.childPreparation.caps[k]===input.caps[k]);}
export function registerMiningTaxClaimContinuationRoutes(app:FastifyInstance,db:Db,sources?:MiningTaxClaimPreparationSources|null){
 const continueClaim=sources?createMiningTaxClaimContinuation(db,sources):null;
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const envelope=(wallet:string,parentIdempotencyKey:string,continuation:MiningTaxClaimContinuation|null)=>MiningTaxClaimContinuationEnvelopeSchema.parse({wallet,parentIdempotencyKey,status:continuation?'continued':'unknown',continuation,serverNow:new Date().toISOString()});
 app.get('/claims/mining-tax/continuations/by-key/:key',auth,async req=>{
  const {key}=parse(params,req.params);parse(empty,req.query);
  try{return envelope(req.wallet,key,await getMiningTaxClaimContinuation(db,{wallet:req.wallet,idempotencyKey:key}));}catch(error){refused(error);}
 });
 app.post('/claims/mining-tax/continue/:key',{...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},async(req,reply)=>{
  const {key}=parse(params,req.params);parse(empty,req.query);const input=parse(MiningTaxClaimContinuationRequestSchema,req.body);
  try{
   if(input.idempotencyKey===key)throw new MiningTaxClaimContinuationError('INVALID_INPUT');
   const saved=await getMiningTaxClaimContinuation(db,{wallet:req.wallet,idempotencyKey:key});
   if(saved){if(!matches(saved,input))throw new MiningTaxClaimContinuationError('REQUEST_CONFLICT');return reply.code(201).send(envelope(req.wallet,key,saved));}
   if(!phaseEMiningEnabled())throw new MiningTaxClaimContinuationError('DISABLED');
   if(!continueClaim)throw new MiningTaxClaimContinuationError('STORAGE_UNAVAILABLE');
   return reply.code(201).send(envelope(req.wallet,key,await continueClaim.prepare(req.wallet,key,input)));
  }catch(error){refused(error);}
 });
}

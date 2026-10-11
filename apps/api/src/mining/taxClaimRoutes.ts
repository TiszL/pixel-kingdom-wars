/** Authenticated immutable tax consent and recovery. Public runtime connections
 * retain exact signatures and read receipts; no owner finality writer is wired. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {TWOFA} from '@shardkeep/shared';
import {MiningTaxClaimPrepareRequestSchema,MiningTaxClaimPreparationEnvelopeSchema} from '@shardkeep/shared/miningTaxClaimsApi';
import {MiningTaxClaimSubmitRequestSchema,MiningTaxClaimSubmitResponseSchema,validateMiningTaxClaimRecoveryEnvelope} from '@shardkeep/shared/miningTaxClaimRecoveryApi';
import type {Db} from '../db/client';
import {phaseEMiningEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {createMiningTaxClaimPreparer,MiningTaxClaimPreparationError,type MiningTaxClaimPreparationSources} from './taxClaimPreparation';
import {getMiningTaxClaimPreparation,MiningTaxClaimPreparationStoreError} from './taxClaimPreparationStore';
import {acceptMiningTaxClaimSigned,getMiningTaxClaimSigned,MiningTaxClaimSignedStoreError} from './taxClaimSignedStore';
import {getMiningTaxClaimSettlement} from './taxClaimSettlement';
import {getMiningTaxClaimFailure} from './taxClaimFailure';
import {hasMiningTaxClaimContinuation} from './taxClaimContinuation';
import {createMiningTaxClaimReconciler,type MiningTaxClaimRelaySources} from './taxClaimReconcile';
import {registerMiningTaxClaimReviewRoutes} from './taxClaimReviewRoutes';
import {registerMiningTaxClaimFailureRoutes} from './taxClaimFailureRoutes';
import {registerMiningTaxClaimContinuationRoutes} from './taxClaimContinuationRoutes';
function refused(error:unknown):never{
 if(error instanceof MiningTaxClaimPreparationError||error instanceof MiningTaxClaimPreparationStoreError){
  if(error.code==='INVALID_INPUT')throw new HttpError(400,'Invalid KEEP tax claim request','INVALID_INPUT');
  if(error.code==='REQUEST_CONFLICT')throw new HttpError(409,'The saved claim has different term, spot or cost limits','MINING_TAX_REQUEST_CONFLICT');
  if(error.code==='CLAIM_BLOCKHASH_REUSED')throw new HttpError(409,'A newly observed blockhash is required before preparing again','CLAIM_BLOCKHASH_REUSED');
  if(error.code==='DISABLED')throw new HttpError(503,'Mining claims are paused','PHASE_E_DISABLED');
  if(error instanceof MiningTaxClaimPreparationError&&error.reason==='INSUFFICIENT_SOL')throw new HttpError(422,'SOL is required for claim fees and account rent','INSUFFICIENT_SOL');
 }
 if(error instanceof MiningTaxClaimSignedStoreError){
  if(error.code==='INVALID_INPUT')throw new HttpError(400,'Invalid signed claim request','INVALID_INPUT');
  if(error.code==='INVALID_WIRE')throw new HttpError(422,'The signature does not match the saved claim','PAYMENT_INSTRUCTIONS_REJECTED');
  if(error.code==='NOT_FOUND')throw new HttpError(404,'No claim belongs to this wallet','MINING_TAX_UNKNOWN');
  if(error.code==='SIGNED_CONFLICT')throw new HttpError(409,'A signed packet already belongs to this claim','MINING_TAX_SIGNED_CONFLICT');
 }
 throw new HttpError(503,'KEEP tax claim recovery is unavailable; keep the saved request','MINING_TAX_UNAVAILABLE');
}
const keySchema=z.object({key:z.uuid().refine(v=>v===v.toLowerCase())}).strict(),empty=z.object({}).strict();
export function registerMiningTaxClaimRoutes(app:FastifyInstance,db:Db,sources?:MiningTaxClaimPreparationSources|null,relaySources?:MiningTaxClaimRelaySources|null){
 registerMiningTaxClaimReviewRoutes(app,db,sources??relaySources?.admission);
 registerMiningTaxClaimFailureRoutes(app,db);
 registerMiningTaxClaimContinuationRoutes(app,db,sources);
 const prepare=sources?createMiningTaxClaimPreparer(db,sources):null,reconcile=relaySources?createMiningTaxClaimReconciler(db,relaySources):null;
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 async function latest(wallet:string,idempotencyKey:string){return await getMiningTaxClaimSettlement(db,{wallet,idempotencyKey,ordinal:1})??await getMiningTaxClaimSettlement(db,{wallet,idempotencyKey,ordinal:0});}
 app.post('/claims/mining-tax/prepare',post,async(req,reply)=>{
  parse(empty,req.query);const input=parse(MiningTaxClaimPrepareRequestSchema,req.body);
  try{
   const old=await getMiningTaxClaimPreparation(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey});
   if(old){if(old.round!==input.round||old.spot!==input.spot||(['maxFeeLamports','maxRentLamports','maxTotalLamports'] as const).some(k=>old.caps[k]!==input.caps[k]))throw new MiningTaxClaimPreparationStoreError('REQUEST_CONFLICT');
    return reply.code(201).send(MiningTaxClaimPreparationEnvelopeSchema.parse({wallet:req.wallet,idempotencyKey:input.idempotencyKey,status:'prepared',preparation:old,serverNow:new Date().toISOString()}));}
   if(!phaseEMiningEnabled())throw new MiningTaxClaimPreparationError('DISABLED');if(!prepare)throw new MiningTaxClaimPreparationError('QUOTE_UNAVAILABLE');
   const preparation=await prepare.prepare(req.wallet,input);return reply.code(201).send(MiningTaxClaimPreparationEnvelopeSchema.parse({wallet:req.wallet,idempotencyKey:input.idempotencyKey,status:'prepared',preparation,serverNow:new Date().toISOString()}));
  }catch(error){refused(error);}
 });
 app.get('/claims/mining-tax/prepare/by-key/:key',auth,async req=>{
  const {key}=parse(keySchema,req.params);parse(empty,req.query);
  try{const preparation=await getMiningTaxClaimPreparation(db,{wallet:req.wallet,idempotencyKey:key});return MiningTaxClaimPreparationEnvelopeSchema.parse({wallet:req.wallet,idempotencyKey:key,status:preparation?'prepared':'unknown',preparation,serverNow:new Date().toISOString()});}catch(error){refused(error);}
 });
 app.post('/claims/mining-tax/submit',post,async(req,reply)=>{
  parse(empty,req.query);const input=parse(MiningTaxClaimSubmitRequestSchema,req.body),bytes=Buffer.from(input.signedTransaction,'base64');if(bytes.toString('base64')!==input.signedTransaction)throw new HttpError(400,'Invalid signed transaction encoding','INVALID_INPUT');
  let wire;try{wire=await acceptMiningTaxClaimSigned(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey,signedTransaction:bytes});}catch(error){
   if(error instanceof MiningTaxClaimSignedStoreError&&['INVALID_INPUT','INVALID_WIRE','NOT_FOUND','SIGNED_CONFLICT'].includes(error.code))refused(error);
   // The failed await may precede or follow INSERT/COMMIT. No accepted time or
   // durable wire is invented; the client's saved signature and key stay held.
   return reply.code(202).send(MiningTaxClaimSubmitResponseSchema.parse({wallet:req.wallet,idempotencyKey:input.idempotencyKey,claimId:null,wire:null,delivery:'held',reason:'STORAGE_UNCERTAIN',serverNow:new Date().toISOString()}));
  }
  // Any later failure follows a committed signature. Preserve its identity and
  // return a held acknowledgement, never a rejection or proof of nonpayment.
  const ack=(delivery:'held'|'submitted'|'setup'|'settled',reason?:string)=>MiningTaxClaimSubmitResponseSchema.parse({wallet:req.wallet,idempotencyKey:input.idempotencyKey,claimId:wire.claimId,wire,delivery,...(reason?{reason}:{}),serverNow:new Date().toISOString()});
  try{
   if(await hasMiningTaxClaimContinuation(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey}))return reply.code(202).send(ack('held','CONTINUED'));
   const failure=await getMiningTaxClaimFailure(db,{wallet:req.wallet,idempotencyKey:input.idempotencyKey,ordinal:wire.ordinal});
   if(failure)return reply.code(202).send(ack('held','CLAIM_FAILED_CHECK_RECEIPT'));
   const saved=await latest(req.wallet,input.idempotencyKey);if(saved&&(saved.claimFinalized||saved.ordinal===wire.ordinal))return reply.code(saved.claimFinalized?200:202).send(ack(saved.claimFinalized?'settled':'setup'));
   if(!reconcile)return reply.code(202).send(ack('held','DELIVERY_UNAVAILABLE'));
   const result=await reconcile({wallet:req.wallet,idempotencyKey:input.idempotencyKey,ordinal:wire.ordinal});return reply.code(result.status==='settled'?200:202).send(ack(result.status,result.status==='held'?result.reason:undefined));
  }catch{return reply.code(202).send(ack('held','SOURCE_UNAVAILABLE'));}
 });
 app.get('/claims/mining-tax/by-key/:key',auth,async req=>{
  const {key}=parse(keySchema,req.params);parse(empty,req.query);
  try{const saved=await getMiningTaxClaimSigned(db,{wallet:req.wallet,idempotencyKey:key}),settlement=await latest(req.wallet,key);
   return validateMiningTaxClaimRecoveryEnvelope({wallet:req.wallet,idempotencyKey:key,claimId:saved?.preparation.claimId??null,status:settlement?settlement.receipt.phase:saved?.wires.length?'signed':saved?'prepared':'unknown',preparation:saved?.preparation??null,wires:saved?.wires??[],settlement,serverNow:new Date().toISOString()});
  }catch(error){refused(error);}
 });
}

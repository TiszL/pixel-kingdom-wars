/** Authenticated ordinary contribution admission through an explicit closed
 * service. The request DB is never promoted into private source authority. */
import { TWOFA } from '@shardkeep/shared';
import { MiningContributionRequestSchema,MiningContributionViewQuerySchema,MiningContributionUuidSchema,matchMiningContributionEnvelope } from '@shardkeep/shared/miningContributionApi';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { multiBaseEnabled,phaseEMiningEnabled } from '../config';
import type { Db,DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { assertFreshLockedBaseAuthority,requireFreshBaseAuthority } from './baseOwnership';
import { readMiningContribution,reserveMiningContribution } from './miningContributions';
import { readMiningContributionView } from './miningContributionView';
import type { WorkshopRouteDeps } from './workshopRoutes';

export function createMiningContributionProvider(db:Db,deps:WorkshopRouteDeps={}){
 if('rollback' in db)throw Error('Mining contribution service requires a top-level connection');
 const reader=deps.market?.finalizedDeedReader??null,collection=deps.market?.deedCollection??null;
 const authority=(baseId:string)=>({baseId,assertAuthority:async(tx:DbTx,wallet:string,id:string)=>{await assertFreshLockedBaseAuthority(tx,wallet,id);}});
 const prefetch=async(wallet:string,baseId:string)=>{
  if(!multiBaseEnabled())throw new HttpError(409,'Mining contributions require an explicit stable base','BASE_ID_REQUIRED');
  await requireFreshBaseAuthority(db,wallet,baseId,reader,collection);
 };
 const mismatch=(error:unknown):never=>{
  if(error instanceof Error&&error.message==='Mining receipt differs from original command')throw new HttpError(409,'Commitment key belongs to another original command','IDEMPOTENCY_BODY_MISMATCH');
  throw error;
 };
 return Object.freeze({
  async view(wallet:string,baseId:string,catalogueVersion:2|3=2){
   MiningContributionUuidSchema.parse(baseId);await prefetch(wallet,baseId);
   return readMiningContributionView(db,wallet,authority(baseId),undefined,catalogueVersion);
  },
  async reserve(wallet:string,input:unknown){
   const body=MiningContributionRequestSchema.parse(input),original=await readMiningContribution(db,wallet,body.idempotencyKey);
   if(original.status==='accepted'){
    try{return {created:false,receipt:matchMiningContributionEnvelope(original,wallet,body)};}catch(error){return mismatch(error);}
   }
   if(!phaseEMiningEnabled())throw new HttpError(503,'Mining commitments are paused','PHASE_E_DISABLED');
   await prefetch(wallet,body.baseId);
   try{return {created:true,receipt:await reserveMiningContribution(db,wallet,body,authority(body.baseId))};}catch(error){return mismatch(error);}
  },
  read:(wallet:string,key:string)=>readMiningContribution(db,wallet,MiningContributionUuidSchema.parse(key)),
 });
}
export type MiningContributionProvider=ReturnType<typeof createMiningContributionProvider>;
export function registerMiningContributionRoutes(app:FastifyInstance,provider?:MiningContributionProvider|null):void{
 const use=()=>{if(!provider)throw new HttpError(503,'Mining contribution history is unavailable; keep the original request','MINING_CONTRIBUTION_SOURCE_UNAVAILABLE');return provider;};
 const noStore=async(_req:unknown,reply:{header:(key:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;};
 const authenticated={preHandler:[app.authenticate],onSend:noStore};
 app.get('/mining/contributions',authenticated,async req=>{
  const {baseId,catalogueVersion}=parse(MiningContributionViewQuerySchema,req.query??{});
  return use().view(req.wallet,baseId,catalogueVersion==='3'?3:2);
 });
 app.post('/mining/contributions',{...authenticated,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},async(req,reply)=>{
  const body=parse(MiningContributionRequestSchema,req.body),result=await use().reserve(req.wallet,body);
  return reply.status(result.created?201:200).send(result.receipt);
 });
 app.get('/mining/contributions/by-key/:key',authenticated,async req=>{
  const {key}=parse(z.object({key:MiningContributionUuidSchema}).strict(),req.params);
  return use().read(req.wallet,key);
 });
}

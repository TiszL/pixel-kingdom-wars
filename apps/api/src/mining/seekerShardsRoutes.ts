/** Authenticated original SHARDS rights and funded delivery. Historical replay
 * stays available without today's feature flag, provider or destination custody. */
import {TWOFA} from '@shardkeep/shared';
import {SeekerShardsClaimRequestSchema,SeekerShardsEntitlementQuerySchema} from '@shardkeep/shared/seekerShardsClaimsApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {Db} from '../db/client';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority} from '../game/baseOwnership';
import type {WorkshopRouteDeps} from '../game/workshopRoutes';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {claimSeekerShardsTax,readSeekerShardsClaim,seekerShardsClaimsEnabled} from './seekerShardsClaims';
import {readSeekerShardsEntitlements} from './seekerShardsEntitlements';

const uuid=z.uuid().refine(v=>v===v.toLowerCase()),empty=z.object({}).strict();
const request=SeekerShardsClaimRequestSchema.extend({idempotencyKey:uuid,baseId:uuid,termId:uuid});
const query=SeekerShardsEntitlementQuerySchema.extend({cursor:uuid.optional()}),params=z.object({key:uuid}).strict();
function unavailable(error:unknown):never{if(error instanceof HttpError)throw error;throw new HttpError(503,'Original SHARDS claim evidence is unavailable; keep the original request','SEEKER_SHARDS_UNAVAILABLE');}

export function registerSeekerShardsRoutes(app:FastifyInstance,db:Db,deps:WorkshopRouteDeps={}):void{
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 app.get('/seeker/shards/entitlements',auth,async req=>{
  const input=parse(query,req.query);
  try{return await readSeekerShardsEntitlements(db,req.wallet,input);}catch(error){unavailable(error);}
 });
 app.get('/seeker/shards/claims/by-key/:key',auth,async req=>{
  const {key}=parse(params,req.params);parse(empty,req.query);
  try{return {wallet:req.wallet,receipt:await readSeekerShardsClaim(db,req.wallet,key)};}catch(error){unavailable(error);}
 });
 app.post('/seeker/shards/claims',{...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60000}}},async(req,reply)=>{
  const body=parse(request,req.body);parse(empty,req.query);
  try{
   const prior=await readSeekerShardsClaim(db,req.wallet,body.idempotencyKey);
   if(!prior){
    if(!seekerShardsClaimsEnabled())throw new HttpError(503,'SHARDS tax claims are paused','PHASE_E_DISABLED');
    await requireFreshBaseAuthority(db,req.wallet,body.baseId,deps.market?.finalizedDeedReader??null,deps.market?.deedCollection??null);
   }
   const receipt=await claimSeekerShardsTax(db,req.wallet,body,{baseId:body.baseId,assertAuthority:async(tx,wallet,baseId)=>{await assertFreshLockedBaseAuthority(tx,wallet,baseId);}});
   if(receipt.wallet!==req.wallet)throw new HttpError(404,'claim not found');
   return reply.code(prior?200:201).send({wallet:req.wallet,receipt});
  }catch(error){unavailable(error);}
 });
}

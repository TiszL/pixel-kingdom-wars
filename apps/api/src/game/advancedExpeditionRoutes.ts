/** Identifiers and original consent only; provider owns every private DB read. */
import {TWOFA} from '@shardkeep/shared';
import {AdvancedExpeditionRequestSchema} from '@shardkeep/shared/advancedExpeditionApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {AdvancedExpeditionWorkflowProvider} from './advancedExpeditionWorkflow';
const uuid=z.uuid().regex(/^[0-9a-f-]+$/),empty=z.object({}).strict(),params=z.object({key:uuid}).strict(),collect=z.object({baseId:uuid}).strict();
export function registerAdvancedExpeditionRoutes(app:FastifyInstance,provider?:AdvancedExpeditionWorkflowProvider|null){
 const service=provider?Object.freeze({dispatch:provider.dispatch.bind(provider),read:provider.read.bind(provider),collect:provider.collect.bind(provider),
  dispatchWithCreation:provider.dispatchWithCreation?.bind(provider)}):null;
 const requireService=()=>{if(!service)throw new HttpError(503,'Advanced expeditions are unavailable','ADVANCED_WORKFLOW_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.get('/advanced-expeditions/by-key/:key',auth,async req=>{const p=parse(params,req.params);parse(empty,req.query);return requireService().read(req.wallet,p.key);});
 app.post('/advanced-expeditions',post,async(req,reply)=>{
  const body=parse(AdvancedExpeditionRequestSchema,req.body);parse(empty,req.query);const current=requireService();
  // Legacy capabilities retain their response, without certifying fresh insertion.
  if(!current.dispatchWithCreation)return current.dispatch(req.wallet,body);
  const result=await current.dispatchWithCreation(req.wallet,body);
  if(result.created)reply.header('x-pkw-journey-created','1');
  return reply.status(result.created?201:200).send(result.envelope);
 });
 app.post('/advanced-expeditions/collect',post,async req=>{const body=parse(collect,req.body);parse(empty,req.query);return requireService().collect(req.wallet,body.baseId);});
}

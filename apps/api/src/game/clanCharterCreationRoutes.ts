/** Optional authenticated Charter adapter. No production registration or relay. */
import {TWOFA} from '@shardkeep/shared';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {CharterCreationRequestSchema,type CharterCreationWorkflowProvider} from './clanCharterCreationWorkflow';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),empty=z.object({}).strict(),params=z.object({id:uuid}).strict();
const signed=z.object({signedTransaction:z.string().min(88).max(1644).refine(v=>{const b=Buffer.from(v,'base64');return b.length>65&&b.length<=1232&&b.toString('base64')===v;})}).strict();
const refund=z.object({destinationBaseId:uuid.optional()}).strict();
export function registerCharterCreationRoutes(app:FastifyInstance,provider?:CharterCreationWorkflowProvider|null):void{
 const service=provider?Object.freeze({fund:provider.fund.bind(provider),read:provider.read.bind(provider),prepare:provider.prepare.bind(provider),
  recoverPreparation:provider.recoverPreparation.bind(provider),retainSigned:provider.retainSigned.bind(provider),recover:provider.recover.bind(provider),claimRefund:provider.claimRefund.bind(provider)}):null;
 const requireService=()=>{if(!service)throw new HttpError(503,'Charter workflow unavailable','CLAN_CHARTER_WORKFLOW_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 const path='/clans/charter/creations';
 app.post(path,post,async(req,reply)=>{parse(empty,req.query);const input=parse(CharterCreationRequestSchema,req.body);return reply.code(201).send(await requireService().fund(req.wallet,input));});
 app.get(path+'/:id',auth,async req=>{parse(empty,req.query);const p=parse(params,req.params);return requireService().read(req.wallet,p.id);});
 for(const [suffix,method] of [['prepare','prepare'],['recover-preparation','recoverPreparation'],['recover','recover']] as const)
  app.post(path+'/:id/'+suffix,post,async req=>{parse(empty,req.query);const p=parse(params,req.params);parse(empty,req.body??{});return requireService()[method](req.wallet,p.id);});
 app.post(path+'/:id/signed',post,async req=>{parse(empty,req.query);const p=parse(params,req.params),body=parse(signed,req.body);return requireService().retainSigned(req.wallet,p.id,Buffer.from(body.signedTransaction,'base64'));});
 app.post(path+'/:id/refund',post,async req=>{parse(empty,req.query);const p=parse(params,req.params),body=parse(refund,req.body??{});return requireService().claimRefund(req.wallet,p.id,body.destinationBaseId);});
}

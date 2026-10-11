/** Optional authenticated ordinary-sale adapter, deliberately not mounted. */
import {TWOFA} from '@shardkeep/shared';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {CharterSaleUuid,CharterSaleDraftSchema,CharterSaleAcceptanceSchema,type CharterSalesProvider} from './clanCharterSales';
const empty=z.object({}).strict(),params=z.object({id:CharterSaleUuid}).strict();
const signed=z.object({signedTransaction:z.string().min(176).max(1644).refine(v=>{const b=Buffer.from(v,'base64');return b.length>129&&b.length<=1232&&b.toString('base64')===v;})}).strict();
export function registerCharterSalesRoutes(app:FastifyInstance,provider?:CharterSalesProvider|null){
 const service=provider?Object.freeze({create:provider.create.bind(provider),read:provider.read.bind(provider),accept:provider.accept.bind(provider),payMembers:provider.payMembers.bind(provider),prepare:provider.prepare.bind(provider),recoverPreparation:provider.recoverPreparation.bind(provider),retainSigned:provider.retainSigned.bind(provider),recover:provider.recover.bind(provider),cancel:provider.cancel.bind(provider)}):null;
 const requireService=()=>{if(!service)throw new HttpError(503,'Charter sales unavailable','CLAN_CHARTER_SALE_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},path='/clans/charter/sales';
 app.post(path,post,async(req,reply)=>{parse(empty,req.query);return reply.code(201).send(await requireService().create(req.wallet,parse(CharterSaleDraftSchema,req.body)));});
 app.get(path+'/:id',auth,async req=>{parse(empty,req.query);return requireService().read(req.wallet,parse(params,req.params).id);});
 app.post(path+'/:id/accept',post,async req=>{parse(empty,req.query);return requireService().accept(req.wallet,parse(params,req.params).id,parse(CharterSaleAcceptanceSchema,req.body));});
 for(const [suffix,method] of [['pay-members','payMembers'],['prepare','prepare'],['recover-preparation','recoverPreparation'],['recover','recover'],['cancel','cancel']] as const)
  app.post(path+'/:id/'+suffix,post,async req=>{parse(empty,req.query);const p=parse(params,req.params);parse(empty,req.body??{});return requireService()[method](req.wallet,p.id);});
 app.post(path+'/:id/signed',post,async req=>{parse(empty,req.query);const p=parse(params,req.params),body=parse(signed,req.body);return requireService().retainSigned(req.wallet,p.id,Buffer.from(body.signedTransaction,'base64'));});
}

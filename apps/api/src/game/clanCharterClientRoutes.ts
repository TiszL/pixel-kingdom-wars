import {TWOFA} from '@shardkeep/shared';
import {CharterCreationRequestSchema,CharterSaleDraftSchema,CharterSaleAcceptanceSchema,CharterSignatureRequestSchema,CharterSignedRequestSchema,CharterRefundRequestSchema} from '@shardkeep/shared/charterApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {CharterClientProvider} from './clanCharterClient';
const empty=z.object({}).strict(),uuid=z.uuid().refine(v=>v===v.toLowerCase()),params=z.object({id:uuid}).strict();
export function registerCharterClientRoutes(app:FastifyInstance,provider?:CharterClientProvider|null){
 const service=provider?Object.freeze(Object.fromEntries(Object.entries(provider).map(([key,value])=>[key,value.bind(provider)]))) as CharterClientProvider:null;
 const use=()=>{if(!service)throw new HttpError(503,'Charter client unavailable','CLAN_CHARTER_CLIENT_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},root='/clans/charter/client';
 app.get(root+'/activity',auth,async req=>{const q=parse(z.object({cursor:z.string().min(1).max(256).optional()}).strict(),req.query);return use().activity(req.wallet,q.cursor);});
 app.get(root+'/sales/by-key/:key',auth,async req=>{parse(empty,req.query);return use().saleByKey(req.wallet,parse(z.object({key:uuid}).strict(),req.params).key);});
 app.post(root+'/creations',post,async(req,reply)=>{parse(empty,req.query);return reply.code(201).send(await use().create(req.wallet,parse(CharterCreationRequestSchema,req.body)));});
 app.post(root+'/sales',post,async(req,reply)=>{parse(empty,req.query);return reply.code(201).send(await use().createSale(req.wallet,parse(CharterSaleDraftSchema,req.body)));});
 for(const [path,method] of [['creations','readCreation'],['sales','readSale']] as const)
  app.get(`${root}/${path}/:id`,auth,async req=>{parse(empty,req.query);return use()[method](req.wallet,parse(params,req.params).id);});
 for(const [path,method] of [['creations/:id/prepare','prepareCreation'],['creations/:id/recover-preparation','recoverCreationPreparation'],['creations/:id/recover','recoverCreation'],
  ['sales/:id/pay-members','paySaleMembers'],['sales/:id/prepare','prepareSale'],['sales/:id/recover-preparation','recoverSalePreparation'],['sales/:id/recover','recoverSale'],['sales/:id/cancel','cancelSale']] as const)
  app.post(`${root}/${path}`,post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);parse(empty,req.body??{});return use()[method](req.wallet,id);});
 app.post(root+'/creations/:id/signed',post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params),body=parse(CharterSignedRequestSchema,req.body),bytes=Buffer.from(body.signedTransaction,'base64');
  if(bytes.length<=65||bytes.length>1232||bytes.toString('base64')!==body.signedTransaction)throw new HttpError(400,'Invalid signed transaction','CLAN_CHARTER_CLIENT_INPUT');return use().retainCreationSigned(req.wallet,id,bytes);});
 app.post(root+'/creations/:id/refund',post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params),body=parse(CharterRefundRequestSchema,req.body??{});return use().refundCreation(req.wallet,id,body.destinationBaseId);});
 app.post(root+'/sales/:id/accept',post,async req=>{parse(empty,req.query);return use().acceptSale(req.wallet,parse(params,req.params).id,parse(CharterSaleAcceptanceSchema,req.body));});
 app.post(root+'/sales/:id/signature',post,async req=>{parse(empty,req.query);return use().retainSaleSignature(req.wallet,parse(params,req.params).id,parse(CharterSignatureRequestSchema,req.body));});
 for(const [path,kind] of [['creations','creation'],['sales','sale']] as const)
  app.post(`${root}/${path}/:id/deliver`,post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);parse(empty,req.body??{});return use().deliver(req.wallet,kind,id);});
}

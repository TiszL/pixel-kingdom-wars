/** Closed default-off equipment rail. Existing SOL listings and deposits
 * are not route dependencies. Recovery uses saved actor/destination identities. */
import {TWOFA} from '@shardkeep/shared';
import {KeepEquipmentStockQuerySchema,KeepEquipmentMarketListingRequestSchema,KeepEquipmentMarketFillRequestSchema,KeepEquipmentMarketCancelRequestSchema,KeepEquipmentSignedRequestSchema,KeepEquipmentListingsQuerySchema,KeepEquipmentHistoryQuerySchema} from '@shardkeep/shared/keepEquipmentMarketApi';
import {OrdinaryEquipmentUuidSchema} from '@shardkeep/shared/ordinaryEquipmentApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import {keepEquipmentMarketPolicy,type KeepEquipmentMarketProvider} from './keepEquipmentMarketProvider';
const empty=z.object({}).strict(),params=z.object({id:OrdinaryEquipmentUuidSchema}).strict();
const unavailable=():never=>{throw new HttpError(503,'Equipment market is unavailable','KEEP_EQUIPMENT_MARKET_UNAVAILABLE');};
export function registerKeepEquipmentMarketRoutes(app:FastifyInstance,deps?:KeepEquipmentMarketProvider|null){
 const use=()=>deps??unavailable();
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(k:string,v:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.get('/keep-equipment-market/policy',auth,async req=>{parse(z.object({version:z.literal('1').optional()}).strict(),req.query);return keepEquipmentMarketPolicy();});
 app.get('/keep-equipment-market/stock',auth,async req=>{const q=parse(KeepEquipmentStockQuerySchema,req.query);return use().stock(req.wallet,q);});
 app.get('/keep-equipment-market/listings',auth,async req=>{const q=parse(KeepEquipmentListingsQuerySchema,req.query);return use().offers(q);});
 app.get('/keep-equipment-market/history',auth,async req=>use().history(req.wallet,parse(KeepEquipmentHistoryQuerySchema,req.query)));
 app.get('/keep-equipment-market/listings/:id',auth,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);return use().listing(id);});
 app.get('/keep-equipment-market/cancellations/:id',auth,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);return use().cancellation(req.wallet,id);});
 app.post('/keep-equipment-market/listings',post,async req=>{parse(empty,req.query);const body=parse(KeepEquipmentMarketListingRequestSchema,req.body);return use().list(req.wallet,body);});
 app.post('/keep-equipment-market/fills',post,async req=>{parse(empty,req.query);const body=parse(KeepEquipmentMarketFillRequestSchema,req.body);return use().fill(req.wallet,body);});
 app.post('/keep-equipment-market/cancellations',post,async req=>{parse(empty,req.query);const body=parse(KeepEquipmentMarketCancelRequestSchema,req.body);return use().cancel(req.wallet,body);});
 app.get('/keep-equipment-market/fills/:id',auth,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);return use().read(req.wallet,id);});
 for(const action of ['release','prepare','recover','review','deliver'] as const)app.post('/keep-equipment-market/fills/:id/'+action,post,async req=>{
  parse(empty,req.query);parse(empty,req.body??{});const {id}=parse(params,req.params);return use()[action](req.wallet,id);
 });
 app.post('/keep-equipment-market/fills/:id/signed',post,async req=>{
  parse(empty,req.query);const {id}=parse(params,req.params),body=parse(KeepEquipmentSignedRequestSchema,req.body);return use().retainSigned(req.wallet,id,Buffer.from(body.signedTransactionHex,'hex'));
 });
}

/** Strict authenticated original reads/recovery; no custody or signed payload. */
import {TWOFA} from '@shardkeep/shared';
import {VehicleCraftQuoteRequestSchema,VehicleCraftHistoryQuerySchema,VehicleCraftKeyParamsSchema} from '@shardkeep/shared/vehicleCraftClientApi';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import type {VehicleCraftClientProvider} from './vehicleCraftClient';
const empty=z.object({}).strict();
export function registerVehicleCraftClientRoutes(app:FastifyInstance,provider?:VehicleCraftClientProvider|null){
 const service=provider?Object.freeze({quote:provider.quote.bind(provider),read:provider.read.bind(provider),history:provider.history.bind(provider),recover:provider.recover.bind(provider)}):null;
 const use=()=>{if(!service)throw new HttpError(503,'Original craft history is unavailable','VEHICLE_CRAFT_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.post('/vehicles/craft/quote',post,async req=>{parse(empty,req.query);return use().quote(req.wallet,parse(VehicleCraftQuoteRequestSchema,req.body));});
 app.get('/vehicles/craft/history',auth,async req=>{const q=parse(VehicleCraftHistoryQuerySchema,req.query);return use().history(req.wallet,q.cursor);});
 app.get('/vehicles/craft/by-key/:key',auth,async req=>{parse(empty,req.query);return use().read(req.wallet,parse(VehicleCraftKeyParamsSchema,req.params).key);});
 app.post('/vehicles/craft/by-key/:key/recover',post,async req=>{parse(empty,req.query);parse(empty,req.body??{});return use().recover(req.wallet,parse(VehicleCraftKeyParamsSchema,req.params).key);});
}

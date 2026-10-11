/** Authenticated original service intent and exact signed consent only. Public
 * records are redacted by the closed owner workflow; no proof or relay input. */
import {TWOFA} from '@shardkeep/shared';
import {VehicleServiceRequestSchema,VehicleServiceSignedRequestSchema} from '@shardkeep/shared/vehicleServiceApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {VehicleServiceWorkflowProvider} from './vehicleServiceWorkflow';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),empty=z.object({}).strict(),params=z.object({id:uuid}).strict(),key=z.object({key:z.string().min(1).max(128)}).strict();
export function registerVehicleServiceRoutes(app:FastifyInstance,provider?:VehicleServiceWorkflowProvider|null):void{
 // Retain the trusted methods once; request payloads cannot replace a capability.
 const service=provider?Object.freeze({reserve:provider.reserve.bind(provider),readByKey:provider.readByKey.bind(provider),read:provider.read.bind(provider),prepare:provider.prepare.bind(provider),retainSigned:provider.retainSigned.bind(provider),recover:provider.recover.bind(provider)}):null;
 const requireService=()=>{if(!service)throw new HttpError(503,'Vehicle service workflow unavailable','VEHICLE_SERVICE_WORKFLOW_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.get('/vehicles/services/by-key/:key',auth,async req=>{const p=parse(key,req.params);parse(empty,req.query);return requireService().readByKey(req.wallet,p.key);});
 app.get('/vehicles/services/:id',auth,async req=>{const p=parse(params,req.params);parse(empty,req.query);return requireService().read(req.wallet,p.id);});
 app.post('/vehicles/services',post,async req=>{const body=parse(VehicleServiceRequestSchema,req.body);parse(empty,req.query);return requireService().reserve(req.wallet,body);});
 app.post('/vehicles/services/:id/prepare',post,async req=>{const p=parse(params,req.params);parse(empty,req.body??{});parse(empty,req.query);return requireService().prepare(req.wallet,p.id);});
 app.post('/vehicles/services/:id/signed',post,async req=>{const p=parse(params,req.params),body=parse(VehicleServiceSignedRequestSchema,req.body);parse(empty,req.query);return requireService().retainSigned(req.wallet,p.id,Buffer.from(body.signedTransaction,'base64'));});
 app.post('/vehicles/services/:id/recover',post,async req=>{const p=parse(params,req.params);parse(empty,req.body??{});parse(empty,req.query);return requireService().recover(req.wallet,p.id);});
}

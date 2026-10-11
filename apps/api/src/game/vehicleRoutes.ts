/** Authenticated identifiers and exact signed consent only; never caller proof. */
import {TWOFA} from '@shardkeep/shared';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {VehicleWorkflowProvider} from './vehicleWorkflow';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),empty=z.object({}).strict(),params=z.object({id:uuid}).strict(),key=z.object({key:z.string().min(1).max(128)}).strict();
const request=z.object({baseId:uuid,berthId:uuid,assetId:PhaseEVehicleMintIdentitySchema.shape.assetId,idempotencyKey:z.string().min(1).max(128)}).strict();
const wire=z.object({signedTransaction:z.string().min(88).max(1644).refine(v=>{const b=Buffer.from(v,'base64');return b.length>=66&&b.length<=1232&&b.toString('base64')===v;})}).strict();
export function registerVehicleRoutes(app:FastifyInstance,provider?:VehicleWorkflowProvider|null):void{
 // Capture methods now; request handling cannot swap in caller capabilities.
 const service=provider?Object.freeze({reserve:provider.reserve.bind(provider),readByKey:provider.readByKey.bind(provider),read:provider.read.bind(provider),prepare:provider.prepare.bind(provider),retainSigned:provider.retainSigned.bind(provider),recover:provider.recover.bind(provider)}):null;
 const requireService=()=>{if(!service)throw new HttpError(503,'Vehicle workflow unavailable','VEHICLE_WORKFLOW_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.get('/vehicles/reservations/by-key/:key',auth,async req=>{const p=parse(key,req.params);parse(empty,req.query);return requireService().readByKey(req.wallet,p.key);});
 app.get('/vehicles/reservations/:id',auth,async req=>{const p=parse(params,req.params);parse(empty,req.query);return requireService().read(req.wallet,p.id);});
 app.post('/vehicles/reservations',post,async req=>{const body=parse(request,req.body);parse(empty,req.query);return requireService().reserve(req.wallet,body);});
 app.post('/vehicles/reservations/:id/prepare',post,async req=>{const p=parse(params,req.params);parse(empty,req.body??{});parse(empty,req.query);return requireService().prepare(req.wallet,p.id);});
 app.post('/vehicles/reservations/:id/signed',post,async req=>{const p=parse(params,req.params),body=parse(wire,req.body);parse(empty,req.query);return requireService().retainSigned(req.wallet,p.id,Buffer.from(body.signedTransaction,'base64'));});
 app.post('/vehicles/reservations/:id/recover',post,async req=>{const p=parse(params,req.params);parse(empty,req.body??{});parse(empty,req.query);return requireService().recover(req.wallet,p.id);});
}

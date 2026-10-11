/** Original actor endpoints; no client proof, fee, replacement or target changes. */
import {applyEquipmentFitting,EquipmentFittingQueryFields,equipmentFittingQuery} from '@shardkeep/shared/phaseEOrdinaryEquipment';
import {TWOFA} from '@shardkeep/shared';
import {VehicleInstallationRequestSchema,VehicleInstallationSignedRequestSchema,VehicleReferenceSchema,VehicleRoutePolicyVersionSchema,VehicleRoutesSchema} from '@shardkeep/shared/vehicleClientApi';
import {VehicleServiceRequestSchema} from '@shardkeep/shared/vehicleServiceApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {VehicleClientProvider} from './vehicleClient';
const empty=z.object({}).strict(),params=z.object({id:VehicleReferenceSchema.shape.id}).strict(),byKey=z.object({key:z.string().min(1).max(128)}).strict();
const page=z.object({cursor:z.string().min(1).max(256).optional()}).strict(),base=z.object({baseId:z.uuid().regex(/^[0-9a-f-]+$/),policyVersion:z.enum(['1','2']).transform(Number).pipe(VehicleRoutePolicyVersionSchema).optional(),...EquipmentFittingQueryFields}).strict().refine(v=>{try{equipmentFittingQuery(v);return true;}catch{return false;}},'Invalid equipment selection');
export function registerVehicleClientRoutes(app:FastifyInstance,provider?:VehicleClientProvider|null):void{
 const service=provider?Object.freeze({reserve:provider.reserve.bind(provider),read:provider.read.bind(provider),readByKey:provider.readByKey.bind(provider),prepare:provider.prepare.bind(provider),retainSigned:provider.retainSigned.bind(provider),recover:provider.recover.bind(provider),review:provider.review.bind(provider),deliver:provider.deliver.bind(provider),activity:provider.activity.bind(provider),assets:provider.assets.bind(provider),assetsV2:provider.assetsV2.bind(provider),routes:provider.routes.bind(provider)}):null;
 const use=()=>{if(!service)throw new HttpError(503,'Vehicle clients are unavailable','VEHICLE_CLIENT_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 for(const kind of ['installation','service'] as const){const prefix='/vehicles/client/'+(kind==='installation'?'installations':'services');
  app.post(prefix,post,async req=>{parse(empty,req.query);const body=kind==='installation'?parse(VehicleInstallationRequestSchema,req.body):parse(VehicleServiceRequestSchema,req.body);return use().reserve(req.wallet,kind,body);});
  app.get(prefix+'/by-key/:key',auth,async req=>{parse(empty,req.query);const {key}=parse(byKey,req.params);return use().readByKey(req.wallet,kind,key);});
  app.get(prefix+'/:id',auth,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);return use().read(req.wallet,{kind,id});});
  for(const action of ['prepare','recover','review','deliver'] as const)app.post(prefix+'/:id/'+action,post,async req=>{parse(empty,req.query);parse(empty,req.body??{});const {id}=parse(params,req.params);return use()[action](req.wallet,{kind,id});});
  app.post(prefix+'/:id/signed',post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params),body=parse(VehicleInstallationSignedRequestSchema,req.body);return use().retainSigned(req.wallet,{kind,id},Buffer.from(body.signedTransaction,'base64'));});
 }
 app.get('/vehicles/client/activity',auth,async req=>{const q=parse(page,req.query);return use().activity(req.wallet,q.cursor);});
 app.get('/vehicles/client/assets',auth,async req=>{const q=parse(page,req.query);return use().assets(req.wallet,q.cursor);});
 app.get('/vehicles/client/assets-v2',auth,async req=>{const q=parse(page,req.query);return use().assetsV2(req.wallet,q.cursor);});
 app.get('/vehicles/client/routes',auth,async req=>{const q=parse(base,req.query);const view=await use().routes(req.wallet,q.baseId,q.policyVersion);if(!q.fitting)return view;return VehicleRoutesSchema.parse({...view,items:view.items.map(item=>({...item,previews:item.previews.flatMap(route=>{try{return [applyEquipmentFitting(route,equipmentFittingQuery(q))];}catch{return [];}})}))});});
}

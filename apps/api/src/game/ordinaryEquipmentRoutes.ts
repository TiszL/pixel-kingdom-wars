/** Closed wallet-scoped service. No owner DB reaches route dependencies. */
import {TWOFA} from '@shardkeep/shared';
import {OrdinaryEquipmentRequestSchema,OrdinaryEquipmentUuidSchema} from '@shardkeep/shared/ordinaryEquipmentApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import type {OrdinaryEquipmentProvider} from './ordinaryEquipmentProvider';
export function registerOrdinaryEquipmentRoutes(app:FastifyInstance,deps?:OrdinaryEquipmentProvider|null){
 const service=()=>{if(!deps)throw new HttpError(503,'Ordinary equipment is unavailable','EQUIPMENT_UNAVAILABLE');return deps;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(k:string,v:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const empty=z.object({}).strict(),key=z.object({key:OrdinaryEquipmentUuidSchema}).strict();
 app.get('/ordinary-equipment/jobs/by-key/:key',auth,async req=>{const p=parse(key,req.params);parse(empty,req.query);return service().read(req.wallet,p.key);});
 app.post('/ordinary-equipment/jobs',{...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},async req=>{
  const request=parse(OrdinaryEquipmentRequestSchema,req.body);parse(empty,req.query);
  return service().start(req.wallet,request);
 });
 app.get('/ordinary-equipment',auth,async req=>{
  const {baseId,catalogueVersion}=parse(z.object({baseId:OrdinaryEquipmentUuidSchema,catalogueVersion:z.literal('2').optional()}).strict(),req.query);
  return service().view(req.wallet,baseId,catalogueVersion==='2'?2:1);
 });
}

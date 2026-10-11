/** Explicit Aurora capability; normal startup supplies no C5 application admission. */
import {TWOFA} from '@shardkeep/shared';
import {BoundCosmeticRequestSchema} from '@shardkeep/shared/boundCosmeticApi';
import {BoundCosmeticWakeWorkshopQuerySchema,BoundCosmeticWakePreferenceRequestSchema} from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import type {BoundCosmeticWorkshop} from './boundCosmeticWorkshop';
export function registerBoundCosmeticWakeWorkshopRoutes(app:FastifyInstance,provider?:BoundCosmeticWorkshop['wake']|null):void{
 const service=()=>{if(!provider)throw new HttpError(503,'Aurora Workshop is unavailable','BOUND_COSMETIC_UNAVAILABLE');return provider;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(k:string,v:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const empty=z.object({}).strict(),write={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.get('/bound-cosmetics/wakes/v1/workshop',auth,async req=>{const q=parse(BoundCosmeticWakeWorkshopQuerySchema,req.query??{});return service().view(req.wallet,q.baseId);});
 app.post('/bound-cosmetics/wakes/v1/jobs',write,async req=>{const body=parse(BoundCosmeticRequestSchema,req.body);parse(empty,req.query);return service().start(req.wallet,body);});
 app.put('/bound-cosmetics/wakes/v1/preference',write,async req=>{const body=parse(BoundCosmeticWakePreferenceRequestSchema,req.body);parse(empty,req.query);return service().preference(req.wallet,body);});
}

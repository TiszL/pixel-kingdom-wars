/** Closed wallet-scoped appearances. Registration is deliberately separate from
 * application readiness; the private provider owns every admission decision. */
import {TWOFA} from '@shardkeep/shared';
import {BoundCosmeticRequestSchema} from '@shardkeep/shared/boundCosmeticApi';
import {BoundCosmeticWorkshopQuerySchema,BoundCosmeticPreferenceRequestSchema} from '@shardkeep/shared/boundCosmeticWorkshopApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import type {BoundCosmeticWorkshop} from './boundCosmeticWorkshop';

export function registerBoundCosmeticRoutes(app:FastifyInstance,provider?:BoundCosmeticWorkshop|null):void{
 const service=()=>{if(!provider)throw new HttpError(503,'Appearances are temporarily unavailable','BOUND_COSMETIC_UNAVAILABLE');return provider;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(k:string,v:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const empty=z.object({}).strict(),key=z.object({key:z.uuid().regex(/^[0-9a-f-]+$/)}).strict();
 const write={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}};
 app.get('/bound-cosmetics',auth,async req=>{const q=parse(BoundCosmeticWorkshopQuerySchema,req.query??{});return service().view(req.wallet,q.baseId);});
 app.get('/bound-cosmetics/jobs/by-key/:key',auth,async req=>{const p=parse(key,req.params);parse(empty,req.query);return service().read(req.wallet,p.key);});
 app.post('/bound-cosmetics/jobs',write,async req=>{const body=parse(BoundCosmeticRequestSchema,req.body);parse(empty,req.query);return service().start(req.wallet,body);});
 app.put('/bound-cosmetics/awning',write,async req=>{const body=parse(BoundCosmeticPreferenceRequestSchema,req.body);parse(empty,req.query);return service().preference(req.wallet,body);});
}

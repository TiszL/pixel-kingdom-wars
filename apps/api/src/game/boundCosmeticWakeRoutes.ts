/** Versioned read-only opt-in beside unchanged gameplay and original receipts. */
import {BoundCosmeticWakeOriginalQuerySchema,BoundCosmeticWakeCurrentQuerySchema} from '@shardkeep/shared/boundCosmeticWakePresentation';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import type {BoundCosmeticWakeViews} from './boundCosmeticWakeViews';
export function registerBoundCosmeticWakeRoutes(app:FastifyInstance,provider?:BoundCosmeticWakeViews|null):void{
 const service=()=>{if(!provider)throw new HttpError(503,'Expedition appearances are temporarily unavailable','BOUND_COSMETIC_WAKE_UNAVAILABLE');return provider;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(k:string,v:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const empty=z.object({}).strict();
 app.get('/bound-cosmetics/wakes/v1/originals/:kind/:key',auth,async req=>{const p=parse(BoundCosmeticWakeOriginalQuerySchema,req.params);parse(empty,req.query);return service().original(req.wallet,p.kind,p.key);});
 app.get('/bound-cosmetics/wakes/v1/current',auth,async req=>{const p=parse(BoundCosmeticWakeCurrentQuerySchema,req.query);return service().current(req.wallet,p.baseId);});
}

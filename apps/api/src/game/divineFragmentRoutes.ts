import {TWOFA} from '@shardkeep/shared';
import {DivineFragmentDeliveryRequestSchema,DivineFragmentSeekerClaimRequestSchema,DivineFragmentPageQuerySchema} from '@shardkeep/shared/divineFragmentsApi';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {fragmentId,type DivineFragmentProvider} from './divineFragments';
import type {SeekerFragmentProvider} from './seekerFragmentClaims';
const Empty=z.object({}).strict(),Params=z.object({id:fragmentId}).strict();
export interface DivineFragmentRouteProvider{readonly fragments:DivineFragmentProvider;readonly seeker:SeekerFragmentProvider;}
export function registerDivineFragmentRoutes(app:FastifyInstance,provider?:DivineFragmentRouteProvider|null){
 const use=()=>{if(!provider)throw new HttpError(503,'Fragment sources unavailable','DIVINE_FRAGMENT_DISABLED');return provider;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(key:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:1024,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},root='/divine-fragments';
 app.get(root+'/policy',auth,async req=>{parse(Empty,req.query);return use().fragments.policy();});
 app.get(root+'/awards',auth,async req=>use().fragments.awards(req.wallet,parse(DivineFragmentPageQuerySchema,req.query)));
 app.get(root+'/events/:id',auth,async req=>{parse(Empty,req.query);return use().fragments.award(req.wallet,parse(Params,req.params).id);});
 app.post(root+'/events/:id/delivery',post,async req=>{parse(Empty,req.query);return use().fragments.deliver(req.wallet,parse(Params,req.params).id,parse(DivineFragmentDeliveryRequestSchema,req.body));});
 app.get(root+'/deliveries/:id',auth,async req=>{parse(Empty,req.query);return use().fragments.deliveryRead(req.wallet,parse(Params,req.params).id);});
 app.get(root+'/stock/:id',auth,async req=>{parse(Empty,req.query);return use().fragments.stock(req.wallet,parse(Params,req.params).id);});
 app.get(root+'/seeker/terms/:id',auth,async req=>{parse(Empty,req.query);return use().seeker.term(req.wallet,parse(Params,req.params).id);});
 app.get(root+'/seeker/terms',auth,async req=>use().seeker.terms(req.wallet,parse(DivineFragmentPageQuerySchema,req.query)));
 app.post(root+'/seeker/claims',post,async req=>{parse(Empty,req.query);return use().seeker.claim(req.wallet,parse(DivineFragmentSeekerClaimRequestSchema,req.body));});
 app.get(root+'/seeker/claims/:id',auth,async req=>{parse(Empty,req.query);return use().seeker.claimRead(req.wallet,parse(Params,req.params).id);});
}

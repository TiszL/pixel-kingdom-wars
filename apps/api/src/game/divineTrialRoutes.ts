import {PHASE_E_DIVINE_TRIALS as P,TWOFA} from '@shardkeep/shared';
import {DivineTrialIdSchema} from '@shardkeep/shared/divineTrials';
import {DivineTrialEntryRequestSchema,DivineTrialAttemptRequestSchema,DivineTrialSubmitRequestSchema,DivineTrialPrizeRequestSchema,DivineTrialEmptySchema as Empty} from '@shardkeep/shared/divineTrialsApi';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {DivineTrialProvider} from './divineTrials';
const Params=z.object({id:DivineTrialIdSchema}).strict();
export function registerDivineTrialRoutes(app:FastifyInstance,provider?:DivineTrialProvider|null){
 const service=provider?Object.freeze(Object.fromEntries(Object.entries(provider).map(([key,value])=>[key,value.bind(provider)]))) as DivineTrialProvider:null;
 const use=()=>{if(!service)throw new HttpError(503,'Divine trials unavailable','DIVINE_TRIAL_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(key:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:P.maxDeploys*P.maxStringLength,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},root='/divine-trials';
 app.get(root+'/events',auth,async req=>{const query=parse(z.object({cursor:z.string().min(1).max(P.maxStringLength).optional()}).strict(),req.query);return use().events(req.wallet,query.cursor);});
 app.get(root+'/events/:id/participant',auth,async req=>{parse(Empty,req.query);return use().participant(req.wallet,parse(Params,req.params).id);});
 app.get(root+'/attempts/:id',auth,async req=>{parse(Empty,req.query);return use().read(req.wallet,parse(Params,req.params).id);});
 app.post(root+'/events/:id/entries',post,async req=>{parse(Empty,req.query);return use().enter(req.wallet,parse(Params,req.params).id,parse(DivineTrialEntryRequestSchema,req.body));});
 app.post(root+'/events/:id/attempts',post,async req=>{parse(Empty,req.query);return use().admit(req.wallet,parse(Params,req.params).id,parse(DivineTrialAttemptRequestSchema,req.body));});
 app.post(root+'/attempts/:id/submit',post,async req=>{parse(Empty,req.query);return use().submit(req.wallet,parse(Params,req.params).id,parse(DivineTrialSubmitRequestSchema,req.body));});
 app.post(root+'/attempts/:id/abandon',post,async req=>{parse(Empty,req.query);parse(Empty,req.body??{});return use().abandon(req.wallet,parse(Params,req.params).id);});
 app.post(root+'/events/:id/prize',post,async req=>{parse(Empty,req.query);return use().claim(req.wallet,parse(Params,req.params).id,parse(DivineTrialPrizeRequestSchema,req.body));});
}

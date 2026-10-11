import {TWOFA} from '@shardkeep/shared';
import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {CharterTournamentEventsClientProvider} from './clanCharterTournamentEventsClient';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),empty=z.object({}).strict(),params=z.object({id:uuid}).strict();
export function registerCharterTournamentEventsRoutes(app:FastifyInstance,provider?:CharterTournamentEventsClientProvider|null){
 const service=provider?Object.freeze(Object.fromEntries(Object.entries(provider).map(([key,value])=>[key,value.bind(provider)]))) as CharterTournamentEventsClientProvider:null;
 const use=()=>{if(!service)throw new HttpError(503,'Tournament events unavailable','CLAN_CHARTER_TOURNAMENT_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_req:unknown,reply:{header:(key:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},root='/clans/charter/tournaments';
 app.get(root+'/events',auth,async req=>{const query=parse(z.object({cursor:z.string().min(1).max(256).optional()}).strict(),req.query);return use().activity(req.wallet,query.cursor);});
 app.get(root+'/events/:id',auth,async req=>{parse(empty,req.query);return use().read(req.wallet,parse(params,req.params).id);});
 app.get(root+'/events/:id/participation',auth,async req=>{parse(empty,req.query);return use().participation(req.wallet,parse(params,req.params).id);});
 app.get(root+'/entries/by-key/:key',auth,async req=>{parse(empty,req.query);return use().entryByKey(req.wallet,parse(z.object({key:uuid}).strict(),req.params).key);});
 app.post(root+'/events',post,async(req,reply)=>{parse(empty,req.query);return reply.code(201).send(await use().fund(req.wallet,req.body));});
 app.post(root+'/events/:id/close',post,async req=>{parse(empty,req.query);parse(empty,req.body??{});return use().close(req.wallet,parse(params,req.params).id);});
 app.post(root+'/events/:id/prize',post,async req=>{parse(empty,req.query);return use().claim(req.wallet,parse(params,req.params).id,parse(z.object({baseId:uuid}).strict(),req.body));});
 app.post(root+'/events/:id/raids',post,async req=>{parse(empty,req.query);return use().startRaid(req.wallet,parse(params,req.params).id,parse(z.object({baseId:uuid,idempotencyKey:uuid}).strict(),req.body));});
 app.get(root+'/events/:id/raids/by-key/:key',auth,async req=>{parse(empty,req.query);const p=parse(z.object({id:uuid,key:uuid}).strict(),req.params);return use().readRaid(req.wallet,p.id,p.key);});
 app.post(root+'/events/:id/raids/by-key/:key/cancel',post,async req=>{parse(empty,req.query);parse(empty,req.body??{});const p=parse(z.object({id:uuid,key:uuid}).strict(),req.params);return use().cancelRaidRequest(req.wallet,p.id,p.key);});
 app.post(root+'/raids/:id/replay',post,async req=>{parse(empty,req.query);parse(empty,req.body??{});return use().replayRaid(req.wallet,parse(params,req.params).id);});
}

/** D153.181 private original lock operations. Installed capability only. */
import {TWOFA} from '@shardkeep/shared';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import type {CharterTournamentProvider} from './clanCharterTournaments';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),empty=z.object({}).strict(),params=z.object({id:uuid}).strict();
const entry=z.object({eventId:uuid,clanId:uuid,idempotencyKey:uuid}).strict(),clear=z.object({idempotencyKey:uuid}).strict();
const signed=z.object({signedTransaction:z.string().min(88).max(1644).refine(v=>{const bytes=Buffer.from(v,'base64');return bytes.length>65&&bytes.length<=1232&&bytes.toString('base64')===v;})}).strict();
export function registerCharterTournamentRoutes(app:FastifyInstance,provider?:CharterTournamentProvider|null){
 const service=provider?Object.freeze(Object.fromEntries(Object.entries(provider).map(([key,value])=>[key,value.bind(provider)]))) as CharterTournamentProvider:null;
 const use=()=>{if(!service)throw new HttpError(503,'Tournament operations unavailable','CLAN_CHARTER_TOURNAMENT_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},root='/clans/charter/tournaments';
 app.post(root+'/entries',post,async(req,reply)=>{parse(empty,req.query);return reply.code(201).send(await use().createEntry(req.wallet,parse(entry,req.body)));});
 app.get(root+'/entries/:id',auth,async req=>{parse(empty,req.query);return use().readEntry(req.wallet,parse(params,req.params).id);});
 app.post(root+'/entries/:id/clear',post,async req=>{parse(empty,req.query);return use().createClear(req.wallet,parse(params,req.params).id,parse(clear,req.body));});
 app.get(root+'/operations/:id',auth,async req=>{parse(empty,req.query);return use().readOperation(req.wallet,parse(params,req.params).id);});
 for(const [suffix,method] of [['prepare','prepare'],['recover-preparation','recoverPreparation'],['recover','recover'],['cancel','cancel'],['deliver','deliver']] as const)
  app.post(`${root}/operations/:id/${suffix}`,post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);parse(empty,req.body??{});return use()[method](req.wallet,id);});
 app.post(root+'/operations/:id/signed',post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params),body=parse(signed,req.body);return use().retainSigned(req.wallet,id,Buffer.from(body.signedTransaction,'base64'));});
}

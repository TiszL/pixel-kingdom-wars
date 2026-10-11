import {TWOFA} from '@shardkeep/shared';
import {CharterSignedRequestSchema} from '@shardkeep/shared/charterApi';
import {CharterMigrationRequestSchema} from '@shardkeep/shared/charterMigrationApi';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {CharterMigrationClientProvider} from './clanCharterMigrationClient';
const empty=z.object({}).strict(),id=CharterMigrationRequestSchema.shape.clanId,params=z.object({id}).strict();
export function registerCharterMigrationRoutes(app:FastifyInstance,provider?:CharterMigrationClientProvider|null){
 const service=provider?Object.freeze(Object.fromEntries(Object.entries(provider).map(([key,value])=>[key,value.bind(provider)]))) as CharterMigrationClientProvider:null;
 const use=()=>{if(!service)throw new HttpError(503,'Clan migration is unavailable','CLAN_CHARTER_MIGRATION_UNAVAILABLE');return service;};
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const post={...auth,bodyLimit:4096,config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}}},root='/clans/charter/migrations';
 app.get(root+'/activity',auth,async req=>{parse(empty,req.query);return use().activity(req.wallet);});
 app.get(root+'/by-key/:id',auth,async req=>{parse(empty,req.query);return use().byKey(req.wallet,parse(params,req.params).id);});
 app.get(root+'/:id',auth,async req=>{parse(empty,req.query);return use().read(req.wallet,parse(params,req.params).id);});
 app.post(root,post,async(req,reply)=>{parse(empty,req.query);return reply.code(201).send(await use().create(req.wallet,parse(CharterMigrationRequestSchema,req.body)));});
 for(const [path,method] of [['prepare','prepare'],['recover-preparation','recoverPreparation'],['deliver','deliver'],['recover','recover'],['cancel','cancel']] as const)
  app.post(`${root}/:id/${path}`,post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params);parse(empty,req.body??{});return use()[method](req.wallet,id);});
 app.post(root+'/:id/signed',post,async req=>{parse(empty,req.query);const {id}=parse(params,req.params),body=parse(CharterSignedRequestSchema,req.body),bytes=Buffer.from(body.signedTransaction,'base64');
  if(bytes.length<=129||bytes.length>1232||bytes.toString('base64')!==body.signedTransaction)throw new HttpError(400,'Invalid signed transaction','CLAN_CHARTER_MIGRATION_INPUT');return use().retainSigned(req.wallet,id,bytes);});
}

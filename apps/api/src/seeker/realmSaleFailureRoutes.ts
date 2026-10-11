/** Authenticated read-only owner evidence. HTTP never constructs a proof writer. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {RealmSaleFailureEnvelopeSchema} from '@shardkeep/shared/realmSaleFailureApi';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {getRealmSaleFailure} from './realmSaleFailure';
const keySchema=z.object({key:z.uuid().refine(v=>v===v.toLowerCase())}).strict(),empty=z.object({}).strict();
export function registerRealmSaleFailureRoutes(app:FastifyInstance,db:Db){
 app.get('/seeker/realm-sales/failures/by-key/:key',{
  preHandler:[app.authenticate],onSend:async(_request,reply,payload)=>{reply.header('Cache-Control','private, no-store');return payload;},
 },async req=>{
  const {key}=parse(keySchema,req.params);parse(empty,req.query);
  try{const lookup={wallet:req.wallet,idempotencyKey:key};return RealmSaleFailureEnvelopeSchema.parse({...lookup,failure:await getRealmSaleFailure(db,lookup)});}
  catch{throw new HttpError(503,'Realm purchase recovery is unavailable; keep the saved request','REALM_SALE_UNAVAILABLE');}
 });
}

import type {FastifyInstance} from 'fastify';
import {TWOFA} from '@shardkeep/shared';
import {RealmSaleOfferQuerySchema,RealmSaleCoverageQuerySchema} from '@shardkeep/shared/realmSaleOfferApi';
import {parse} from '../lib/validation';
import {HttpError} from '../lib/errors';
import {createRealmSaleOfferReader,RealmSaleOfferError} from './realmSaleOffer';
import type {RealmSalePreparationSources} from './realmSalePreparation';
export function registerRealmSaleOfferRoutes(app:FastifyInstance,sources?:RealmSalePreparationSources|null){
 const read=createRealmSaleOfferReader(sources),auth={preHandler:[app.authenticate],config:{rateLimit:{max:TWOFA.verifyRateLimitPerMin,timeWindow:60_000}},
  onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 const request=async<T>(work:()=>Promise<T>)=>{try{return await work();}catch(error){if(error instanceof RealmSaleOfferError)throw new HttpError(400,'Invalid realm sale observation request','INVALID_INPUT');throw error;}};
 app.get('/seeker/realm-sales/offer',auth,async req=>request(()=>read.offer(req.wallet,parse(RealmSaleOfferQuerySchema,req.query))));
 app.get('/seeker/realm-sales/coverage',auth,async req=>request(()=>read.coverage(req.wallet,parse(RealmSaleCoverageQuerySchema,req.query))));
}

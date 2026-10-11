/** Authenticated current-owner fleet projection; no settlement or caller proof. */
import {AdvancedFleetRequestSchema} from '@shardkeep/shared/advancedFleetApi';
import type {FastifyInstance} from 'fastify';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import type {AdvancedFleetViewProvider} from './advancedFleetView';
export function registerAdvancedFleetRoutes(app:FastifyInstance,provider?:AdvancedFleetViewProvider|null):void{
 const read=provider?.read.bind(provider);
 const auth={preHandler:[app.authenticate],onSend:async(_request:unknown,reply:{header:(name:string,value:string)=>unknown},payload:unknown)=>{reply.header('Cache-Control','private, no-store');return payload;}};
 app.get('/vehicles/fleet',auth,async req=>{
  const {baseId}=parse(AdvancedFleetRequestSchema,req.query??{});
  if(!read)throw new HttpError(503,'Advanced fleet unavailable','ADVANCED_FLEET_UNAVAILABLE');
  return read(req.wallet,baseId);
 });
}

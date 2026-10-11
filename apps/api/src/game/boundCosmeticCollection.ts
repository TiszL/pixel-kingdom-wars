/** Owner completion commits before request-role Workshop/base locks. Original
 * POST retries bypass this hook; their handlers recover before new admission. */
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {OrdinaryCraftingViewQuerySchema} from '@shardkeep/shared/ordinaryCraftingApi';
import {multiBaseEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';

export interface BoundCosmeticCollection {
 readonly collectForBaseRead:(wallet:string,requestedBaseId?:string)=>Promise<string|null>;
}
const baseQuery=z.object({baseId:z.uuid().optional()});
const equipmentQuery=z.object({baseId:z.uuid(),catalogueVersion:z.literal('2').optional()}).strict();
export function registerBoundCosmeticCollection(app:FastifyInstance,provider?:BoundCosmeticCollection|null):void{
 if(!provider)return;
 const collect=provider.collectForBaseRead.bind(provider);
 app.addHook('onRoute',options=>{
  if(!['/base','/ordinary-crafting','/ordinary-equipment'].includes(options.url)
   ||!(Array.isArray(options.method)?options.method.includes('GET'):options.method==='GET'))return;
  const previous=options.preHandler?(Array.isArray(options.preHandler)?options.preHandler:[options.preHandler]):[];
  options.preHandler=[...previous,async req=>{
   if(req.method!=='GET'||!req.wallet||!multiBaseEnabled())return;
   const {baseId}=options.url==='/base'?parse(baseQuery,req.query??{}):options.url==='/ordinary-crafting'
    ?parse(OrdinaryCraftingViewQuerySchema,req.query??{}):parse(equipmentQuery,req.query??{});
   let selected;
   try{selected=await collect(req.wallet,baseId);}
   catch(error){if(error instanceof HttpError)throw error;throw new HttpError(503,'Workshop completion is temporarily unavailable. Try refreshing again.','BOUND_COSMETIC_COLLECTION_HELD');}
   // Preserve the base whose completion was collected if an implicit selection
   // would otherwise change between this owner transaction and the handler.
   if(selected)req.query={...(req.query as Record<string,unknown>),baseId:selected};
  }];
 });
}

/** Only the exact rolled-back shared-queue refusal is a known admission error.
 * Connection/commit uncertainty must remain unknown for original lookup. */
export function boundCosmeticQueueError(error:unknown):unknown{
 let cause=error;
 for(let depth=0;depth<8&&cause&&typeof cause==='object';depth++){
  if('code'in cause&&cause.code==='P0001'&&'message'in cause&&cause.message==='BOUND_COSMETIC_WORKSHOP_BUSY')
   return new HttpError(409,'The Workshop already has an unfinished appearance job','ORDINARY_CRAFTING_BUSY');
  cause='cause'in cause?cause.cause:null;
 }
 return error;
}

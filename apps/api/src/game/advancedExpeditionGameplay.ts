/** D-153.145: lazy advanced returns before the ordinary base transaction starts.
 * The closed capability commits independently; later response failures do not
 * undo an accepted return. No new-departure or term provider is required. */
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {matchFleetJourneyEventBatch,type FleetJourneyEvent} from '@shardkeep/shared/fleetJourneyPresentation';
import {sql} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {multiBaseEnabled} from '../config';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {parse} from '../lib/validation';
import {resolveActiveBase,type FinalizedDeedReader} from './baseOwnership';
import {createAdvancedExpeditionWorkflow} from './advancedExpeditionWorkflow';
import {RaidAdvancedPresentationSchema} from './raidAdvancedPresentation';
import {AdvancedFleetIdentitySchema} from './currentAdvancedIdentity';

const query=z.object({baseId:z.uuid().optional()});
const held=(code:string):never=>{throw new HttpError(503,'Expedition collection is temporarily unavailable; try loading your base again',code);};
export interface AdvancedExpeditionGameplayProvider {
 readonly collectForBaseRead:(wallet:string,requestedBaseId?:string)=>Promise<string|null>;
 readonly collectForBaseReadPresentation?:(wallet:string,requestedBaseId?:string)=>Promise<{baseId:string|null;events:FleetJourneyEvent[]}>;
}
export function createAdvancedExpeditionGameplay(db:Db,dependencies:{finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null}={}):AdvancedExpeditionGameplayProvider{
 if('rollback'in db)held('ADVANCED_COLLECTION_TOP_LEVEL');
 const workflow=createAdvancedExpeditionWorkflow(db,{
  finalizedDeedReader:dependencies.finalizedDeedReader??null,deedCollection:dependencies.deedCollection??null,
 });
 const collectBase=async(wallet:string,requestedBaseId:string|undefined,presentation:boolean):Promise<{baseId:string|null;events:FleetJourneyEvent[]}>=>{
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);requestedBaseId=query.parse({baseId:requestedBaseId}).baseId;
  // Even an empty selection must not turn a runtime LOGIN into an owner writer.
  const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_expeditions'::regclass) allowed`);
  if(!owner?.allowed)held('ADVANCED_COLLECTION_OWNER');
  let selected;try{selected=await resolveActiveBase(db,wallet,requestedBaseId);}
  catch(error){
   // The unchanged canonical handler owns its existing multi-base client error.
   if(!requestedBaseId&&error instanceof HttpError&&error.code==='BASE_ID_REQUIRED')return {baseId:null,events:[]};
   throw error;
  }
  if(!selected)return {baseId:null,events:[]}; // First-base creation belongs to the ordinary handler.
  const baseId=selected.base.id;
  if(presentation){
   const result=await workflow.collectWithPresentation(wallet,baseId);
   if(result.collection.baseId!==baseId)held('ADVANCED_COLLECTION_IDENTITY');
   return {baseId,events:matchFleetJourneyEventBatch({version:1,events:result.events},baseId).events};
  }
  await workflow.collect(wallet,baseId);
  return {baseId,events:[]};
 };
 return Object.freeze({
  collectForBaseRead:async(wallet:string,requestedBaseId?:string)=>(await collectBase(wallet,requestedBaseId,false)).baseId,
  collectForBaseReadPresentation:(wallet:string,requestedBaseId?:string)=>collectBase(wallet,requestedBaseId,true),
 });
}

/** Register before game routes, after which each route's auth/land hooks still
 * run first. Never nest the owner transaction inside the runtime base handler. */
export function registerAdvancedExpeditionGameplay(app:FastifyInstance,provider?:AdvancedExpeditionGameplayProvider|null):void{
 if(!provider)return;const collect=provider.collectForBaseRead.bind(provider);
 const presentation=provider.collectForBaseReadPresentation?.bind(provider);
 const pending=new WeakMap<object,{wallet:string;baseId:string;events:FleetJourneyEvent[]}>();
 app.addHook('onRoute',options=>{
  if(options.url!=='/base'||!(Array.isArray(options.method)?options.method.includes('GET'):options.method==='GET'))return;
  const previous=options.preHandler?(Array.isArray(options.preHandler)?options.preHandler:[options.preHandler]):[];
  options.preHandler=[...previous,async(req)=>{
   if(req.method!=='GET'||!req.wallet||!multiBaseEnabled())return;
   const {baseId}=parse(query,req.query??{});
   let selected;try{
    if(presentation){
     const result=await presentation(req.wallet,baseId);selected=result.baseId;
     if(selected&&result.events.length)pending.set(req,{wallet:req.wallet,baseId:selected,
      events:matchFleetJourneyEventBatch({version:1,events:result.events},selected).events});
    }else selected=await collect(req.wallet,baseId);
   }catch(error){if(error instanceof HttpError)throw error;held('ADVANCED_COLLECTION_HELD');}
   // Pin omitted single-base resolution: a concurrent slot change must never
   // select a different base after this one's return has committed.
   if(selected)req.query={...(req.query as Record<string,unknown>),baseId:selected};
  }];
  const sends=options.onSend?(Array.isArray(options.onSend)?options.onSend:[options.onSend]):[];
  options.onSend=[...sends,async(req,reply,payload)=>{
   const observed=pending.get(req);pending.delete(req);
   if(!observed||reply.statusCode!==200||typeof payload!=='string')return payload;
   const body:unknown=JSON.parse(payload);
   const scope=z.object({baseId:z.string(),player:z.object({wallet:z.string()}).passthrough(),
    advancedServicePresentation:RaidAdvancedPresentationSchema.nullish(),advancedFleetIdentity:AdvancedFleetIdentitySchema.nullish(),
    fleetJourneyEvents:z.unknown().optional()}).passthrough().safeParse(body);
   if(!scope.success||scope.data.baseId!==observed.baseId||scope.data.player.wallet!==observed.wallet)return payload;
   // A later departure/service/read refusal suppresses the older visual callback.
   // Only the same current family/tier, still at this berth, may animate arrival — AND (continuity) the event's installation must
   // be the SAME current installed reservation identity of this very response. No separate fleet read or transient event fills
   // a missing identity: without it, no advanced return animates.
   const identity=scope.data.advancedFleetIdentity??null;
   const events=observed.events.filter(event=>event.kind==='return'&&event.vehicle.family!=='starter'
    &&scope.data.advancedServicePresentation?.berths.some(berth=>berth.buildingId===event.berthId
     &&berth.installation?.family===event.vehicle.family&&'tier'in event.vehicle&&berth.installation.tier===event.vehicle.tier
     &&berth.installation.presence!=='away')
    &&identity!==null&&identity.berths.some(berth=>berth.buildingId===event.berthId&&berth.installation!==null
     &&berth.installation.installationId===event.installationId&&berth.installation.family===event.vehicle.family
     &&'tier'in event.vehicle&&berth.installation.tier===event.vehicle.tier));
   if(!events.length)return payload;
   const prior=scope.data.fleetJourneyEvents===undefined?[]:matchFleetJourneyEventBatch(scope.data.fleetJourneyEvents,observed.baseId).events;
   return JSON.stringify({...scope.data,fleetJourneyEvents:matchFleetJourneyEventBatch({version:1,events:[...prior,...events]},observed.baseId)});
  }];
 });
}

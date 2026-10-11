/** Private owner capability. Original history binds its actor; current views bind
 * current custody and disclose only rendering facts, never previous consent. */
import {sql} from 'drizzle-orm';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {BoundCosmeticWakeOriginalQuerySchema,BoundCosmeticWakeCurrentQuerySchema,
 BoundCosmeticWakeOriginalEnvelopeSchema,BoundCosmeticWakeCurrentEnvelopeSchema,
 type BoundCosmeticWakeKind,type BoundCosmeticWakeCapture} from '@shardkeep/shared/boundCosmeticWakePresentation';
import type {Db} from '../db/client';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {readOwnedStarterExpedition,readStarterExpedition,type AcceptedStarterExpedition} from './starterExpeditionDispatch';
import {readOwnedAdvancedExpedition,readAdvancedExpedition,type AcceptedAdvancedExpedition} from './advancedExpeditionDispatch';
import {readStarterExpeditionReturn} from './starterExpeditionReturns';
import {readAdvancedExpeditionReturn} from './advancedExpeditionReturns';
import {readStarterFleetView} from './starterFleetView';
import {readLockedVehicleLifecycle} from './vehicleLifecycle';
import {boundCosmeticWakeFields,boundCosmeticOriginalWakeFields} from './boundCosmeticWakePresentation';

const held=():never=>{throw new HttpError(503,'Expedition appearance is temporarily unavailable','BOUND_COSMETIC_WAKE_UNAVAILABLE');};
const missing=():never=>{throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');};
function facts(row:AcceptedStarterExpedition|AcceptedAdvancedExpedition,wake:BoundCosmeticWakeCapture){
 return {expeditionId:row.id,installationId:row.installationId,homeRealmId:row.homeEvidence.realmId,realmId:row.routeSnapshot.realmId,
  departedAt:row.departedAt.toISOString(),returnsAt:row.returnsAt.toISOString(),wake};
}
export function createBoundCosmeticWakeViews(db:Db,dependencies:{finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null}={}){
 if('rollback'in db)held();
 const reader=dependencies.finalizedDeedReader??null,collection=dependencies.deedCollection??null;
 async function owner(){const [row]=await db.execute<{allowed:boolean}>(sql`select current_user=session_user and not exists(
  select 1 from pg_class where oid in('public.starter_expeditions'::regclass,'public.advanced_expeditions'::regclass,
   to_regclass('public.bound_cosmetic_starter_wakes'),to_regclass('public.bound_cosmetic_advanced_wakes')) and relowner<>current_user::regrole::oid) allowed`);
  if(!row?.allowed)held();}
 async function original(wallet:string,kind:BoundCosmeticWakeKind,key:string){
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);({kind,key}=BoundCosmeticWakeOriginalQuerySchema.parse({kind,key}));await owner();
  return db.transaction(async tx=>{
   const row=kind==='starter'?await readOwnedStarterExpedition(tx,wallet,key):await readOwnedAdvancedExpedition(tx,wallet,key);
   const scope={version:1,wallet,kind,key,serverNow:new Date().toISOString()};
   if(!row)return BoundCosmeticWakeOriginalEnvelopeSchema.parse({...scope,status:'unknown',presentation:null,returnedAt:null});
   const proof=kind==='starter'?await readStarterExpeditionReturn(tx,key):await readAdvancedExpeditionReturn(tx,key);
   const captured=await boundCosmeticOriginalWakeFields(tx,kind,key);
   return BoundCosmeticWakeOriginalEnvelopeSchema.parse({...scope,status:'known',presentation:{...facts(row,captured.boundCosmeticWake??{state:'legacy',visual:null}),baseId:row.baseId},
    returnedAt:proof?.receipt.returnedAt.toISOString()??null});
  },{isolationLevel:'repeatable read',accessMode:'read only'});
 }
 async function current(wallet:string,baseId:string){
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);({baseId}=BoundCosmeticWakeCurrentQuerySchema.parse({baseId}));await owner();
  await requireFreshBaseAuthority(db,wallet,baseId,reader,collection);
  return db.transaction(async tx=>{
   const [player]=await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);if(!player)missing();
   const [base]=await tx.execute(sql`select id from public.bases where id=${baseId} and owner_wallet=${wallet} and status='active' for update`);if(!base)missing();
   const [slot]=await tx.execute(sql`select base_id from public.base_slots where base_id=${baseId} and wallet=${wallet} and active for update`);if(!slot)missing();
   await assertFreshLockedBaseAuthority(tx,wallet,baseId);
   // Scan originals as well as active pointers: missing/misbound pointers cannot
   // turn a genuine unreturned trip into an apparently empty fleet.
   const active=await tx.execute<{kind:BoundCosmeticWakeKind;id:string;installation_id:string;active_id:string|null;active_base:string|null;returned:boolean}>(sql`
    select 'starter'::text kind,e.id,e.installation_id,f.installation_id active_id,e.base_id active_base,r.expedition_id is not null returned
     from public.starter_expeditions e left join public.starter_expedition_inflight f on f.expedition_id=e.id
     left join public.starter_expedition_returns r on r.expedition_id=e.id where e.base_id=${baseId} and (r.expedition_id is null or f.expedition_id is not null)
    union all select 'advanced'::text kind,e.id,e.installation_id,f.installation_id active_id,f.base_id active_base,r.expedition_id is not null returned
     from public.advanced_expeditions e left join public.advanced_expedition_inflight f on f.expedition_id=e.id
     left join public.advanced_expedition_returns r on r.expedition_id=e.id where e.base_id=${baseId} and (r.expedition_id is null or f.expedition_id is not null)
    order by kind,id`);
   const trips=[];
   for(const item of active){
    if(item.returned||item.active_id!==item.installation_id||item.active_base!==baseId)held();
    const row=item.kind==='starter'?await readStarterExpedition(tx,item.id):await readAdvancedExpedition(tx,item.id);
    if(!row||row.baseId!==baseId||row.installationId!==item.installation_id)held();
    const returned=item.kind==='starter'?await readStarterExpeditionReturn(tx,item.id):await readAdvancedExpeditionReturn(tx,item.id);if(returned)held();
    if(item.kind==='starter'){
     const fleet=await readStarterFleetView(tx,baseId);if(fleet.installation?.installationId!==item.installation_id)held();
    }else{const installation=await readLockedVehicleLifecycle(tx,item.installation_id);if(!installation||installation.baseId!==baseId||!installation.away)held();}
    const captured=await boundCosmeticWakeFields(tx,item.kind,item.id);
    trips.push({...facts(row!,captured.boundCosmeticWake??{state:'legacy',visual:null}),kind:item.kind});
   }
   await assertFreshLockedBaseAuthority(tx,wallet,baseId);
   return BoundCosmeticWakeCurrentEnvelopeSchema.parse({version:1,wallet,baseId,serverNow:new Date().toISOString(),trips});
  },{isolationLevel:'read committed'});
 }
 return Object.freeze({original,current});
}
export type BoundCosmeticWakeViews=ReturnType<typeof createBoundCosmeticWakeViews>;

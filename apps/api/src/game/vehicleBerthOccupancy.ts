/** D-153.130: current owner sees occupied berths, never private burn journals.
 * Permanent reservations remain occupied when new admissions are paused. */
import {BASE_OWNERSHIP} from '@shardkeep/shared';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {and,desc,eq,sql} from 'drizzle-orm';
import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {multiBaseEnabled} from '../config';
import type {Db} from '../db/client';
import {bases,deedOwnershipObservations} from '../db/schema';
import {HttpError} from '../lib/errors';
import {requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
export interface VehicleBerthOccupancyProvider {occupiedBerthIds(wallet:string,baseId:string):Promise<readonly string[]>}
const fail=(code:string):never=>{throw new HttpError(code==='BASE_NOT_OWNED'?404:503,code,code);};
export function createVehicleBerthOccupancyProvider(db:Db,dependencies:{finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null}={}):VehicleBerthOccupancyProvider{
 if('rollback'in db)fail('VEHICLE_BERTH_VIEW_TOP_LEVEL');const reader=dependencies.finalizedDeedReader??null,collection=dependencies.deedCollection??null;
 return Object.freeze({occupiedBerthIds:async(wallet:string,baseId:string):Promise<readonly string[]>=>{
  wallet=PhaseEVehicleMintIdentitySchema.shape.assetId.parse(wallet);baseId=z.uuid().parse(baseId);
  const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_activation_reservations'::regclass) allowed`);if(!owner?.allowed)fail('VEHICLE_BERTH_VIEW_OWNER');
  await requireFreshBaseAuthority(db,wallet,baseId,reader,collection);
  // A READ, so ONE repeatable-read, read-only snapshot and NO row locks. The
  // `for update nowait` re-read it replaced made the native cold start's
  // concurrent GET /base + GET /starter-fleet refuse each other with
  // VEHICLE_BERTH_VIEW_HELD (field 2026-10-06), and could fail a writer too.
  // What the view still guarantees: berth ids reach only the wallet that, in
  // this one snapshot, has its player row, owns the active base, holds an active
  // slot and passes assertFreshLockedBaseAuthority's deed policy (no pending-mint
  // quarantine; latest finalized `owned` proof for this wallet at most
  // BASE_OWNERSHIP.mutationFreshnessMs old). Authority and reservations come from
  // the same snapshot, so the answer never straddles a transfer or reservation.
  // Writers keep their own player -> base -> slot `for update [nowait]`
  // serialization; this view neither starts gameplay nor changes a reservation
  // (read only is enforced by PostgreSQL). Reads remain possible while raided.
  return db.transaction(async tx=>{
   const [player]=await tx.execute(sql`select wallet from players where wallet=${wallet}`);if(!player)fail('BASE_NOT_OWNED');
   const [base]=await tx.select({deedAssetId:bases.deedAssetId,deedMintAssetId:bases.deedMintAssetId}).from(bases).where(and(eq(bases.id,baseId),eq(bases.ownerWallet,wallet),eq(bases.status,'active')));if(!base)fail('BASE_NOT_OWNED');
   const [slot]=await tx.execute(sql`select base_id from base_slots where base_id=${baseId} and wallet=${wallet} and active`);if(!slot)fail('BASE_NOT_OWNED');
   if(!base!.deedAssetId&&base!.deedMintAssetId)fail('DEED_AUTHORITY_UNAVAILABLE');
   if(base!.deedAssetId){
    const [latest]=await tx.select().from(deedOwnershipObservations).where(and(eq(deedOwnershipObservations.baseId,baseId),eq(deedOwnershipObservations.assetId,base!.deedAssetId))).orderBy(desc(deedOwnershipObservations.checkedAt)).limit(1);
    const fresh=latest?.slot!==null&&latest?.slot!==undefined&&latest.status==='owned'&&latest.owner===wallet&&Date.now()-latest.checkedAt.getTime()<=BASE_OWNERSHIP.mutationFreshnessMs;
    if(!fresh)fail('DEED_AUTHORITY_UNAVAILABLE');
   }
   const rows=await tx.execute<{berth_id:string}>(sql`select berth_id from vehicle_activation_reservations where base_id=${baseId} order by berth_id`);
   return rows.map(row=>row.berth_id);
  },{isolationLevel:'repeatable read',accessMode:'read only'});
 }});
}
function record(value:unknown):value is Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value);}
/** Mount before canonical game/starter routes. Earlier serialization hooks are
 * preserved; no route gains access to owner DB, identity registry or receipts. */
export function registerVehicleBerthOccupancy(app:FastifyInstance,provider?:VehicleBerthOccupancyProvider|null):void{
 if(!provider)return;const occupied=provider.occupiedBerthIds.bind(provider);
 app.addHook('onRoute',options=>{
  if(!['/base','/starter-fleet'].includes(options.url)||!(Array.isArray(options.method)?options.method.includes('GET'):options.method==='GET'))return;
  const previous=options.preSerialization?(Array.isArray(options.preSerialization)?options.preSerialization:[options.preSerialization]):[];
  options.preSerialization=[...previous,async(req,reply,payload)=>{
   if(req.method!=='GET'||reply.statusCode<200||reply.statusCode>=300||!req.wallet||!multiBaseEnabled()||!record(payload)||typeof payload.baseId!=='string')return payload;
   const fleet=options.url==='/base'?payload.starterFleet:payload;
   if(!record(fleet)||!Array.isArray(fleet.eligibleBerths))return payload;
   let ids:readonly string[];try{ids=await occupied(req.wallet,payload.baseId);}catch{throw new HttpError(503,'Fleet berths are temporarily unavailable; try loading them again','VEHICLE_BERTH_VIEW_HELD');}
   const unavailable=new Set(ids),eligibleBerths=fleet.eligibleBerths.filter(berth=>record(berth)&&typeof berth.berthId==='string'&&!unavailable.has(berth.berthId));
   return options.url==='/base'?{...payload,starterFleet:{...fleet,eligibleBerths}}:{...payload,eligibleBerths};
  }];
 });
}

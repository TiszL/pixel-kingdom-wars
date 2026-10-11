/** D153.182 original vehicle client composition. Existing immutable owners retain
 * reservation/effect authority; current readiness never rewrites that history. */
import {readVehicleCandidateProvenance} from './vehicleCraftClient';
import {ORDINARY_ROUTE_IDS} from '@shardkeep/shared/ordinaryRoutes';
import {PHASE_E_ORDINARY_ROUTES,PHASE_E_ADVANCED_EXPEDITIONS} from '@shardkeep/shared';
import {VehicleRoutePolicyVersionSchema} from '@shardkeep/shared/vehicleClientApi';
import {PHASE_E_VEHICLE_CLIENT as C} from '@shardkeep/shared';
import {VehicleClientSchema,VehicleReferenceSchema,VehicleInstallationRequestSchema,VehicleReviewSchema,VehicleDeliverySchema,VehicleActivityPageSchema,VehicleAssetPageSchema,VehicleAssetPageV2Schema,VehicleRoutesSchema,vehicleReference,type VehicleClient,type VehicleReference,type VehicleReview,type VehicleDelivery} from '@shardkeep/shared/vehicleClientApi';
import {VehicleServiceRequestSchema} from '@shardkeep/shared/vehicleServiceApi';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {advancedExpeditionPreview,AdvancedExpeditionRouteIdSchema} from '@shardkeep/shared/phaseEAdvancedExpeditions';
import {createVehicleClientCurrent,VehicleClientCurrentError,type VehicleClientCurrentRpc,type VehicleClientCurrentSaved} from '@shardkeep/chain/vehicle-client-current';
import type {VehicleBurnCoreTrust,VehicleBurnOwnerAnchor} from '@shardkeep/chain/vehicle-burn-finality';
import {and,eq,sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db} from '../db/client';
import {bases,baseSlots} from '../db/schema';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {createVehicleWorkflow,type VehicleWorkflowDependencies} from './vehicleWorkflow';
import {createVehicleServiceWorkflow,type VehicleServiceWorkflowDependencies} from './vehicleServiceWorkflow';
import {createVehicleBurnPreparations} from './vehicleBurnPreparations';
import {createVehicleServiceBurnPreparations} from './vehicleServiceBurnPreparations';
import {createVehicleBurnSignedStore} from './vehicleBurnSignedStore';
import {createVehicleServiceBurnSignedStore} from './vehicleServiceBurnSignedStore';
import {createVehicleServiceApplications,type VehicleServiceApplicationProof} from './vehicleServiceApplications';
import type {VehicleInstallationProof} from './vehicleInstallations';
import {createAdvancedFleetView} from './advancedFleetView';
import {createAdvancedExpeditionWorkflow,type AdvancedExpeditionWorkflowDependencies} from './advancedExpeditionWorkflow';
import {readExpeditionHomePreview} from './expeditionHome';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';

export interface VehicleClientDependencies {
 installation?:VehicleWorkflowDependencies;service?:VehicleServiceWorkflowDependencies;
 current?:{connect:(signal:AbortSignal)=>VehicleClientCurrentRpc;trust:VehicleBurnCoreTrust};
 finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null;
 expeditions?:AdvancedExpeditionWorkflowDependencies;
}
const walletSchema=PhaseEVehicleMintIdentitySchema.shape.assetId;
const cursorSchema=z.object({version:z.literal(1),wallet:walletSchema,lane:z.enum(['activity','assets','assets-v2']),kind:z.enum(['expedition','installation','service']).optional(),id:z.string().min(1).max(44)}).strict();
const held=():never=>{throw new HttpError(503,'Original vehicle history is unavailable; keep its saved identity','VEHICLE_CLIENT_HISTORY_HELD');};
function parsed<T>(schema:z.ZodType<T>,raw:unknown):T{const result=schema.safeParse(raw);return result.success?result.data:held();}
const consent=(a:VehicleBurnOwnerAnchor)=>({genesisHash:a.genesisHash,anchorSlot:a.slot,reviewedDeploymentSlot:a.reviewedDeploymentSlot,reviewedProgramDataSha256:a.reviewedProgramDataSha256});
const receipt=(p:VehicleInstallationProof|VehicleServiceApplicationProof)=>({signature:p.signature,messageSha256:p.originalMessageSha256,wireSha256:p.signedTransactionSha256,slot:p.slot,finalizedThroughSlot:p.finalizedThroughSlot,feeLamports:p.feeLamports,assetRefundLamports:p.assetRefundLamports});
function decodeCursor(raw:string|undefined,wallet:string,lane:'activity'|'assets'|'assets-v2'){
 if(raw===undefined)return null;
 try{if(raw.length>256||!raw.length)throw Error();const bytes=Buffer.from(raw,'base64url');if(bytes.toString('base64url')!==raw)throw Error();const value=cursorSchema.parse(JSON.parse(bytes.toString('utf8')));if(value.wallet!==wallet||value.lane!==lane||lane==='activity'&&!value.kind||lane!=='activity'&&value.kind)throw Error();if(lane==='activity')z.uuid().parse(value.id);else walletSchema.parse(value.id);return value;}
 catch{throw new HttpError(400,'Vehicle page cursor is invalid','VEHICLE_CLIENT_CURSOR');}
}
function nextCursor(wallet:string,lane:'activity'|'assets'|'assets-v2',id:string,kind?:'expedition'|'installation'|'service'){return Buffer.from(JSON.stringify({version:1,wallet,lane,...kind?{kind}:{},id})).toString('base64url');}
function currentReason(error:unknown):NonNullable<VehicleReview['reason']>{
 const code=error instanceof VehicleClientCurrentError?error.code:'';
 if(['NOT_PREPARED','TERMINAL','PAUSED','OWNERSHIP','EXPIRED_UNRESOLVED','INSUFFICIENT_SOL','FEE_LIMIT','OBSERVED_TRANSACTION','TIMEOUT','BUSY'].includes(code))return code as NonNullable<VehicleReview['reason']>;
 return code==='IDENTITY'?'IDENTITY':'PROVIDER_UNAVAILABLE';
}
export function createVehicleClient(db:Db,dependencies:VehicleClientDependencies={}){
 if('rollback'in db)held();
 // Copy mutable trust before any await. Dependency methods are private closures,
 // never selected from request bodies or from an unsigned client envelope.
 const ownership={finalizedDeedReader:dependencies.finalizedDeedReader??null,deedCollection:dependencies.deedCollection??null};
 const installDeps=dependencies.installation?{...dependencies.installation,...dependencies.installation.trust?{trust:{...dependencies.installation.trust}}:{}}:{};
 const serviceDeps=dependencies.service?{...dependencies.service,...dependencies.service.trust?{trust:{...dependencies.service.trust}}:{}}:{};
 const installation=createVehicleWorkflow(db,{...ownership,...installDeps}),service=createVehicleServiceWorkflow(db,{...ownership,...serviceDeps});
 const initialPreparations=createVehicleBurnPreparations(db),servicePreparations=createVehicleServiceBurnPreparations(db);
 const initialSigned=createVehicleBurnSignedStore(db),serviceSigned=createVehicleServiceBurnSignedStore(db),applications=createVehicleServiceApplications(db);
 const fleet=createAdvancedFleetView(db,ownership),expeditions=createAdvancedExpeditionWorkflow(db,{...ownership,...dependencies.expeditions});
 async function owner(){const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.vehicle_activation_reservations'::regclass) allowed`);if(!row?.allowed)held();}
 async function read(actor:string,raw:VehicleReference):Promise<VehicleClient>{
  actor=walletSchema.parse(actor);const reference=VehicleReferenceSchema.parse(raw);
  if(reference.kind==='service'){
   const record=await service.read(actor,reference.id),p=record.preparation?await servicePreparations.get(actor,reference.id):null,a=record.application?await applications.get(actor,reference.id):null;
   if(record.preparation&&!p||record.application&&!a)held();
   return parsed(VehicleClientSchema,{version:1,kind:'service',record,consentSource:p?consent(p.anchor):null,burnReceipt:a?receipt(a.proof):null});
  }
  const old=await installation.read(actor,reference.id),r=old.reservation,p=old.preparation;
  const [registry]=await db.execute<{collection:string;family:string;tier:number}>(sql`select collection,family,tier from public.vehicle_mint_registry where asset_id=${r.assetId}`);
  if(!registry||registry.family!==r.family||registry.tier!==r.tier)held();
  const [graph]=await db.execute<{wire:boolean;consumption:boolean;installation:boolean}>(sql`select exists(select 1 from public.vehicle_burn_signed_wires where reservation_id=${r.id}) wire,exists(select 1 from public.vehicle_burn_consumptions where reservation_id=${r.id}) consumption,exists(select 1 from public.advanced_vehicle_installations where reservation_id=${r.id}) installation`);
  // The old reader starts at consumption. A missing consumption must not hide
  // its surviving installation and advertise an unfinished burn for that asset.
  if(!graph||graph.consumption!==graph.installation||!p&&(graph.wire||graph.consumption||graph.installation))held();
  const identity={assetId:r.assetId,collection:registry!.collection,family:r.family,tier:r.tier};
  if(p&&(p.plan.identity.assetId!==identity.assetId||p.plan.identity.collection!==identity.collection||p.plan.identity.family!==identity.family||p.plan.identity.tier!==identity.tier))held();
  const a=old.installation,w=old.signed;
  return parsed(VehicleClientSchema,{version:1,kind:'installation',record:{version:1,purpose:'vehicle_installation',wallet:actor,idempotencyKey:r.idempotencyKey,serverNow:new Date().toISOString(),status:old.status,
   reservation:{reservationId:r.id,wallet:r.wallet,request:{baseId:r.baseId,berthId:r.berthId,assetId:r.assetId,idempotencyKey:r.idempotencyKey},identity,completedBuildJobId:r.completedBuildJobId,berthCompletedAt:r.berthCompletedAt,reservedAt:r.reservedAt},
   preparation:p?{messageHex:p.messageHex,messageSha256:p.messageSha256,blockhash:p.plan.blockhash,blockhashContextSlot:p.blockhashContextSlot,lastValidBlockHeight:p.lastValidBlockHeight,recordedAt:p.recordedAt}:null,
   signed:w?{signature:w.signature,wireSha256:w.wireSha256,messageSha256:w.messageSha256,acceptedAt:w.acceptedAt}:null,
   installation:a?{installationId:a.reservationId,baseId:a.baseId,berthId:a.berthId,assetId:a.assetId,family:a.family,tier:a.tier,installedWallet:a.installedWallet,installedAt:a.installedAt,signature:a.proof.signature}:null,
   signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false,installationAuthorized:false},consentSource:p?consent(p.anchor):null,burnReceipt:a?receipt(a.proof):null});
 }
 async function readByKey(actor:string,kind:VehicleReference['kind'],key:string){
  actor=walletSchema.parse(actor);key=z.string().min(1).max(128).parse(key);
  if(kind==='installation'){const value=await installation.readByKey(actor,key);return read(actor,{kind,id:value.reservation.id});}
  if(kind!=='service')held();const value=await service.readByKey(actor,key);return read(actor,{kind,id:value.intent.intentId});
 }
 async function reserve(actor:string,kind:VehicleReference['kind'],request:unknown){
  actor=walletSchema.parse(actor);
  if(kind==='installation'){const value=await installation.reserve(actor,VehicleInstallationRequestSchema.parse(request));return read(actor,{kind,id:value.reservation.id});}
  if(kind!=='service')held();const value=await service.reserve(actor,VehicleServiceRequestSchema.parse(request));return read(actor,{kind,id:value.intent.intentId});
 }
 async function prepare(actor:string,reference:VehicleReference){const saved=await read(actor,reference),ref=vehicleReference(saved);await (ref.kind==='installation'?installation:service).prepare(actor,ref.id);return read(actor,ref);}
 async function retainSigned(actor:string,reference:VehicleReference,bytes:Uint8Array){const copied=Uint8Array.from(bytes),saved=await read(actor,reference),ref=vehicleReference(saved);await (ref.kind==='installation'?installation:service).retainSigned(actor,ref.id,copied);return read(actor,ref);}
 async function recover(actor:string,reference:VehicleReference){const saved=await read(actor,reference),ref=vehicleReference(saved);await (ref.kind==='installation'?installation:service).recover(actor,ref.id);return read(actor,ref);}
 async function loadCurrent(reference:VehicleReference):Promise<VehicleClientCurrentSaved>{
  const ref=VehicleReferenceSchema.parse(reference);await owner();
  const [original]=ref.kind==='installation'?await db.execute<{wallet:string}>(sql`select wallet from public.vehicle_activation_reservations where id=${ref.id}`):await db.execute<{wallet:string}>(sql`select wallet from public.vehicle_service_intents where id=${ref.id}`);
  if(!original)held();const actor=original!.wallet,saved=await read(actor,ref);
  if(saved.burnReceipt)return {status:'terminal'};if(!phaseEVehiclesEnabled())return {status:'paused'};
  if(ref.kind==='installation'){
   const p=await initialPreparations.get(actor,ref.id);if(!p)return null;const w=await initialSigned.get(actor,ref.id);
   return {status:'prepared',kind:'installation',plan:p.plan,preparedMessageBytes:Buffer.from(p.messageHex,'hex'),anchor:p.anchor,blockhashContextSlot:p.blockhashContextSlot,lastValidBlockHeight:p.lastValidBlockHeight,signedTransaction:w?Buffer.from(w.signedTransactionHex,'hex'):null};
  }
  const p=await servicePreparations.get(actor,ref.id);if(!p)return null;const w=await serviceSigned.get(actor,ref.id);
  return {status:'prepared',kind:'service',plan:p.plan,preparedMessageBytes:Buffer.from(p.messageHex,'hex'),anchor:p.anchor,blockhashContextSlot:p.blockhashContextSlot,lastValidBlockHeight:p.lastValidBlockHeight,signedTransaction:w?Buffer.from(w.signedTransactionHex,'hex'):null};
 }
 const current=dependencies.current?createVehicleClientCurrent(dependencies.current.connect.bind(dependencies.current),{...dependencies.current.trust},loadCurrent):null;
 async function review(actor:string,reference:VehicleReference):Promise<VehicleReview>{
  const saved=await read(actor,reference),ref=vehicleReference(saved),at=Date.now(),base={version:1,reference:ref,wallet:actor,messageSha256:saved.record.preparation?.messageSha256??null,reviewedAt:new Date(at).toISOString(),expiresAt:new Date(at+C.reviewMaxAgeMs).toISOString(),signingAuthorized:false,broadcastAuthorized:false,reservationReleaseAuthorized:false};
  let reason:NonNullable<VehicleReview['reason']>|null=saved.burnReceipt?'TERMINAL':!phaseEVehiclesEnabled()?'PAUSED':!saved.record.preparation?'NOT_PREPARED':!current?'PROVIDER_UNAVAILABLE':null;
  if(reason)return parsed(VehicleReviewSchema,{...base,status:'held',reason,observation:null});
  try{const observation=await current!.review(ref);if(Date.now()-at>C.reviewMaxAgeMs)throw new VehicleClientCurrentError('TIMEOUT');return parsed(VehicleReviewSchema,{...base,status:'ready',reason:null,observation});}
  catch(error){reason=currentReason(error);return parsed(VehicleReviewSchema,{...base,status:'held',reason,observation:null});}
 }
 async function deliver(actor:string,reference:VehicleReference):Promise<VehicleDelivery>{
  let client=await read(actor,reference);const ref=vehicleReference(client);
  const result=(status:VehicleDelivery['status'],reason:VehicleDelivery['reason']=null)=>parsed(VehicleDeliverySchema,{version:1,reference:ref,status,reason,signature:client.record.signed?.signature??client.burnReceipt?.signature??null,client,broadcastAuthorized:false,reservationReleaseAuthorized:false});
  if(client.burnReceipt)return result('terminal');if(!client.record.signed)return result('held','NOT_SIGNED');if(!phaseEVehiclesEnabled())return result('held','PAUSED');if(!current)return result('held','PROVIDER_UNAVAILABLE');
  try{const submitted=await current.deliver(ref);client=await read(actor,ref);if(client.burnReceipt)return result('terminal');if(client.record.signed?.signature!==submitted.signature)held();return result('submitted');}
  catch(error){client=await read(actor,ref);if(client.burnReceipt)return result('terminal');const code=error instanceof VehicleClientCurrentError?error.code:'';if(code==='SEND_UNCERTAIN')return result('held','SEND_UNCERTAIN');if(code==='NOT_SIGNED')return result('held','NOT_SIGNED');const reason=currentReason(error);if(reason==='OBSERVED_TRANSACTION')return result('observed');return result('held',reason==='TERMINAL'||reason==='NOT_PREPARED'?'IDENTITY':reason);}
 }
 async function activity(actor:string,cursor?:string){
  actor=walletSchema.parse(actor);const from=decodeCursor(cursor,actor,'activity');await owner();
  const rows=await db.execute<{kind:'expedition'|'installation'|'service';id:string}>(sql`select kind,id from (select 'installation'::text kind,id,wallet from public.vehicle_activation_reservations union all select 'service'::text kind,id,wallet from public.vehicle_service_intents union all select 'expedition'::text kind,id,actor_wallet wallet from public.advanced_expeditions) originals where wallet=${actor} ${from?sql`and (kind collate "C">${from.kind} or (kind=${from.kind} and id>${from.id}::uuid))`:sql``} order by kind collate "C",id limit ${C.discoveryPageSize+1}`);
  const page=rows.slice(0,C.discoveryPageSize),items=[];
  for(const row of page){if(row.kind==='expedition'){const saved=await expeditions.read(actor,row.id);if(!saved.receipt)held();items.push({kind:row.kind,id:row.id,idempotencyKey:saved.idempotencyKey,baseId:saved.receipt!.request.baseId,createdAt:saved.receipt!.departedAt,status:saved.return?'returned':'accepted'});}
   else{const saved=await read(actor,{kind:row.kind,id:row.id}),record=saved.record,original=saved.kind==='installation'?saved.record.reservation:saved.record.intent;items.push({kind:row.kind,id:row.id,idempotencyKey:record.idempotencyKey,baseId:saved.kind==='installation'?saved.record.reservation.request.baseId:saved.record.intent.state.baseId,createdAt:original.reservedAt,status:record.status});}}
  const last=page.at(-1);return parsed(VehicleActivityPageSchema,{version:1,wallet:actor,items,nextCursor:rows.length>C.discoveryPageSize&&last?nextCursor(actor,'activity',last.id,last.kind):null});
 }
 async function scanAssets(actor:string,cursor:string|undefined,version:1|2){
  actor=walletSchema.parse(actor);const lane=version===1?'assets':'assets-v2',from=decodeCursor(cursor,actor,lane);await owner();
  // Structural source damage is not an empty candidate page, even with no rows.
  try{await db.execute(sql`select public.shardkeep_divine_fragment_source()`);}catch{return held();}
  if(!current)throw new HttpError(503,'Current vehicle ownership is unavailable','VEHICLE_CLIENT_PROVIDER_UNAVAILABLE');
  const rows=await db.execute<{assetId:string;collection:string;family:string;tier:number}>(sql`select r.asset_id "assetId",r.collection,r.family,r.tier from public.vehicle_mint_registry r where ${version===1?sql`r.provenance='owner_attestation' and`:sql``} not exists(select 1 from public.vehicle_activation_reservations v where v.asset_id=r.asset_id) and not exists(select 1 from public.vehicle_service_intents s where s.asset_id=r.asset_id) ${from?sql`and r.asset_id collate "C">${from.id}`:sql``} order by r.asset_id collate "C" limit ${C.discoveryPageSize+1}`);
  const page=rows.slice(0,C.discoveryPageSize).map(row=>parsed(PhaseEVehicleMintIdentitySchema,row)),provenance=new Map();
  for(const identity of page)provenance.set(identity.assetId,await readVehicleCandidateProvenance(db,identity));
  let items;try{items=await current.scanCandidates({wallet:actor,identities:page});}catch{throw new HttpError(503,'Current vehicle ownership is unavailable','VEHICLE_CLIENT_PROVIDER_UNAVAILABLE');}
  const available=[];for(const item of items){const [used]=await db.execute<{used:boolean}>(sql`select exists(select 1 from public.vehicle_activation_reservations where asset_id=${item.identity.assetId}) or exists(select 1 from public.vehicle_service_intents where asset_id=${item.identity.assetId}) used`);if(!used?.used){const currentProvenance=await readVehicleCandidateProvenance(db,item.identity);if(JSON.stringify(currentProvenance)!==JSON.stringify(provenance.get(item.identity.assetId)))held();available.push({...item,provenance:currentProvenance});}}
  const next=rows.length>C.discoveryPageSize?nextCursor(actor,lane,page.at(-1)!.assetId):null;
  return version===1?parsed(VehicleAssetPageSchema,{version:1,wallet:actor,provenance:'owner-attested-registry',items:available.map(({provenance:_p,...item})=>item),nextCursor:next}):parsed(VehicleAssetPageV2Schema,{version:2,wallet:actor,items:available,nextCursor:next});
 }
 async function assets(actor:string,cursor?:string){return VehicleAssetPageSchema.parse(await scanAssets(actor,cursor,1));}
 async function assetsV2(actor:string,cursor?:string){return VehicleAssetPageV2Schema.parse(await scanAssets(actor,cursor,2));}

 async function routes(actor:string,baseId:string,policyVersion:number=PHASE_E_ADVANCED_EXPEDITIONS.v1.policyVersion){
  policyVersion=VehicleRoutePolicyVersionSchema.parse(policyVersion);
  actor=walletSchema.parse(actor);baseId=z.uuid().parse(baseId);const currentFleet=await fleet.read(actor,baseId);await requireFreshBaseAuthority(db,actor,baseId,ownership.finalizedDeedReader,ownership.deedCollection);
  return db.transaction(async tx=>{
   await tx.execute(sql`select wallet from public.players where wallet=${actor} for update`);
   const [base]=await tx.select().from(bases).where(and(eq(bases.id,baseId),eq(bases.ownerWallet,actor),eq(bases.status,'active'))).for('update');
   const [slot]=await tx.select().from(baseSlots).where(and(eq(baseSlots.baseId,baseId),eq(baseSlots.wallet,actor),eq(baseSlots.active,true))).for('update');if(!base||!slot)throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');
   await assertFreshLockedBaseAuthority(tx,actor,baseId);const home=await readExpeditionHomePreview(tx,base);
   // No authoritative expedition home (paid land whose deed is not minted yet, a retired claim) is a designed
   // state, not damaged vehicle history: no route starts here, exactly as the starter view answers `routes: []`.
   // Departure still refuses with 409 EXPEDITION_HOME_UNAVAILABLE; integrity failures still throw from the reader.
   const items=currentFleet.vehicles.map(v=>({installationId:v.installationId,previews:!home?[]:(policyVersion===PHASE_E_ORDINARY_ROUTES.policyVersion?ORDINARY_ROUTE_IDS:AdvancedExpeditionRouteIdSchema.options).flatMap(routeId=>{try{return [advancedExpeditionPreview({family:v.family,tier:v.tier,homeRealmId:home.realmId,routeId},policyVersion)];}catch{return [];}})}));
   await assertFreshLockedBaseAuthority(tx,actor,baseId);return parsed(VehicleRoutesSchema,{version:1,wallet:actor,baseId,items});
  });
 }
 return Object.freeze({reserve,read,readByKey,prepare,retainSigned,recover,review,deliver,activity,assets,assetsV2,routes});
}
export type VehicleClientProvider=ReturnType<typeof createVehicleClient>;

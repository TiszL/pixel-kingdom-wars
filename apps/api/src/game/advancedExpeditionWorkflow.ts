import {fittingSelection} from '@shardkeep/shared/phaseEOrdinaryEquipment';
/** D-153.139 closed owner capability for authenticated advanced departures,
 * original history and explicit current-owner collection. No runtime defaults. */
import {PublicKey} from '@solana/web3.js';
import {PHASE_E_PAID_STARTER_ROUTES,PHASE_E_ADVANCED_EXPEDITIONS,PHASE_E_ORDINARY_ROUTES} from '@shardkeep/shared';
import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {PaidStarterRouteIdSchema} from '@shardkeep/shared/paidStarterExpeditions';
import {AdvancedExpeditionRequestSchema,AdvancedExpeditionEnvelopeSchema} from '@shardkeep/shared/advancedExpeditionApi';
import {PhaseEVehicleMintIdentitySchema} from '@shardkeep/shared/phaseEVehicles';
import {and,eq,sql} from 'drizzle-orm';
import {bases,baseSlots} from '../db/schema';
import {readExpeditionHomePreview} from './expeditionHome';
import {OrdinaryRouteIdSchema,ordinaryRoute} from '@shardkeep/shared/ordinaryRoutes';
import {StarterHomeRouteIdSchema} from '@shardkeep/shared/phaseEExpeditions';
import {z} from 'zod';
import type {Db,DbOrTx} from '../db/client';
import {phaseEVehiclesEnabled} from '../config';
import {HttpError} from '../lib/errors';
import {assertFreshLockedBaseAuthority,requireFreshBaseAuthority,type FinalizedDeedReader} from './baseOwnership';
import {dispatchAdvancedExpeditionCommitted,readOwnedAdvancedExpedition,matchAdvancedExpeditionCommand} from './advancedExpeditionDispatch';
import {readAdvancedExpeditionReturn,settleDueAdvancedExpeditions} from './advancedExpeditionReturns';
import {readNewAdvancedReturnJourneyEvents} from './fleetJourneyPresentation';
import {prefetchOperatingExpeditionTermReader} from './operatingExpeditionTermReader';
import {ExpeditionRealmAccessError,prefetchExpeditionRealmAccessReader} from './expeditionRealmAccess';
import type {StarterExpeditionProvider,StarterExpeditionAccessProvider} from './starterExpeditionRoutes';
const uuid=z.uuid().regex(/^[0-9a-f-]+$/),walletSchema=PhaseEVehicleMintIdentitySchema.shape.assetId;
export interface AdvancedExpeditionWorkflowDependencies {
 term?:StarterExpeditionProvider|null;access?:StarterExpeditionAccessProvider|null;
 finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null;
}
const unavailable=(code:string):never=>{throw new HttpError(503,'Advanced expedition workflow is temporarily unavailable',code);};
const key=(v:PublicKey)=>new PublicKey(v.toBytes());
export function createAdvancedExpeditionWorkflow(db:Db,deps:AdvancedExpeditionWorkflowDependencies={}){
 if('rollback'in db)unavailable('ADVANCED_WORKFLOW_TOP_LEVEL');
 // Own all mutable reviewed keys before exposing the capability or awaiting RPC.
 const p=deps.term?.policy,term=p?{connect:deps.term!.connect,policy:{...p,programId:key(p.programId),config:key(p.config),mint:key(p.mint),prizeOwner:key(p.prizeOwner),prizeAta:key(p.prizeAta),genesisHash:key(p.genesisHash),deployment:{...p.deployment}}}:null;
 const a=deps.access?.trust,access=a?{connect:deps.access!.connect,trust:{...a,programId:key(a.programId),developer:key(a.developer),upgradeAuthority:a.upgradeAuthority?key(a.upgradeAuthority):null}}:null;
 const deedReader=deps.finalizedDeedReader??null,collection=deps.deedCollection??null;
 async function owner(){const [row]=await db.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_expeditions'::regclass) allowed`);if(!row?.allowed)unavailable('ADVANCED_WORKFLOW_OWNER');}
 function gate(){if(!phaseEVehiclesEnabled())throw new HttpError(503,'Advanced departures are paused','ADVANCED_DISABLED');}
 async function envelope(tx:DbOrTx,wallet:string,id:string){
  const row=await readOwnedAdvancedExpedition(tx,wallet,id),scope={wallet,idempotencyKey:id,serverNow:new Date().toISOString()};
  if(!row)return AdvancedExpeditionEnvelopeSchema.parse({...scope,status:'unknown',receipt:null,return:null});
  const returned=await readAdvancedExpeditionReturn(tx,id);
  if(!returned){const [flight]=await tx.execute<{installation_id:string;base_id:string}>(sql`select installation_id,base_id from advanced_expedition_inflight where expedition_id=${id}`);if(!flight||flight.installation_id!==row.installationId||flight.base_id!==row.baseId)unavailable('ADVANCED_HISTORY_HELD');}
  return AdvancedExpeditionEnvelopeSchema.parse({...scope,status:'accepted',receipt:{wallet,expeditionId:id,installationId:row.installationId,
   request:{idempotencyKey:id,baseId:row.baseId,installationId:row.installationId,routeId:row.routeId,policyVersion:row.policyVersion,...fittingSelection(row.routeSnapshot)},
   route:row.routeSnapshot,departedAt:row.departedAt.toISOString(),returnsAt:row.returnsAt.toISOString(),termId:row.termId,termHash:row.termHash,completedBefore:row.completedBefore.toString()},
   return:returned?{returnId:returned.receipt.id,returnedAt:returned.receipt.returnedAt.toISOString(),completedTotal:returned.receipt.completedTotal.toString(),...row.routeSnapshot.secondaryOutput?{secondaryOutput:row.routeSnapshot.secondaryOutput}:{}}:null});
 }
 async function read(wallet:string,id:string){wallet=walletSchema.parse(wallet);id=uuid.parse(id);await owner();return db.transaction(tx=>envelope(tx,wallet,id),{isolationLevel:'repeatable read',accessMode:'read only'});}
 /** Source prefetch classification only. Dispatch repeats HOME resolution under
  * its own admission locks; this preview never supplies a reusable access right. */
 async function currentHome(wallet:string,baseId:string){return db.transaction(async tx=>{
  await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
  const [base]=await tx.select().from(bases).where(and(eq(bases.id,baseId),eq(bases.ownerWallet,wallet),eq(bases.status,'active'))).for('update');
  const [slot]=await tx.select().from(baseSlots).where(and(eq(baseSlots.baseId,baseId),eq(baseSlots.wallet,wallet),eq(baseSlots.active,true))).for('update');
  if(!base||!slot)throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');
  await assertFreshLockedBaseAuthority(tx,wallet,baseId);const home=await readExpeditionHomePreview(tx,base);
  if(!home)throw new HttpError(409,'The base has no authoritative expedition home','EXPEDITION_HOME_UNAVAILABLE');
  await assertFreshLockedBaseAuthority(tx,wallet,baseId);return home.realmId;
 });}
 async function dispatchWithCreation(wallet:string,raw:unknown){
  wallet=walletSchema.parse(wallet);const request=AdvancedExpeditionRequestSchema.parse(raw),{idempotencyKey:id,...rest}=request,command={id,...rest};await owner();
  const old=await readOwnedAdvancedExpedition(db,wallet,id,true);if(old){matchAdvancedExpeditionCommand(old,wallet,command);return {created:false,envelope:await read(wallet,id)};}
  gate();if(!term)unavailable('EXPEDITION_TERM_UNAVAILABLE');
  await requireFreshBaseAuthority(db,wallet,request.baseId,deedReader,collection);
  let created:boolean;
  try{
   const paid=PaidStarterRouteIdSchema.safeParse(request.routeId);let realm:number|undefined;
   if(request.policyVersion===PHASE_E_ORDINARY_ROUTES.policyVersion){
    const named=OrdinaryRouteIdSchema.safeParse(request.routeId);if(!named.success)throw new HttpError(400,'Unknown named expedition route','ADVANCED_ROUTE');
    const destination=ordinaryRoute(named.data).realmId,home=await currentHome(wallet,request.baseId);
    if(destination!==home)realm=REALM_IDS.indexOf(destination);
   }else if(request.policyVersion===PHASE_E_ADVANCED_EXPEDITIONS.v1.policyVersion){
    if(paid.success)realm=REALM_IDS.indexOf(PHASE_E_PAID_STARTER_ROUTES.routes[paid.data]);
    else if(!StarterHomeRouteIdSchema.safeParse(request.routeId).success)throw new HttpError(400,'Unknown original expedition route','ADVANCED_ROUTE');
   }else throw new HttpError(400,'Unsupported expedition policy','ADVANCED_POLICY');
   if(realm!==undefined&&!access)throw new ExpeditionRealmAccessError('UNAVAILABLE');
   const coverage=realm===undefined?undefined:await prefetchExpeditionRealmAccessReader(access!.connect,access!.trust,{wallet,realm});
   const reader=await prefetchOperatingExpeditionTermReader(term!.connect,term!.policy);
   created=(await dispatchAdvancedExpeditionCommitted(db,wallet,command,{baseId:request.baseId,assertAuthority:async(tx,w,b)=>{await assertFreshLockedBaseAuthority(tx,w,b);}},{reader,...coverage?{readCoverage:coverage.readCoverage}:{}})).created;
  }catch(error){if(error instanceof ExpeditionRealmAccessError){const blocked=error.code==='NO_COVERAGE'||error.code==='EXPIRED';throw new HttpError(blocked?409:503,blocked?'Paid destination coverage is not active':'Paid destination coverage is unavailable',`EXPEDITION_ACCESS_${blocked?error.code:'UNAVAILABLE'}`);}throw error;}
  return {created,envelope:await read(wallet,id)};
 }
 async function dispatch(wallet:string,raw:unknown){return (await dispatchWithCreation(wallet,raw)).envelope;}
 async function collectResult(wallet:string,baseId:string,presentation:boolean){
  wallet=walletSchema.parse(wallet);baseId=uuid.parse(baseId);await owner();await requireFreshBaseAuthority(db,wallet,baseId,deedReader,collection);
  return db.transaction(async tx=>{
   // Match transfer order. Accepted earnings settle during pauses and raids;
   // this path neither admits gameplay nor exposes another actor's receipts.
   await tx.execute(sql`select wallet from players where wallet=${wallet} for update`);
   const [base]=await tx.execute(sql`select id from bases where id=${baseId} and owner_wallet=${wallet} and status='active' for update`);
   const [slot]=await tx.execute(sql`select base_id from base_slots where base_id=${baseId} and wallet=${wallet} and active for update`);
   if(!base||!slot)throw new HttpError(404,'Base not owned or inactive','BASE_NOT_OWNED');
   await assertFreshLockedBaseAuthority(tx,wallet,baseId);const at=new Date(),proofs=await settleDueAdvancedExpeditions(tx,baseId,at);
   await assertFreshLockedBaseAuthority(tx,wallet,baseId);
   const events=presentation?await readNewAdvancedReturnJourneyEvents(tx,wallet,baseId,proofs):[];
   return {collection:{baseId,serverNow:at.toISOString(),returned:proofs.length},events};
  },{isolationLevel:'read committed'});
 }
 async function collect(wallet:string,baseId:string){return (await collectResult(wallet,baseId,false)).collection;}
 async function collectWithPresentation(wallet:string,baseId:string){return collectResult(wallet,baseId,true);}
 return Object.freeze({dispatch,dispatchWithCreation,read,collect,collectWithPresentation});
}
type AdvancedExpeditionWorkflow=ReturnType<typeof createAdvancedExpeditionWorkflow>;
export type AdvancedExpeditionWorkflowProvider=Pick<AdvancedExpeditionWorkflow,'dispatch'|'read'|'collect'>
 &Partial<Pick<AdvancedExpeditionWorkflow,'dispatchWithCreation'|'collectWithPresentation'>>;

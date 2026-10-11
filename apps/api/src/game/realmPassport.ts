/** Realm Passport (D153 B7 catalogue outcome): read-only participation history
 * for the authenticated ORIGINAL actor. Each page is one repeatable-read,
 * read-only transaction over immutable source rows, and every selected row is
 * re-validated by the existing departure/return or entitlement readers. Nothing
 * here settles a trip, projects a publication, prepares, signs or grants; an
 * unavailable fact is an unavailable state with data null, never a zero. */
import {PHASE_E_DIVINE_TRIALS} from '@shardkeep/shared';
import {REALM_IDS} from '@shardkeep/shared/baseVisual';
import {RealmPassportCurrentResponseSchema,RealmPassportExpeditionsQuerySchema,RealmPassportExpeditionsResponseSchema,RealmPassportInclusionsQuerySchema,RealmPassportInclusionsResponseSchema,
 type RealmPassportCurrentResponse,type RealmPassportExpeditionRow,type RealmPassportExpeditionsResponse,type RealmPassportInclusionRow,type RealmPassportInclusionsResponse,type RealmPassportUnavailableReason} from '@shardkeep/shared/realmPassportApi';
import {decodeMiningAllocationProof} from '@shardkeep/chain/mining-allocation';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from '../db/client';
import {createMiningClaimEntitlementHistoryReader,MiningClaimEntitlementError,type MiningClaimEntitlementIdentity} from '../mining/claimEntitlement';
import type {MiningClaimAssessment} from '../mining/claimStatus';
import {readAdvancedExpeditionReturn} from './advancedExpeditionReturns';
import {readStarterExpeditionReturn} from './starterExpeditionReturns';

const PAGE=PHASE_E_DIVINE_TRIALS.discoveryPageSize;
type Reason=RealmPassportUnavailableReason;
type Kind='starter'|'advanced';
/** Configured source capabilities only: identity is the projected publication
 * domain, assess the current chain assessment. Neither is ever caller-controlled. */
export interface RealmPassportMiningCapability{identity:MiningClaimEntitlementIdentity;assess?:((wallet:string)=>Promise<MiningClaimAssessment>)|undefined}
export class RealmPassportError extends Error{constructor(readonly code:'INVALID_INPUT'){super(`Realm passport refused: ${code}`);this.name='RealmPassportError';}}
class SourceUnavailable extends Error{constructor(readonly reason:Reason){super(`Realm passport source ${reason}`);this.name='RealmPassportSourceUnavailable';}}
const conflict=()=>new SourceUnavailable('SOURCE_CONFLICT');
function need(v:unknown):asserts v{if(!v)throw conflict();}
function walletKey(value:unknown):string{
 if(typeof value!=='string'||value.length<32||value.length>44)throw new RealmPassportError('INVALID_INPUT');
 try{const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default))throw 0;return value;}catch{throw new RealmPassportError('INVALID_INPUT');}
}
/** A five-character SQLSTATE or a driver/socket code means the source could not
 * be read; a reader integrity throw (plain Error, ZodError, entitlement conflict)
 * or a SQL raise from an evidence function means the source disagrees with itself. */
function classify(error:unknown):Reason{
 if(error instanceof SourceUnavailable)return error.reason;
 if(error instanceof MiningClaimEntitlementError)return error.code==='SOURCE_CONFLICT'?'SOURCE_CONFLICT':'SOURCE_UNAVAILABLE';
 let v=error;for(let n=0;n<8&&v&&typeof v==='object';n++){
  const code=(v as {code?:unknown}).code;
  if(typeof code==='string'&&code.length>0)return /^[0-9A-Z]{5}$/.test(code)&&code!=='P0001'||!/^[0-9A-Z]{5}$/.test(code)?'SOURCE_UNAVAILABLE':'SOURCE_CONFLICT';
  v=(v as {cause?:unknown}).cause;
 }
 return 'SOURCE_CONFLICT';
}
const envelope=(wallet:string,serverNow:string)=>({version:1 as const,wallet,serverNow,projection:'history-only' as const});
const unavailable=(wallet:string,serverNow:string,reason:Reason)=>({...envelope(wallet,serverNow),state:'unavailable' as const,reason,data:null});
const SOURCES={starter:{trips:'public.starter_expeditions',returns:'public.starter_expedition_returns'},advanced:{trips:'public.advanced_expeditions',returns:'public.advanced_expedition_returns'}} as const;
const visited=z.object({realmId:z.enum(REALM_IDS)});

async function expeditionRows(tx:DbTx,wallet:string,kind:Kind,cursor:string|undefined):Promise<{rows:RealmPassportExpeditionRow[];more:boolean}>{
 if(kind==='advanced'){
  // Advanced source tables are owner-private; a non-owner service boundary has no history to show, never an empty list.
  const [owner]=await tx.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.advanced_expeditions'::regclass) allowed`);
  if(!owner?.allowed)throw new SourceUnavailable('NOT_CONFIGURED');
 }
 // Pending trips have no return row and are never selected, so nothing here can settle one.
 const ids=await tx.execute<{id:string}>(sql`select e.id from ${sql.raw(SOURCES[kind].trips)} e join ${sql.raw(SOURCES[kind].returns)} r on r.expedition_id=e.id
  where e.actor_wallet=${wallet} ${cursor===undefined?sql``:sql`and e.id>${cursor}::uuid`} order by e.id limit ${PAGE+1}`);
 const rows:RealmPassportExpeditionRow[]=[];
 for(const {id} of ids.slice(0,PAGE)){
  if(kind==='starter'){
   const proof=await readStarterExpeditionReturn(tx,id);need(proof);const e=proof.expedition,r=proof.receipt;
   need(e.id===id&&r.expeditionId===id&&e.actorWallet===wallet&&e.homeEvidence.custodyWallet===wallet);
   rows.push({kind,expeditionId:e.id,returnId:r.id,originalBaseId:e.baseId,realmId:e.routeSnapshot.realmId,routeId:e.routeId,routeVersion:e.routeVersion,policyVersion:null,
    departedAt:e.departedAt.toISOString(),scheduledReturnAt:e.returnsAt.toISOString(),returnedAt:r.returnedAt.toISOString()});
  }else{
   const proof=await readAdvancedExpeditionReturn(tx,id);need(proof);const e=proof.expedition,r=proof.receipt;
   need(e.id===id&&r.expeditionId===id&&e.actorWallet===wallet);
   rows.push({kind,expeditionId:e.id,returnId:r.id,originalBaseId:e.baseId,realmId:visited.parse(e.routeSnapshot).realmId,routeId:e.routeId,routeVersion:null,policyVersion:e.policyVersion,
    departedAt:e.departedAt.toISOString(),scheduledReturnAt:e.returnsAt.toISOString(),returnedAt:r.returnedAt.toISOString()});
  }
 }
 return {rows,more:ids.length>PAGE};
}

async function inclusionRows(tx:DbTx,wallet:string,identity:MiningClaimEntitlementIdentity,cursor:string|undefined):Promise<{rows:RealmPassportInclusionRow[];more:boolean}>{
 const listed=await tx.execute<{sequence:string}>(sql`select h.sequence::text sequence from public.mining_claim_entitlement_headers h
  join public.mining_claim_entitlement_leaves l on l.epoch_id=h.epoch_id and l.wallet=${wallet}
  where h.genesis_hash=${identity.genesisHash} and h.program_id=${identity.programId} and h.config_address=${identity.configAddress}
  ${cursor===undefined?sql``:sql`and h.sequence>${cursor}::numeric`} order by h.sequence limit ${PAGE+1}`);
 if(listed.length===0){
  // No projected publication for this identity at all (nothing projected yet, or a misconfigured domain) is
  // an unavailable source, never an empty history; a wallet absent from an existing projection is empty.
  const [projected]=await tx.execute<{present:boolean}>(sql`select exists(select 1 from public.mining_claim_entitlement_headers h
   where h.genesis_hash=${identity.genesisHash} and h.program_id=${identity.programId} and h.config_address=${identity.configAddress}) present`);
  if(!projected?.present)throw new SourceUnavailable('SOURCE_UNAVAILABLE');
 }
 const rows:RealmPassportInclusionRow[]=[];
 for(const {sequence} of listed.slice(0,PAGE)){
  // The existing historical reader re-verifies this wallet's leaf and Merkle proof against the audited header.
  const result=await createMiningClaimEntitlementHistoryReader(tx,identity,sequence)(wallet);
  need(result.kind==='entitlement');const h=result.header,leaf=result.leaf;
  need(h.sequence===sequence&&leaf.sequence===sequence&&leaf.wallet===wallet&&h.genesisHash===identity.genesisHash&&h.programId===identity.programId&&h.configAddress===identity.configAddress);
  const previous=rows[rows.length-1];
  if(previous)need(previous.keepMint===h.keepMint&&previous.reserveOwner===h.reserveOwner&&BigInt(previous.sequence)<BigInt(sequence)
   &&BigInt(previous.leaf.cumulativeKeepBaseUnits)<=BigInt(leaf.cumulativeKeep)&&BigInt(previous.leaf.cumulativeRenown)<=BigInt(leaf.cumulativeRenown)&&BigInt(previous.leaf.cumulativeDays)<=BigInt(leaf.cumulativeDays));
  const proof=decodeMiningAllocationProof(Buffer.from(result.proofHex,'hex')).map(n=>({hash:Buffer.from(n.hash).toString('hex'),sumBaseUnits:n.sum.toString(),isLeft:n.isLeft}));
  rows.push({sequence:h.sequence,day:h.day,root:h.root,sourceHash:h.sourceHash,publicationSignature:h.publicationSignature,publicationSlot:h.publicationSlot,
   genesisHash:h.genesisHash,programId:h.programId,configAddress:h.configAddress,keepMint:h.keepMint,reserveOwner:h.reserveOwner,totalCumulativeBaseUnits:h.totalCumulative,
   leaf:{wallet,sequence:leaf.sequence,cumulativeKeepBaseUnits:leaf.cumulativeKeep,cumulativeRenown:leaf.cumulativeRenown,cumulativeDays:leaf.cumulativeDays},proof});
 }
 return {rows,more:listed.length>PAGE};
}

function currentReason(reason:string|undefined):Reason{return reason==='DISABLED'?'NOT_CONFIGURED':reason==='SOURCE_CONFLICT'?'SOURCE_CONFLICT':'SOURCE_UNAVAILABLE';}
/** Only a positive current assessment (ready/delayed/paused/claimed) carrying the
 * verified entitlement and chain snapshot supplies facts; revoked, unallocated,
 * unknown or disabled assessments are unavailable, never zero. */
function currentData(wallet:string,mining:RealmPassportMiningCapability,a:MiningClaimAssessment):{state:'available';data:Extract<RealmPassportCurrentResponse,{state:'available'}>['data']}|{state:'unavailable';reason:Reason}{
 const s=a.status;
 if(s.state==='unavailable')return {state:'unavailable',reason:currentReason(s.reason)};
 const p=a.projection,snap=a.snapshot;
 if(s.state==='revoked'||s.state==='no_allocation'||!p||p.kind!=='entitlement'||!snap)return {state:'unavailable',reason:'SOURCE_UNAVAILABLE'};
 const h=p.header,l=p.leaf,c=snap.backing.config,r=snap.renownRecord,sequence=BigInt(h.sequence);
 if(s.wallet!==wallet||l.wallet!==wallet||h.genesisHash!==mining.identity.genesisHash||h.programId!==mining.identity.programId||h.configAddress!==mining.identity.configAddress
  ||s.sequence!==h.sequence||l.sequence!==h.sequence||snap.root.sequence!==sequence||c.latestSequence!==sequence||snap.root.revoked
  ||s.observedSlot!==snap.slot||s.chainUnixTimestamp!==snap.chainClock.unixTimestamp.toString()
  ||r!==null&&(r.wallet!==wallet||r.lastSequence>sequence||r.renownTotal>BigInt(l.cumulativeRenown)||r.daysAttested>BigInt(l.cumulativeDays)))return {state:'unavailable',reason:'SOURCE_CONFLICT'};
 return {state:'available',data:{observedSlot:snap.slot,chainUnixTimestamp:snap.chainClock.unixTimestamp.toString(),publicationSequence:h.sequence,
  published:{cumulativeRenown:l.cumulativeRenown,cumulativeDays:l.cumulativeDays},
  attested:r===null?null:{renownTotal:r.renownTotal.toString(),daysAttested:r.daysAttested.toString(),lastSequence:r.lastSequence.toString()}}};
}

export function createRealmPassportProvider(db:Db,options:{mining?:RealmPassportMiningCapability|undefined}={}){
 if('rollback'in db)throw Error('REALM_PASSPORT_TOP_LEVEL');
 const mining=options.mining;
 // Fail at wiring time, not per request, when the configured identity is not a coherent publication domain.
 if(mining)try{createMiningClaimEntitlementHistoryReader(db,mining.identity,'1');}catch{throw Error('REALM_PASSPORT_IDENTITY');}
 async function page<T,D>(wallet:string,read:(tx:DbTx)=>Promise<T>,view:(v:T)=>D,schema:{parse(v:unknown):unknown}){
  const serverNow=new Date().toISOString();
  let outcome:{state:'available';data:D}|{state:'unavailable';reason:Reason};
  try{outcome={state:'available',data:view(await db.transaction(read,{isolationLevel:'repeatable read',accessMode:'read only'}))};}
  catch(error){outcome={state:'unavailable',reason:classify(error)};}
  return finish(wallet,serverNow,outcome,schema);
 }
 function finish<D>(wallet:string,serverNow:string,outcome:{state:'available';data:D}|{state:'unavailable';reason:Reason},schema:{parse(v:unknown):unknown}){
  // The frozen wire schema is the last gate: a projection it refuses is a source conflict, never a partial page.
  const projected=outcome.state==='available'?{...envelope(wallet,serverNow),state:'available' as const,data:outcome.data}:unavailable(wallet,serverNow,outcome.reason);
  try{return schema.parse(projected);}catch{return schema.parse(unavailable(wallet,serverNow,'SOURCE_CONFLICT'));}
 }
 return Object.freeze({
  async expeditions(authenticatedWallet:string,query:{kind:Kind;cursor?:string|undefined}):Promise<RealmPassportExpeditionsResponse>{
   const wallet=walletKey(authenticatedWallet),parsed=RealmPassportExpeditionsQuerySchema.safeParse(query);if(!parsed.success)throw new RealmPassportError('INVALID_INPUT');
   const {kind,cursor}=parsed.data;
   return await page(wallet,tx=>expeditionRows(tx,wallet,kind,cursor),v=>({kind,rows:v.rows,nextCursor:v.more?v.rows[v.rows.length-1]!.expeditionId:null}),RealmPassportExpeditionsResponseSchema) as RealmPassportExpeditionsResponse;
  },
  async inclusions(authenticatedWallet:string,query:{cursor?:string|undefined}={}):Promise<RealmPassportInclusionsResponse>{
   const wallet=walletKey(authenticatedWallet),parsed=RealmPassportInclusionsQuerySchema.safeParse(query);if(!parsed.success)throw new RealmPassportError('INVALID_INPUT');
   if(!mining)return finish(wallet,new Date().toISOString(),{state:'unavailable',reason:'NOT_CONFIGURED'},RealmPassportInclusionsResponseSchema) as RealmPassportInclusionsResponse;
   const {cursor}=parsed.data,identity=mining.identity;
   return await page(wallet,tx=>inclusionRows(tx,wallet,identity,cursor),v=>({rows:v.rows,nextCursor:v.more?v.rows[v.rows.length-1]!.sequence:null}),RealmPassportInclusionsResponseSchema) as RealmPassportInclusionsResponse;
  },
  async current(authenticatedWallet:string):Promise<RealmPassportCurrentResponse>{
   const wallet=walletKey(authenticatedWallet),serverNow=new Date().toISOString();
   if(!mining?.assess)return finish(wallet,serverNow,{state:'unavailable',reason:'NOT_CONFIGURED'},RealmPassportCurrentResponseSchema) as RealmPassportCurrentResponse;
   let outcome:ReturnType<typeof currentData>;
   try{outcome=currentData(wallet,mining,await mining.assess(wallet));}catch{outcome={state:'unavailable',reason:'SOURCE_UNAVAILABLE'};}
   return finish(wallet,serverNow,outcome,RealmPassportCurrentResponseSchema) as RealmPassportCurrentResponse;
  },
 });
}
export type RealmPassportProvider=ReturnType<typeof createRealmPassportProvider>;

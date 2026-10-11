/** Ordinary paid/deedless funded planner. Existing publication custody performs all writes. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { KEEP_MINING_FLOOR,PHASE_E_POLICY as P,PHASE_E_MINING_SCORE_POLICY as SCORE,PHASE_E_MINING_PUBLICATION as SPLIT } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader,type MiningBackingReader,type MiningBackingTrust,type MiningBackingSnapshot } from '@shardkeep/chain/mining-backing';
import { readFinalizedHistoricalSeekerTerm,type ReviewedSeekerTermPolicy,type SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { miningConfigPda,miningEpochPda } from '@shardkeep/chain/mining-program';
import { hashMiningTaxCommitment } from '@shardkeep/chain/mining-tax';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import type { GemsFinalizedOriginWiring } from './gemsFinalizedOrigins';
import type { SeekerMiningEnrollmentWiring } from './seekerEnrollmentQualification';
import type { SeekerMiningQualificationWiring } from './seekerMiningQualification';
import type { Db } from '../db/client';
import type { InitialFreeQualificationSource } from './initialFreeQualification';
import { captureFundedMiningWallet, captureMiningWalletQualification, hasExistingMiningWalletSource, hasMiningSeekerAbsenceSource, hasMiningPostZeroSource, deriveFundedMiningWallet, type FundedMiningCapture } from './fundedMiningQualification';
import { calculateFundedMining, fundedMiningPolicy, fundedMiningPolicyV2 } from './fundedMiningAudit';
import { calculateResourceMining, deriveResourceMiningWallet, planResourceMiningContributions, type ResourceMiningCapture } from './resourceMiningAllocation';
import { resourceMiningPolicy, seekerResourceMiningPolicy, resourceMiningPolicyV3, seekerResourceMiningPolicyV3, enrolledSeekerResourceMiningPolicy, enrolledSeekerResourceMiningPolicyV3, existingWalletResourceMiningPolicy, existingWalletResourceMiningPolicyV3, seekerAbsenceResourceMiningPolicy, seekerAbsenceResourceMiningPolicyV3, postZeroResourceMiningPolicy, postZeroResourceMiningPolicyV3 } from './resourceMiningAudit';
import { readResourceMiningEpoch } from './resourcePublicationCustody';
import { loadAuditedMiningPriorForBacking } from './publicationHistory';
import { createPublicationPreparer, type MiningPublicationPreparationOptions } from './publicationPreparation';
import { assertCumulativeMiningFunding,assertCumulativeMiningDay,copyAuditedPriorMiningPublication,CumulativeFreePublicationError,type AuditedPriorMiningPublication } from './cumulativeFreePublication';

const MAX_ROWS=1_000,MAX_WALLETS=32,MAX_RPC=4_096,MAX_JSON_BYTES=4*1024*1024,MAX_NODES=200_000,TIMEOUT_MS=30_000;
const inputSchema=z.object({epochId:z.uuid(),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.union([z.literal(SCORE.version),z.literal(2),z.literal(3)])}).strict();
type Input=z.infer<typeof inputSchema>;
type Code='INVALID_INPUT'|'EPOCH_UNAVAILABLE'|'EPOCH_SCOPE_INVALID'|'DAY_OPEN'|'EPOCH_ALREADY_DECIDED'|'SOURCE_CHANGED'|'SOURCE_CONFLICT'|'SOURCE_QUALIFICATION_UNAVAILABLE'|'PUBLICATION_SOURCE_UNAVAILABLE'|'PRIOR_PUBLICATION_UNAVAILABLE'|'TAX_SOURCE_UNAVAILABLE'|'BUSY'|'TOO_LARGE'|'TIMEOUT';
export class FundedMiningAllocationError extends Error{constructor(readonly code:Code){super(`Funded mining allocation refused: ${code}`);this.name='FundedMiningAllocationError';}}
function fail(code:Code):never{throw new FundedMiningAllocationError(code);}
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
function canonical(value:unknown):string{
 let size=0,nodes=0;const part=(s:string)=>{size+=Buffer.byteLength(s);if(size>MAX_JSON_BYTES)fail('TOO_LARGE');return s;};
 function walk(v:unknown):string{
  if(++nodes>MAX_NODES)fail('TOO_LARGE');
  if(v instanceof Date){if(!Number.isFinite(+v))fail('SOURCE_CONFLICT');return part(JSON.stringify(v.toISOString()));}
  if(typeof v==='bigint')return part(JSON.stringify(v.toString()));
  if(v===null||typeof v==='string'||typeof v==='boolean'||(typeof v==='number'&&Number.isSafeInteger(v)))return part(JSON.stringify(v));
  if(Array.isArray(v))return part('[')+v.map(walk).join(part(','))+part(']');
  if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null))
   return part('{')+Object.entries(v).sort(([a],[b])=>lexical(a,b)).map(([k,x])=>part(JSON.stringify(k))+part(':')+walk(x)).join(part(','))+part('}');
  return fail('SOURCE_CONFLICT');
 }
 const result=walk(value);if(Buffer.byteLength(result)>MAX_JSON_BYTES)fail('TOO_LARGE');return result;
}
function freeze<T>(v:T):T{if(v&&typeof v==='object'){for(const x of Object.values(v))freeze(x);Object.freeze(v);}return v;}
type Reservation={id:string;baseId:string;actorWallet:string;qty:number;idempotencyKey:string;createdAt:string};
async function epoch(db:Db,input:Input){return db.transaction(async tx=>{
 const [mode]=await tx.execute<{isolation:string}>(sql`select current_setting('transaction_isolation') isolation`);if(mode?.isolation!=='read committed')fail('SOURCE_CONFLICT');
 const [e]=await tx.execute<{id:string;key:string;createdAt:string;closed:boolean}>(sql`select id,epoch_key key,to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "createdAt",clock_timestamp()>=(${input.day}::date+1)::timestamp at time zone 'UTC' closed from mining_ingot_epochs where id=${input.epochId} for update nowait`);
 if(!e)fail('EPOCH_UNAVAILABLE');if(e.key!==`free-shadow-v${input.policyVersion}:${input.day}`)fail('EPOCH_SCOPE_INVALID');if(!e.closed)fail('DAY_OPEN');
 const decided=await tx.execute(sql`select 1 from mining_ingot_aborts where epoch_id=${input.epochId} union all select 1 from mining_publication_attempts where epoch_id=${input.epochId}`);if(decided.length)fail('EPOCH_ALREADY_DECIDED');
 const rows=await tx.execute<Reservation>(sql`select id,base_id "baseId",actor_wallet "actorWallet",qty,idempotency_key "idempotencyKey",to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "createdAt" from mining_ingot_reservations where epoch_id=${input.epochId} order by base_id,id limit ${MAX_ROWS+1}`);
 if(!rows.length)fail('EPOCH_SCOPE_INVALID');if(rows.length>MAX_ROWS)fail('TOO_LARGE');
 if(rows.some(r=>r.createdAt.slice(0,10)!==input.day||r.createdAt<e.createdAt||!Number.isSafeInteger(r.qty)||r.qty<=0))fail('EPOCH_SCOPE_INVALID');
 // Match 0168's exact PostgreSQL jsonb reservation-set commitment. The full
 // manifest additionally preserves original keys/times and immutable evidence.
 const [hash]=await tx.execute<{hash:string}>(sql`select encode(sha256(convert_to(jsonb_agg(jsonb_build_object('reservationId',id,'baseId',base_id,'actorWallet',actor_wallet,'ingots',qty) order by base_id,id)::text,'UTF8')),'hex') hash from mining_ingot_reservations where epoch_id=${input.epochId}`);
 if(!hash)fail('SOURCE_CONFLICT');return {id:e.id,key:e.key,createdAt:e.createdAt,reservationSetSha256:hash.hash,reservations:[...rows]};
});}
export interface FundedMiningAllocationSources{
 readonly qualification:InitialFreeQualificationSource;
 /** Private test/source clock; omitted in production wiring. Never request data. */
 readonly resourceClock?:()=>Date;
 readonly gems?:GemsFinalizedOriginWiring;
 readonly seeker?:SeekerMiningQualificationWiring;
 /** Private enrollment locator and archive configuration, never public proof JSON. */
 readonly seekerEnrollment?:{
  readonly enrollmentFor:(wallet:string)=>Pick<SeekerMiningEnrollmentWiring,'enrollmentId'|'enrollmentSignature'>|null;
  readonly providers:SeekerMiningEnrollmentWiring['providers'];
 };
 /** Private committed baseline locator; never request proof or a source fallback. */
 readonly existingWallet?:{readonly baselineFor:(wallet:string,day:string)=>{baselineId:string;openingId?:string}|null};
 /** Private explicit absence selection, never an unavailable-positive fallback. */
 readonly seekerAbsence?:{readonly absenceFor:(wallet:string,day:string)=>boolean};
 readonly backing?:{readonly reader:MiningBackingReader;readonly trust:MiningBackingTrust};
 readonly tax?:{readonly connect:(signal:AbortSignal)=>SeekerTermRpc;readonly policy:ReviewedSeekerTermPolicy};
}
/** Trusted source configuration is application wiring, never the request body.
 * Non-virgin frontiers require the complete retained, owner-audited history;
 * a new day never resets previously funded rights. */
function createOrdinaryMiningAllocationPlanner(db:Db,sources:FundedMiningAllocationSources,resource:boolean){
 const qualification={...sources.qualification},backing=sources.backing?createMiningBackingSnapshotReader(sources.backing.reader,sources.backing.trust):null;
 const gems=sources.gems?{trust:{...sources.gems.trust},connect:sources.gems.connect}:undefined;
 const seeker=sources.seeker?{coverageSignature:sources.seeker.coverageSignature,
  providers:sources.seeker.providers.map(provider=>({...provider})) as unknown as SeekerMiningQualificationWiring['providers']}:undefined;
 const seekerEnrollment=sources.seekerEnrollment?{enrollmentFor:sources.seekerEnrollment.enrollmentFor,providers:sources.seekerEnrollment.providers.map(p=>({...p})) as unknown as SeekerMiningEnrollmentWiring['providers']}:undefined;
 const existingWallet=sources.existingWallet?{baselineFor:sources.existingWallet.baselineFor}:undefined;
 const seekerAbsence=sources.seekerAbsence?{absenceFor:sources.seekerAbsence.absenceFor}:undefined;
 if((existingWallet||seekerAbsence)&&!resource)fail('SOURCE_CONFLICT');
 if(seeker&&(seekerEnrollment||seekerAbsence))fail('SOURCE_CONFLICT');
 const tax=sources.tax?{connect:sources.tax.connect,policy:{...sources.tax.policy,deployment:{...sources.tax.policy.deployment}}}:null;
 return async function plan(value:unknown){
  const parsed=inputSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const input=parsed.data,startAt=new Date(`${input.day}T00:00:00.000Z`);
  if(!Number.isFinite(+startAt)||startAt.toISOString().slice(0,10)!==input.day)fail('INVALID_INPUT');const endAt=new Date(+startAt+SPLIT.daySec*1000);
  const controller=new AbortController();let calls=0;const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  const boundedReaders=new WeakMap<object,object>();
  const active=()=>{if(controller.signal.aborted)fail('TIMEOUT');};
  // One technical RPC budget across all participants and tax provenance. The
  // backing reader separately fixes its account/read count and byte bounds.
  function bounded<T extends object>(reader:T):T{
   const prior=boundedReaders.get(reader);if(prior)return prior as T;
   const proxy=new Proxy(reader,{get(target,property,receiver){const v=Reflect.get(target,property,receiver);if(typeof v!=='function')return v;return async(...args:unknown[])=>{active();if(++calls>MAX_RPC)fail('TOO_LARGE');const result=await v.apply(target,args);active();return result;};}});
   boundedReaders.set(reader,proxy);return proxy;
  }
  const run=async()=>{
   if(resource?input.policyVersion!==2&&input.policyVersion!==3:input.policyVersion===3)fail('INVALID_INPUT');
   const readEpoch=()=>resource?readResourceMiningEpoch(db,{...input,policyVersion:input.policyVersion as 2|3},sources.resourceClock):epoch(db,input);
   const original=await readEpoch(),originalBytes=canonical(original);
   const stock='contributions' in original?original.contributions:original.reservations;
   const wallets=[...new Set(stock.map(r=>r.actorWallet))].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()));
   if(wallets.length>MAX_WALLETS)fail('TOO_LARGE');
   const ingotCaptures:FundedMiningCapture[]=[],resourceCaptures:ResourceMiningCapture[]=[];
   for(const wallet of wallets){active();
    const source={...qualification,source:(signal:AbortSignal)=>bounded(typeof qualification.source==='function'?qualification.source(AbortSignal.any([signal,controller.signal])):qualification.source) as DeedMiningWalletReader};
    const gemSource=gems?{trust:gems.trust,connect:(signal:AbortSignal)=>gems.connect(AbortSignal.any([signal,controller.signal])).map(reader=>bounded(reader))}:undefined;
    const seekerSource=seeker?{coverageSignature:seeker.coverageSignature,providers:seeker.providers.map(provider=>({id:provider.id,
     connect:(signal:AbortSignal)=>bounded(provider.connect(AbortSignal.any([signal,controller.signal])))})) as unknown as SeekerMiningQualificationWiring['providers']}:undefined;
    const enrollment=seekerEnrollment?.enrollmentFor(wallet);
    const enrollmentSource=enrollment&&seekerEnrollment?{...enrollment,providers:seekerEnrollment.providers.map(provider=>({id:provider.id,
     connect:(signal:AbortSignal)=>bounded(provider.connect(AbortSignal.any([signal,controller.signal])))})) as unknown as SeekerMiningEnrollmentWiring['providers']}:undefined;
    if('contributions' in original){
     const rows=original.contributions.filter(r=>r.actorWallet===wallet);
     const existing=existingWallet?.baselineFor(wallet,input.day)??undefined;
     const absence=seekerAbsence?.absenceFor(wallet,input.day);
     if(seekerAbsence&&typeof absence!=='boolean'||absence&&enrollmentSource)fail('SOURCE_CONFLICT');
     const c=await captureMiningWalletQualification(db,source,wallet,input.day,rows.map(r=>r.baseId),gemSource,2,seekerSource,enrollmentSource,existing,absence===true?true:undefined);
     resourceCaptures.push({...c,bases:c.bases.map(b=>({...b,reservedValue:String(rows.filter(r=>r.baseId===b.baseId).reduce((n,r)=>n+BigInt(r.totalValue),0n))}))});
    }else ingotCaptures.push(await captureFundedMiningWallet(db,source,wallet,input.day,original.reservations.filter(r=>r.actorWallet===wallet),gemSource,input.policyVersion as 1|2));
    canonical(resource?resourceCaptures:ingotCaptures);active();
   }
   const captures=resource?resourceCaptures:ingotCaptures;
   const hasSeeker=resourceCaptures.some(capture=>Object.hasOwn(capture,'seekerQualification'));
   const enrolled=hasSeeker&&seekerEnrollment!==undefined;
   const hasExisting=resourceCaptures.some(hasExistingMiningWalletSource);
   const hasAbsence=resourceCaptures.some(hasMiningSeekerAbsenceSource);
   const hasPostZero=resourceCaptures.some(hasMiningPostZeroSource);
   if((hasExisting||hasAbsence)&&hasSeeker&&!enrolled)fail('SOURCE_CONFLICT');
   const ingotParticipants=ingotCaptures.flatMap(capture=>deriveFundedMiningWallet(capture,qualification.expectedGenesisHash,input.policyVersion as 1|2));
   const resourceParticipants=resourceCaptures.flatMap(capture=>deriveResourceMiningWallet(capture,qualification.expectedGenesisHash,hasSeeker,enrolled||hasExisting||hasAbsence?2:1,hasExisting,hasAbsence,hasPostZero));
   const participants=resource?resourceParticipants:ingotParticipants;
   if(!backing)fail('PUBLICATION_SOURCE_UNAVAILABLE');
   let funds:Awaited<ReturnType<typeof backing>>;try{funds=await backing();}catch{active();fail('PUBLICATION_SOURCE_UNAVAILABLE');}active();
   const c=funds.config,day=BigInt(Math.floor(+startAt/(SPLIT.daySec*1000)));
   if(funds.source.genesisHash!==qualification.expectedGenesisHash||captures.some(capture=>capture.gemsContribution!==null&&capture.gemsContribution.origins.chainIdentity.keepMint!==c.keepMint))fail('SOURCE_CONFLICT');
   if(day<c.genesisDay||day<=c.latestDay||day>=funds.chainDay)fail('DAY_OPEN');
   let prior:AuditedPriorMiningPublication|null=null;
   if(c.latestSequence>0n){
    try{prior=copyAuditedPriorMiningPublication(await loadAuditedMiningPriorForBacking(db,funds,controller.signal));active();assertCumulativeMiningFunding(funds,prior);assertCumulativeMiningDay(day,funds.chainDay,prior);}
    catch(error){active();if(error instanceof CumulativeFreePublicationError&&error.code==='TOO_LARGE')fail('TOO_LARGE');fail('PRIOR_PUBLICATION_UNAVAILABLE');}
   }else if(c.latestSequence!==0n||c.latestDay!==c.genesisDay-1n||c.totalPublished!==0n||c.totalPublishedHighwater!==0n||c.totalClaimed!==0n||c.taxHighwater!==0n||c.taxPaid!==0n||c.recycledTotal!==0n||c.grossPublished!==0n||c.splitCursor!==0||c.correctionPending)fail('PRIOR_PUBLICATION_UNAVAILABLE');
   if(!tax)fail('TAX_SOURCE_UNAVAILABLE');
   let term:Awaited<ReturnType<typeof readFinalizedHistoricalSeekerTerm>>;
   try{term=await readFinalizedHistoricalSeekerTerm(signal=>bounded(tax.connect(AbortSignal.any([signal,controller.signal]))),tax.policy,{deadlineMs:TIMEOUT_MS});}catch{active();fail('TAX_SOURCE_UNAVAILABLE');}active();
   if(term.source.genesisHash!==funds.source.genesisHash||term.source.programId!==funds.source.programId||term.deployment.programDataSha256!==funds.source.reviewedProgramDataSha256
    ||term.deployment.deployedSlot!==BigInt(funds.source.reviewedDeploymentSlot)||term.operatingStart*1000n>BigInt(+startAt)||term.operatingEnd*1000n<BigInt(+endAt)
    ||term.completedAt*1000n>BigInt(+startAt)||term.auctions.length!==P.seekerIsland.totalSpots)fail('TAX_SOURCE_UNAVAILABLE');
   // Read-time Clock/context and pause state authenticate the observation, but
   // are not part of the immutable original term's beneficiary commitment.
   const {finality:taxFinality,authority:taxAuthority,...originalTerm}=term;
   const taxObservation={finality:taxFinality,authority:taxAuthority};
   const beneficiaries=term.auctions.flatMap(a=>a.winner===null?[]:[{spotId:a.terms.spotId,auction:a.terms.auction,wallet:a.winner}]);
   if(beneficiaries.length!==term.winnerCount)fail('TAX_SOURCE_UNAVAILABLE');
   // Preserve the exact v1 zero-winner hold. Only the new v2 wire can fund a
   // permanent pool, whose original winning spots retain equal tax rights.
   const taxVersion=term.winnerCount===0?SPLIT.version:2;
   const taxManifest=term.winnerCount===0
    ?{version:SPLIT.version,mode:'original-term-no-beneficiary-hold',day:input.day,startAt,endAt,source:originalTerm,beneficiaries:[],futureTermReassignmentAuthorized:false}
    :{version:2,mode:'original-term-winning-spot-pool',day:input.day,startAt,endAt,source:originalTerm,beneficiaries,
      distributionVersion:1,distribution:'equal-cumulative-per-winning-spot',remainder:'original-term-encumbered',futureTermReassignmentAuthorized:false};
   let taxCommitment:string;
   try{
    const programId=new PublicKey(funds.source.programId);
    taxCommitment=term.winnerCount===0?digest(canonical(taxManifest)):Buffer.from(hashMiningTaxCommitment({
     programId,config:miningConfigPda(programId),keepMint:new PublicKey(c.keepMint),auctionConfig:new PublicKey(term.source.config),
     term:new PublicKey(term.term),registry:new PublicKey(term.registry),registryHash:Buffer.from(term.registryHash,'hex'),round:term.source.round,
     auctionStart:term.auctionStart,auctionEnd:term.auctionEnd,operatingStart:term.operatingStart,operatingEnd:term.operatingEnd,winnerCount:term.winnerCount,
    },{day,epoch:miningEpochPda(programId,day)})).toString('hex');
   }catch{fail('TAX_SOURCE_UNAVAILABLE');}
   const budgetGross=funds.maximumEpochBudget;
   const allocation=()=>{
    if('contributions' in original){
     const {declaration,consumed,...totals}=calculateResourceMining(resourceParticipants,budgetGross,c.splitCursor,prior?.declaration??null,hasSeeker);
     return {declaration,totals,details:{contributions:planResourceMiningContributions(original.contributions,consumed)}};
    }
    const {declaration,consumed,...totals}=calculateFundedMining(ingotParticipants,budgetGross,c.splitCursor,prior?.declaration??null);
    const remaining=new Map(consumed.map(row=>[row.baseId,row.units]));
    const reservations=original.reservations.map(r=>{const n=Math.min(r.qty,remaining.get(r.baseId)??0);remaining.set(r.baseId,(remaining.get(r.baseId)??0)-n);
     return {reservationId:r.id,baseId:r.baseId,actorWallet:r.actorWallet,reserved:r.qty,proposedConsumed:n,proposedReturned:r.qty-n};});
    return {declaration,totals,details:{reservations}};
   };
   const {declaration,totals,details}=allocation();
   const abort=declaration===null;
   const resourceVersion=hasPostZero?(input.policyVersion===3?16:15):hasAbsence?(input.policyVersion===3?14:13):hasExisting?(input.policyVersion===3?12:11):input.policyVersion===3?(enrolled?10:hasSeeker?8:7):(enrolled?9:hasSeeker?6:5);
   const resourceScope=hasPostZero?(input.policyVersion===3?'ordinary-resource-mining-zero-gems-v3':'ordinary-resource-mining-zero-gems-v2'):hasAbsence?(input.policyVersion===3?'ordinary-resource-mining-seeker-absence-v3':'ordinary-resource-mining-seeker-absence-v2'):hasExisting?(input.policyVersion===3?'ordinary-resource-mining-existing-wallet-v3':'ordinary-resource-mining-existing-wallet-v2'):input.policyVersion===3?(enrolled?'ordinary-resource-mining-enrolled-seeker-v3':hasSeeker?'ordinary-resource-mining-seeker-v3':'ordinary-resource-mining-v3'):(enrolled?'ordinary-resource-mining-enrolled-seeker-v2':hasSeeker?'ordinary-resource-mining-seeker-v2':'ordinary-resource-mining-v2');
   const resourcePolicy=hasPostZero?(input.policyVersion===3?postZeroResourceMiningPolicyV3:postZeroResourceMiningPolicy):hasAbsence?(input.policyVersion===3?seekerAbsenceResourceMiningPolicyV3:seekerAbsenceResourceMiningPolicy):hasExisting?(input.policyVersion===3?existingWalletResourceMiningPolicyV3:existingWalletResourceMiningPolicy):input.policyVersion===3?(enrolled?enrolledSeekerResourceMiningPolicyV3:hasSeeker?seekerResourceMiningPolicyV3:resourceMiningPolicyV3):(enrolled?enrolledSeekerResourceMiningPolicy:hasSeeker?seekerResourceMiningPolicy:resourceMiningPolicy);
   const manifest={version:resource?resourceVersion:input.policyVersion===2?4:3,scope:resource?resourceScope:`ordinary-paid-and-deedless-v${input.policyVersion}`,input,epoch:original,policy:resource?resourcePolicy:input.policyVersion===2?fundedMiningPolicyV2:fundedMiningPolicy,captures,participants,
    funding:funds,previousPublication:prior?.reference??null,taxManifest,taxCommitment,projection:abort?'ABORT_NO_USEFUL_PLAYER_AWARD':'READY',
    budgetGross,...totals,...details,publicationAuthorized:false,consumptionAuthorized:false,renownAuthorized:false};
   const manifestJson=canonical(manifest),sourceHash=digest(manifestJson);
   if(canonical(await readEpoch())!==originalBytes)fail('SOURCE_CHANGED');active();
   if(!declaration)return freeze({projection:'ABORT_NO_USEFUL_PLAYER_AWARD' as const,manifestJson,sourceHash,taxObservation,...details,publication:null,publicationAuthorized:false as const,consumptionAuthorized:false as const,renownAuthorized:false as const});
   return freeze({projection:'READY' as const,manifestJson,sourceHash,taxObservation,...details,
    publication:{...declaration,day,budgetGross,freeGross:totals.freeGross,deedGross:totals.deedGross,playerNet:totals.playerNet,recycle:totals.recycle,tax:totals.tax,taxCommitment,taxVersion,splitStart:c.splitCursor,splitEnd:totals.splitEnd},
    publicationAuthorized:false as const,consumptionAuthorized:false as const,renownAuthorized:false as const});
  };
  let rejectAbort:(()=>void)|undefined;
  try{return await Promise.race([run(),new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new FundedMiningAllocationError('TIMEOUT'));controller.signal.addEventListener('abort',rejectAbort,{once:true});})]);}
  catch(error){const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')fail('BUSY');throw error;}
  finally{clearTimeout(timer);if(rejectAbort)controller.signal.removeEventListener('abort',rejectAbort);controller.abort();}
 };
}

export function createFundedMiningAllocationPlanner(db:Db,sources:FundedMiningAllocationSources){
 const plan=createOrdinaryMiningAllocationPlanner(db,sources,false);
 return async(value:unknown)=>{const result=await plan(value);if(!result.reservations)fail('SOURCE_CONFLICT');return result as typeof result & {reservations:NonNullable<typeof result.reservations>};};
}
export function createResourceMiningAllocationPlanner(db:Db,sources:FundedMiningAllocationSources){
 const plan=createOrdinaryMiningAllocationPlanner(db,sources,true);
 return async(value:unknown)=>{const result=await plan(value);if(!result.contributions)fail('SOURCE_CONFLICT');return result as typeof result & {contributions:NonNullable<typeof result.contributions>};};
}

/** Current admission is private application wiring; original replay is the shared immutable path. */
export function createFundedMiningPublicationPreparer(db:Db,options:Omit<MiningPublicationPreparationOptions,'sources'>&{sources:FundedMiningAllocationSources}){
 return createPublicationPreparer(db,options,createFundedMiningAllocationPlanner(db,options.sources));
}
export function createResourceMiningPublicationPreparer(db:Db,options:Omit<MiningPublicationPreparationOptions,'sources'>&{sources:FundedMiningAllocationSources}){
 return createPublicationPreparer(db,options,createResourceMiningAllocationPlanner(db,options.sources));
}

/** First-publication KEEP plan only. No pin, signing, consumption or Renown award. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { KEEP_MINING_FLOOR,PHASE_E_POLICY as P,PHASE_E_MINING_SCORE_POLICY as SCORE,PHASE_E_MINING_PUBLICATION as SPLIT } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader,type MiningBackingReader,type MiningBackingTrust,type MiningBackingSnapshot } from '@shardkeep/chain/mining-backing';
import { readFinalizedSeekerTerm,type ReviewedSeekerTermPolicy,type SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { miningConfigPda,miningEpochPda } from '@shardkeep/chain/mining-program';
import { hashMiningTaxCommitment } from '@shardkeep/chain/mining-tax';
import type { DeedMiningWalletReader } from '@shardkeep/chain/mining-wallet';
import type { Db } from '../db/client';
import { qualifyInitialFreeMiningDay,type InitialFreeQualificationSource } from './initialFreeQualification';
import { assertCumulativeMiningFunding,assertCumulativeMiningDay,copyAuditedPriorMiningPublication,buildCumulativeFreeDeclaration,CumulativeFreePublicationError,type AuditedPriorMiningPublication } from './cumulativeFreePublication';

const MAX_ROWS=1_000,MAX_WALLETS=32,MAX_RPC=4_096,MAX_JSON_BYTES=4*1024*1024,MAX_NODES=200_000,TIMEOUT_MS=30_000;
const inputSchema=z.object({epochId:z.uuid(),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(SCORE.version)}).strict();
type Input=z.infer<typeof inputSchema>;
type Code='INVALID_INPUT'|'EPOCH_UNAVAILABLE'|'EPOCH_SCOPE_INVALID'|'DAY_OPEN'|'EPOCH_ALREADY_DECIDED'|'SOURCE_CHANGED'|'SOURCE_CONFLICT'|'SOURCE_QUALIFICATION_UNAVAILABLE'|'PUBLICATION_SOURCE_UNAVAILABLE'|'PRIOR_PUBLICATION_UNAVAILABLE'|'TAX_SOURCE_UNAVAILABLE'|'BUSY'|'TOO_LARGE'|'TIMEOUT';
export class InitialFreeAllocationError extends Error{constructor(readonly code:Code){super(`Initial-free allocation refused: ${code}`);this.name='InitialFreeAllocationError';}}
function fail(code:Code):never{throw new InitialFreeAllocationError(code);}
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
 if(!e)fail('EPOCH_UNAVAILABLE');if(e.key!==`free-shadow-v1:${input.day}`)fail('EPOCH_SCOPE_INVALID');if(!e.closed)fail('DAY_OPEN');
 const decided=await tx.execute(sql`select 1 from mining_ingot_aborts where epoch_id=${input.epochId} union all select 1 from mining_publication_attempts where epoch_id=${input.epochId}`);if(decided.length)fail('EPOCH_ALREADY_DECIDED');
 const rows=await tx.execute<Reservation>(sql`select id,base_id "baseId",actor_wallet "actorWallet",qty,idempotency_key "idempotencyKey",to_char(created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "createdAt" from mining_ingot_reservations where epoch_id=${input.epochId} order by base_id,id limit ${MAX_ROWS+1}`);
 if(!rows.length)fail('EPOCH_SCOPE_INVALID');if(rows.length>MAX_ROWS)fail('TOO_LARGE');
 if(rows.some(r=>r.createdAt.slice(0,10)!==input.day||r.createdAt<e.createdAt||!Number.isSafeInteger(r.qty)||r.qty<=0))fail('EPOCH_SCOPE_INVALID');
 // Match 0168's exact PostgreSQL jsonb reservation-set commitment. The full
 // manifest additionally preserves original keys/times and immutable evidence.
 const [hash]=await tx.execute<{hash:string}>(sql`select encode(sha256(convert_to(jsonb_agg(jsonb_build_object('reservationId',id,'baseId',base_id,'actorWallet',actor_wallet,'ingots',qty) order by base_id,id)::text,'UTF8')),'hex') hash from mining_ingot_reservations where epoch_id=${input.epochId}`);
 if(!hash)fail('SOURCE_CONFLICT');return {id:e.id,key:e.key,createdAt:e.createdAt,reservationSetSha256:hash.hash,reservations:[...rows]};
});}
export interface InitialFreeAllocationSources{
 readonly qualification:InitialFreeQualificationSource;
 readonly backing?:{readonly reader:MiningBackingReader;readonly trust:MiningBackingTrust};
 readonly tax?:{readonly connect:(signal:AbortSignal)=>SeekerTermRpc;readonly policy:ReviewedSeekerTermPolicy};
}
/** Trusted source configuration is application wiring, never the request body.
 * This first slice refuses every non-virgin frontier until a retained complete
 * prior-manifest authenticator exists; it cannot reset previously funded rights. */
function createFreeAllocationPlanner(db:Db,sources:InitialFreeAllocationSources,loadPrior:((backing:MiningBackingSnapshot,signal:AbortSignal)=>Promise<AuditedPriorMiningPublication>)|null){
 const qualification={...sources.qualification},backing=sources.backing?createMiningBackingSnapshotReader(sources.backing.reader,sources.backing.trust):null;
 const tax=sources.tax?{connect:sources.tax.connect,policy:{...sources.tax.policy,deployment:{...sources.tax.policy.deployment}}}:null;
 return async function plan(value:unknown){
  const parsed=inputSchema.safeParse(value);if(!parsed.success)fail('INVALID_INPUT');const input=parsed.data,startAt=new Date(`${input.day}T00:00:00.000Z`);
  if(!Number.isFinite(+startAt)||startAt.toISOString().slice(0,10)!==input.day)fail('INVALID_INPUT');const endAt=new Date(+startAt+SPLIT.daySec*1000);
  const controller=new AbortController();let calls=0;const timer=setTimeout(()=>controller.abort(),TIMEOUT_MS);
  const active=()=>{if(controller.signal.aborted)fail('TIMEOUT');};
  // One technical RPC budget across all participants and tax provenance. The
  // backing reader separately fixes its account/read count and byte bounds.
  function bounded<T extends object>(reader:T):T{return new Proxy(reader,{get(target,property,receiver){const v=Reflect.get(target,property,receiver);if(typeof v!=='function')return v;return async(...args:unknown[])=>{active();if(++calls>MAX_RPC)fail('TOO_LARGE');const result=await v.apply(target,args);active();return result;};}});}
  const run=async()=>{
   const original=await epoch(db,input),originalBytes=canonical(original);
   const wallets=[...new Set(original.reservations.map(r=>r.actorWallet))].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()));
   if(wallets.length>MAX_WALLETS)fail('TOO_LARGE');
   const participants=[];
   for(const wallet of wallets){active();
    let evidence:Awaited<ReturnType<typeof qualifyInitialFreeMiningDay>>;
    try{evidence=await qualifyInitialFreeMiningDay(db,{...qualification,source:signal=>bounded(typeof qualification.source==='function'?qualification.source(AbortSignal.any([signal,controller.signal])):qualification.source) as DeedMiningWalletReader},{wallet,day:input.day,policyVersion:input.policyVersion});}
    catch(error){active();if(error instanceof InitialFreeAllocationError)throw error;fail('SOURCE_QUALIFICATION_UNAVAILABLE');}
    const rows=original.reservations.filter(r=>r.actorWallet===wallet),ids=rows.map(r=>r.id).sort(lexical),units=rows.reduce((sum,r)=>sum+r.qty,0);
    if(rows.some(r=>r.baseId!==evidence.baseId)||canonical(ids)!==canonical([...evidence.reservationIds].sort(lexical))||evidence.eligibleUnits>units
     ||!Number.isSafeInteger(evidence.eligibleUnits)||evidence.eligibleUnits<0||!/^(0|[1-9][0-9]*)$/.test(evidence.weight)
     ||BigInt(evidence.weight)!==BigInt(evidence.eligibleUnits)*BigInt(evidence.baseScoreBps))fail('SOURCE_CONFLICT');
    const [shadow]=await db.execute<{evidence_hash:string;evidence:unknown;result:unknown}>(sql`select evidence_hash,evidence,result from mining_free_wallet_shadows where wallet=${wallet} and day=${input.day}::date and policy_version='free-shadow-v1'`);
    if(!shadow)fail('SOURCE_CONFLICT');
    const xp=await db.execute<{day:string;source_hash:string;result_hash:string}>(sql`select day::text,source_hash,result_hash from mining_wallet_experience_days where day>=${evidence.experienceCoverage.fromDay}::date and day<=${input.day}::date and policy_version=${input.policyVersion} order by day limit 10001`);
    if(xp.length>10000)fail('TOO_LARGE');
    participants.push({wallet,baseId:evidence.baseId,reservedUnits:units,eligibleUnits:evidence.eligibleUnits,weight:evidence.weight,evidence,shadow,xp:[...xp]});
    canonical(participants); // Bound accumulation, not only final serialization.
   }
   if(!backing)fail('PUBLICATION_SOURCE_UNAVAILABLE');
   let funds:Awaited<ReturnType<typeof backing>>;try{funds=await backing();}catch{active();fail('PUBLICATION_SOURCE_UNAVAILABLE');}active();
   const c=funds.config,day=BigInt(Math.floor(+startAt/(SPLIT.daySec*1000)));
   if(funds.source.genesisHash!==qualification.expectedGenesisHash)fail('SOURCE_CONFLICT');
   if(day<c.genesisDay||day<=c.latestDay||day>=funds.chainDay)fail('DAY_OPEN');
   let prior:AuditedPriorMiningPublication|null=null;
   if(loadPrior){
    try{prior=copyAuditedPriorMiningPublication(await loadPrior(funds,controller.signal));active();assertCumulativeMiningFunding(funds,prior);assertCumulativeMiningDay(day,funds.chainDay,prior);}
    catch(error){active();if(error instanceof CumulativeFreePublicationError&&error.code==='TOO_LARGE')fail('TOO_LARGE');fail('PRIOR_PUBLICATION_UNAVAILABLE');}
   }else if(c.latestSequence!==0n||c.latestDay!==c.genesisDay-1n||c.totalPublished!==0n||c.totalPublishedHighwater!==0n||c.totalClaimed!==0n||c.taxHighwater!==0n||c.taxPaid!==0n||c.recycledTotal!==0n||c.grossPublished!==0n||c.splitCursor!==0||c.correctionPending)fail('PRIOR_PUBLICATION_UNAVAILABLE');
   if(!tax)fail('TAX_SOURCE_UNAVAILABLE');
   let term:Awaited<ReturnType<typeof readFinalizedSeekerTerm>>;
   try{term=await readFinalizedSeekerTerm(signal=>bounded(tax.connect(AbortSignal.any([signal,controller.signal]))),tax.policy,{deadlineMs:TIMEOUT_MS});}catch{active();fail('TAX_SOURCE_UNAVAILABLE');}active();
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
   const budgetGross=funds.maximumEpochBudget,freeBudget=budgetGross*BigInt(P.mining.freePoolBps)/BigInt(P.basisPoints);
   const sumWeight=participants.reduce((sum,p)=>sum+BigInt(p.weight),0n),floor=BigInt(KEEP_MINING_FLOOR.minUnitsPerPool)*BigInt(P.basisPoints),denominator=sumWeight>floor?sumWeight:floor;
   let cursor=c.splitCursor,playerNet=0n,recycle=0n,taxTotal=0n,freeGross=0n;
   const awards=participants.map(p=>{
    const gross=freeBudget*BigInt(p.weight)/denominator,cycles=gross/BigInt(SPLIT.splitPeriod),tail=Number(gross%BigInt(SPLIT.splitPeriod)),splitStart=cursor;
    let net=cycles*BigInt(SPLIT.splitPlayerUnits),r=cycles*BigInt(SPLIT.splitRecycleUnits),t=cycles*BigInt(SPLIT.splitTaxUnits);
    for(let i=0;i<tail;i++){if(cursor<SPLIT.splitPlayerUnits)net++;else if(cursor<SPLIT.splitPlayerUnits+SPLIT.splitRecycleUnits)r++;else t++;cursor=(cursor+1)%SPLIT.splitPeriod;}
    freeGross+=gross;playerNet+=net;recycle+=r;taxTotal+=t;return {wallet:p.wallet,eligibleUnits:p.eligibleUnits,gross,net,recycle:r,tax:t,splitStart,splitEnd:cursor};
   });
   const abort=budgetGross===0n||!awards.some(a=>a.eligibleUnits>0)||awards.some(a=>a.eligibleUnits>0&&a.net===0n);
   const reservationPlan=original.reservations.map(r=>{const award=awards.find(a=>a.wallet===r.actorWallet)!;let remaining=abort?0:award.eligibleUnits;
    for(const prior of original.reservations){if(prior.id===r.id)break;if(prior.actorWallet===r.actorWallet)remaining=Math.max(0,remaining-prior.qty);}
    const consumed=Math.min(r.qty,remaining);return {reservationId:r.id,baseId:r.baseId,actorWallet:r.actorWallet,reserved:r.qty,proposedConsumed:consumed,proposedReturned:r.qty-consumed};});
   if(freeGross>freeBudget||freeGross!==playerNet+recycle+taxTotal)fail('SOURCE_CONFLICT');
   const manifest={version:prior?2:1,scope:prior?'initial-free-cumulative-keep-only':'initial-free-virgin-config-keep-only',input,epoch:original,policy:{pool:P.mining,floor:KEEP_MINING_FLOOR,score:SCORE,split:SPLIT,basisPoints:P.basisPoints},participants,funding:funds,previousPublication:prior?.reference??null,taxManifest,taxCommitment,
    projection:abort?'ABORT_NO_USEFUL_PLAYER_AWARD':'READY',sumWeight,denominator,budgetGross,freeBudget,deedGross:0n,freeGross,playerNet,recycle,tax:taxTotal,splitStart:c.splitCursor,splitEnd:cursor,awards,reservations:reservationPlan,
    publicationAuthorized:false,consumptionAuthorized:false,renownAuthorized:false};
   const manifestJson=canonical(manifest),sourceHash=digest(manifestJson);
   if(canonical(await epoch(db,input))!==originalBytes)fail('SOURCE_CHANGED');active();
   if(abort)return freeze({projection:'ABORT_NO_USEFUL_PLAYER_AWARD' as const,manifestJson,sourceHash,taxObservation,reservations:reservationPlan,publication:null,publicationAuthorized:false as const,consumptionAuthorized:false as const,renownAuthorized:false as const});
   const audit=buildCumulativeFreeDeclaration(prior?.declaration??null,awards);
   if(audit.incrementalNetKeep!==playerNet)fail('SOURCE_CONFLICT');
   return freeze({projection:'READY' as const,manifestJson,sourceHash,taxObservation,reservations:reservationPlan,publication:{...audit.nextPublication,day,budgetGross,freeGross,deedGross:0n,playerNet,recycle,tax:taxTotal,taxCommitment,taxVersion,splitStart:c.splitCursor,splitEnd:cursor},publicationAuthorized:false as const,consumptionAuthorized:false as const,renownAuthorized:false as const});
  };
  let rejectAbort:(()=>void)|undefined;
  try{return await Promise.race([run(),new Promise<never>((_,reject)=>{rejectAbort=()=>reject(new InitialFreeAllocationError('TIMEOUT'));controller.signal.addEventListener('abort',rejectAbort,{once:true});})]);}
  catch(error){const e=error as {code?:string;cause?:{code?:string}};if(e.code==='55P03'||e.cause?.code==='55P03')fail('BUSY');throw error;}
  finally{clearTimeout(timer);if(rejectAbort)controller.signal.removeEventListener('abort',rejectAbort);controller.abort();}
 };
}

/** Legacy source/recovery remains strictly first-publication-only. */
export function createInitialFreeAllocationPlanner(db:Db,sources:InitialFreeAllocationSources){return createFreeAllocationPlanner(db,sources,null);}
export interface CumulativeFreeAllocationSources extends InitialFreeAllocationSources{
 /** Application-owned bounded owner history loader; never a request predecessor. */
 readonly loadPrior:(backing:MiningBackingSnapshot,signal:AbortSignal)=>Promise<AuditedPriorMiningPublication>;
}
export function createCumulativeFreeAllocationPlanner(db:Db,sources:CumulativeFreeAllocationSources){if(typeof sources.loadPrior!=='function')fail('PRIOR_PUBLICATION_UNAVAILABLE');return createFreeAllocationPlanner(db,sources,sources.loadPrior);}

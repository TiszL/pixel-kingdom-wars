/** Recompute allocation and custody from the ORIGINAL authenticated capture.
 * This consistency audit does not reauthenticate historical score/chain facts. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { auditWinningMiningTaxManifest } from './winningMiningTaxAudit';
import { KEEP_MINING_FLOOR,PHASE_E_POLICY as P,PHASE_E_MINING_SCORE_POLICY as SCORE,PHASE_E_MINING_PUBLICATION as SPLIT,TOKEN } from '@shardkeep/shared';
import { CUMULATIVE_FREE_MAX_LEAVES,assertCumulativeMiningCapture,assertCumulativeMiningDay,copyAuditedPriorMiningPublication,buildCumulativeFreeDeclaration,type AuditedPriorMiningPublication } from './cumulativeFreePublication';
const MAX_BYTES=4*1024*1024,MAX_NODES=200_000,MAX_ROWS=1_000,MAX_ACTORS=32;
export class InitialFreePublicationAuditError extends Error{readonly code='SOURCE_CONFLICT';constructor(){super('Initial-free publication audit refused: SOURCE_CONFLICT');this.name='InitialFreePublicationAuditError';}}
function fail():never{throw new InitialFreePublicationAuditError();}
function check(value:unknown):asserts value{if(!value)fail();}
const lexical=(a:string,b:string)=>a<b?-1:a>b?1:0;
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
function canonical(value:unknown):string{
 let nodes=0;function walk(v:unknown,depth:number):string{
  check(++nodes<=MAX_NODES&&depth<=64);
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isSafeInteger(v))return JSON.stringify(v);
  if(Array.isArray(v))return `[${v.map(x=>walk(x,depth+1)).join(',')}]`;
  check(v&&typeof v==='object'&&Object.getPrototypeOf(v)===Object.prototype);
  return `{${Object.entries(v).sort(([a],[b])=>lexical(a,b)).map(([k,x])=>`${JSON.stringify(k)}:${walk(x,depth+1)}`).join(',')}}`;
 }const result=walk(value,0);check(Buffer.byteLength(result)<=MAX_BYTES);return result;
}
const equal=(a:unknown,b:unknown)=>check(canonical(a)===canonical(b));
function obj(v:unknown):Record<string,unknown>{check(v&&typeof v==='object'&&!Array.isArray(v));return v as Record<string,unknown>;}
function rows(v:unknown,max=MAX_ROWS):unknown[]{check(Array.isArray(v)&&v.length<=max);return v;}
const uint=z.number().int().nonnegative().safe();
// Zod continues refinements after max/regex issues; bound conversion itself.
const decimal=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<1n<<64n);
const amount=(v:unknown)=>BigInt(decimal.parse(v));
const wallet=z.string().min(32).max(44).refine(v=>{if(v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const uuid=z.uuid();
const originalSchema=z.object({reservationId:uuid,baseId:uuid,actorWallet:wallet,ingots:uint.positive()}).strict();
const dispositionSchema=z.object({reservationId:uuid,baseId:uuid,actorWallet:wallet,reserved:uint.positive(),proposedConsumed:uint,proposedReturned:uint}).strict();
const epochReservationSchema=z.object({id:uuid,baseId:uuid,actorWallet:wallet,qty:uint.positive(),idempotencyKey:z.string(),createdAt:z.string()}).strict();
const evidenceSchema=z.object({wallet,baseId:uuid,day:z.string(),policyVersion:z.literal(SCORE.version),reason:z.enum(['qualified','registered_roster_invalid','external_deed_owned','cohort_invalid','development_required','no_qualified_activity','no_contribution']),scoreReason:z.enum(['qualified','cohort_invalid','development_required','no_qualified_activity','no_contribution']),eligibleUnits:uint,weight:decimal,reservationIds:z.array(uuid).max(MAX_ROWS),baseScoreBps:uint.max(P.basisPoints),sourceQualification:z.literal('complete'),allocationReady:z.literal(false),publicationAuthorized:z.literal(false)}).passthrough();
const publicationSchema=z.object({signer:wallet,programId:wallet,keepMint:wallet,reserveOwner:wallet,sequence:decimal,root:z.string().regex(/^[0-9a-f]{64}$/),total:decimal,leafCount:uint.positive().max(CUMULATIVE_FREE_MAX_LEAVES),kind:z.literal(0),day:decimal,budgetGross:decimal,freeGross:decimal,deedGross:decimal,playerNet:decimal,recycle:decimal,tax:decimal,taxCommitment:z.string().regex(/^[0-9a-f]{64}$/),taxVersion:z.union([z.literal(SPLIT.version),z.literal(2)]),splitStart:uint.max(SPLIT.splitPeriod-1),splitEnd:uint.max(SPLIT.splitPeriod-1)}).passthrough();
export interface InitialFreeCapturedReservation{reservationId:string;baseId:string;actorWallet:string;ingots:number}
/** Only use with owner-retained manifest and the immutable 0168 captured set.
 * Caller JSON is not an authenticated qualification source. No RPC or DB writes. */
type CapturedInput={manifestJson:string;publication:unknown;reservations:readonly InitialFreeCapturedReservation[]};
function auditFreePublicationManifest(input:CapturedInput,previous:AuditedPriorMiningPublication|null){
 try{
  check(typeof input.manifestJson==='string'&&Buffer.byteLength(input.manifestJson)<=MAX_BYTES);
  const m=obj(JSON.parse(input.manifestJson));check(canonical(m)===input.manifestJson);
  const prior=previous===null?null:copyAuditedPriorMiningPublication(previous);
  check(m.version===(prior?2:1)&&m.scope===(prior?'initial-free-cumulative-keep-only':'initial-free-virgin-config-keep-only')&&m.projection==='READY');
  equal(m.previousPublication,prior?.reference??null);
  check(m.publicationAuthorized===false&&m.consumptionAuthorized===false&&m.renownAuthorized===false);
  equal(m.policy,{pool:P.mining,floor:KEEP_MINING_FLOOR,score:SCORE,split:SPLIT,basisPoints:P.basisPoints});
  const request=z.object({epochId:uuid,day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(SCORE.version)}).strict().parse(m.input);
  const startAt=new Date(`${request.day}T00:00:00.000Z`);check(Number.isFinite(+startAt)&&startAt.toISOString().slice(0,10)===request.day);
  const endAt=new Date(+startAt+SPLIT.daySec*1000),day=BigInt(Math.floor(+startAt/(SPLIT.daySec*1000))),epoch=obj(m.epoch);
  check(epoch.id===request.epochId&&epoch.key===`free-shadow-v1:${request.day}`&&typeof epoch.createdAt==='string');
  check(Array.isArray(input.reservations)&&input.reservations.length>0&&input.reservations.length<=MAX_ROWS);
  const actual=z.array(originalSchema).min(1).max(MAX_ROWS).parse(input.reservations);
  check(new Set(actual.map(r=>r.reservationId)).size===actual.length);
  const ordered=[...actual].sort((a,b)=>lexical(a.baseId,b.baseId)||lexical(a.reservationId,b.reservationId));equal(actual,ordered);
  const originals=z.array(epochReservationSchema).min(1).max(MAX_ROWS).parse(rows(epoch.reservations));
  equal(originals.map(r=>({reservationId:r.id,baseId:r.baseId,actorWallet:r.actorWallet,ingots:r.qty})),actual);
  for(const r of originals)check(r.createdAt.slice(0,10)===request.day&&r.createdAt>=epoch.createdAt);
  // PostgreSQL jsonb orders these fixed keys by byte length, then byte value.
  const pgJson=`[${actual.map(r=>`{"baseId": ${JSON.stringify(r.baseId)}, "ingots": ${r.ingots}, "actorWallet": ${JSON.stringify(r.actorWallet)}, "reservationId": ${JSON.stringify(r.reservationId)}}`).join(', ')}]`;
  check(epoch.reservationSetSha256===digest(pgJson));
  const actors=[...new Set(actual.map(r=>r.actorWallet))].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()));
  check(actors.length<=MAX_ACTORS);const participants=rows(m.participants,MAX_ACTORS).map(obj);equal(participants.map(p=>p.wallet),actors);
  const funds=obj(m.funding),config=obj(funds.config),source=obj(funds.source),p=publicationSchema.parse(input.publication);
  check(p.signer===config.publisher&&p.programId===source.programId&&p.keepMint===config.keepMint&&p.reserveOwner===config.emissionReserveOwner);
  if(prior){assertCumulativeMiningCapture(funds,prior);assertCumulativeMiningDay(day,amount(funds.chainDay),prior);}
  else{
   check(config.correctionPending===false&&config.splitCursor===0&&amount(config.latestSequence)===0n&&amount(config.latestDay)===amount(config.genesisDay)-1n);
   for(const k of ['totalPublished','totalPublishedHighwater','totalClaimed','taxHighwater','taxPaid','recycledTotal','grossPublished'])check(amount(config[k])===0n);
   for(const k of ['playerOutstanding','taxOutstanding','totalOutstanding'])check(amount(funds[k])===0n);
   check(amount(funds.availableBudget)===amount(funds.vaultAmount)&&p.leafCount<=MAX_ACTORS&&p.total===p.playerNet);
  }
  check(day>=amount(config.genesisDay)&&day>amount(config.latestDay)&&day<amount(funds.chainDay)&&p.day===String(day));
  const splitStart=uint.max(SPLIT.splitPeriod-1).parse(config.splitCursor);
  check(p.sequence===String((prior?.declaration.sequence??0n)+1n)&&p.deedGross==='0'&&p.splitStart===splitStart);
  const available=amount(funds.availableBudget);
  const ceiling=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals),budget=available<ceiling?available:ceiling;
  check(budget>0n&&amount(funds.maximumEpochBudget)===budget&&amount(m.budgetGross)===budget);
  if(p.taxVersion===2){
   check(p.taxCommitment===m.taxCommitment);
   auditWinningMiningTaxManifest({taxManifest:m.taxManifest,funding:funds,day:request.day,taxCommitment:p.taxCommitment});
  }else{
  const taxManifest=obj(m.taxManifest),term=obj(taxManifest.source),termSource=obj(term.source),termDeployment=obj(term.deployment);
  check(taxManifest.version===SPLIT.version&&taxManifest.mode==='original-term-no-beneficiary-hold'&&taxManifest.day===request.day&&taxManifest.startAt===startAt.toISOString()&&taxManifest.endAt===endAt.toISOString()&&taxManifest.futureTermReassignmentAuthorized===false);
  equal(taxManifest.beneficiaries,[]);check(m.taxCommitment===digest(canonical(taxManifest))&&p.taxCommitment===m.taxCommitment);
  check(termSource.genesisHash===source.genesisHash&&termSource.programId===source.programId&&termDeployment.programDataSha256===source.reviewedProgramDataSha256&&String(termDeployment.deployedSlot)===String(source.reviewedDeploymentSlot));
  check(amount(term.operatingStart)*1000n<=BigInt(+startAt)&&amount(term.operatingEnd)*1000n>=BigInt(+endAt)&&amount(term.completedAt)*1000n<=BigInt(+startAt)&&term.winnerCount===0);
  const auctions=rows(term.auctions,P.seekerIsland.totalSpots);check(auctions.length===P.seekerIsland.totalSpots&&auctions.every(a=>obj(a).winner===null&&amount(obj(a).highBid)===0n));
  }
  const normalized=participants.map(participant=>{
   const e=evidenceSchema.parse(participant.evidence),actor=wallet.parse(participant.wallet),baseId=uuid.parse(participant.baseId),stock=actual.filter(r=>r.actorWallet===actor);
   const reserved=stock.reduce((n,r)=>n+r.ingots,0);check(Number.isSafeInteger(reserved)&&stock.every(r=>r.baseId===baseId)&&participant.reservedUnits===reserved);
   check(e.wallet===actor&&e.baseId===baseId&&e.day===request.day);equal([...e.reservationIds].sort(lexical),stock.map(r=>r.reservationId).sort(lexical));
   const shadow=obj(participant.shadow),sr=obj(shadow.result),se=obj(shadow.evidence),cohort=obj(se.cohort);
   check(sr.wallet===actor&&sr.baseId===baseId&&sr.day===request.day&&sr.policyVersion==='free-shadow-v1'&&cohort.wallet===actor&&cohort.baseId===baseId&&cohort.day===request.day);
   check(sr.reservedUnits===reserved&&sr.pendingUnits===reserved&&sr.releasedUnits===0&&sr.capacityUnits===P.mining.freeCapacityUnitsPerWalletDay);
   equal(sr.reservationIds,[...e.reservationIds].sort(lexical));
   const captured=rows(se.reservations).map(obj);check(captured.length===stock.length);
   equal(captured.map(r=>String(r.id)).sort(lexical),stock.map(r=>r.reservationId).sort(lexical));
   for(const r of captured){const original=originals.find(x=>x.id===r.id);check(original&&r.baseId===baseId&&r.actorWallet===actor&&r.epochId===request.epochId&&r.epochKey===epoch.key&&r.ingots===original.qty&&r.idempotencyKey===original.idempotencyKey&&r.abortedAt===null&&r.releasedAt===null);}
   check(shadow.evidence_hash===digest(canonical({input:{wallet:actor,day:request.day,policyVersion:'free-shadow-v1'},observedAt:sr.observedAt,evidence:se,result:sr})));
   const sources=obj(e.sources),roster=obj(sources.registeredRoster),deeds=obj(sources.deeds);
   check(roster.wallet===actor&&roster.day===request.day&&roster.policyVersion===request.policyVersion&&deeds.targetWallet===actor&&deeds.genesisHash===source.genesisHash&&deeds.startAt===startAt.toISOString()&&deeds.endAt===endAt.toISOString());
   check(uint.parse(deeds.throughBlockTime)*1000>=+endAt&&typeof deeds.deedlessThroughout==='boolean');
   check(deeds.deedlessThroughout===(rows(deeds.heldDuringIntervalAssetIds,10000).length===0));
   const unchanged=(v:unknown)=>{const snapshot=obj(v),bases=rows(snapshot.bases),slots=rows(snapshot.slots),facts=obj(snapshot.facts);check(typeof facts.sourceIdentityConsistent==='boolean');
    if(!facts.sourceIdentityConsistent||bases.length!==1||slots.length!==1)return false;const base=obj(bases[0]),slot=obj(slots[0]);
    return base.id===baseId&&base.owner_wallet===actor&&base.status==='active'&&base.land_paid_at===null&&base.deed_asset_id===null&&base.deed_mint_asset_id===null&&base.deed_minting_at===null&&slot.wallet===actor&&slot.base_id===baseId&&slot.active===true;};
   const registered=unchanged(roster.open)&&unchanged(roster.close)&&rows(roster.changes,10000).length===0&&rows(roster.continuityBrokenBaseIds,10000).length===0;
   const reason=!registered?'registered_roster_invalid':!deeds.deedlessThroughout?'external_deed_owned':e.scoreReason;check(e.reason===reason);
   // Score components were authenticated by the original collector. Recompute
   // their arithmetic here, but do not relabel them as independently verified.
   const bps=(v:unknown)=>uint.max(P.basisPoints).parse(v),activity=bps(e.activityBps),experience=bps(e.experienceBps),progression=bps(e.progressionBps),retention=bps(e.retentionBps);
   check(e.usefulChainBps===0||e.usefulChainBps===null);
   const walletBps=e.usefulChainBps===null?0:Math.floor((activity*SCORE.activityWeight+experience*SCORE.experienceWeight)/(SCORE.activityWeight+SCORE.experienceWeight+SCORE.usefulChainWeight));
   const baseMultiplier=SCORE.baseFloorBps+Math.floor(progression*SCORE.baseProgressBps/P.basisPoints),baseBps=Math.floor(Math.floor(walletBps*baseMultiplier/P.basisPoints)*retention/P.basisPoints);
   check(e.walletScoreBps===walletBps&&e.baseMultiplierBps===baseMultiplier&&e.baseScoreBps===baseBps);
   if(reason==='qualified')check(sr.cohortValid===true&&sr.freshBattleEvidence===true&&e.usefulChainBps===0&&e.scoreReason==='qualified');
   const eligible=reason==='qualified'?Math.min(reserved,P.mining.freeCapacityUnitsPerWalletDay):0,weight=BigInt(eligible)*BigInt(baseBps);
   check(e.eligibleUnits===eligible&&participant.eligibleUnits===eligible&&e.weight===String(weight)&&participant.weight===String(weight));
   return {wallet:actor,eligibleUnits:eligible,weight};
  });
  const sumWeight=normalized.reduce((n,p)=>n+p.weight,0n),floor=BigInt(KEEP_MINING_FLOOR.minUnitsPerPool)*BigInt(P.basisPoints),denominator=sumWeight>floor?sumWeight:floor,freeBudget=budget*BigInt(P.mining.freePoolBps)/BigInt(P.basisPoints);
  check(amount(m.sumWeight)===sumWeight&&amount(m.denominator)===denominator&&amount(m.freeBudget)===freeBudget);
  let cursor=splitStart,freeGross=0n,playerNet=0n,recycle=0n,tax=0n;
  const awards=normalized.map(actor=>{
   const gross=freeBudget*actor.weight/denominator,cycles=gross/BigInt(SPLIT.splitPeriod),tail=Number(gross%BigInt(SPLIT.splitPeriod)),splitStart=cursor;
   let net=cycles*BigInt(SPLIT.splitPlayerUnits),r=cycles*BigInt(SPLIT.splitRecycleUnits),t=cycles*BigInt(SPLIT.splitTaxUnits);
   for(let i=0;i<tail;i++){if(cursor<SPLIT.splitPlayerUnits)net++;else if(cursor<SPLIT.splitPlayerUnits+SPLIT.splitRecycleUnits)r++;else t++;cursor=(cursor+1)%SPLIT.splitPeriod;}
   check(actor.eligibleUnits===0||net>0n);freeGross+=gross;playerNet+=net;recycle+=r;tax+=t;
   return {wallet:actor.wallet,eligibleUnits:actor.eligibleUnits,gross:String(gross),net:String(net),recycle:String(r),tax:String(t),splitStart,splitEnd:cursor};
  });
  check(playerNet>0n&&freeGross<=freeBudget&&freeGross===playerNet+recycle+tax);equal(m.awards,awards);
  const remaining=new Map(normalized.map(p=>[p.wallet,p.eligibleUnits]));
  const reservations=actual.map(r=>{const consume=Math.min(r.ingots,remaining.get(r.actorWallet)!);remaining.set(r.actorWallet,remaining.get(r.actorWallet)!-consume);return {reservationId:r.reservationId,baseId:r.baseId,actorWallet:r.actorWallet,reserved:r.ingots,proposedConsumed:consume,proposedReturned:r.ingots-consume};});
  equal(z.array(dispositionSchema).min(1).max(MAX_ROWS).parse(m.reservations),reservations);
  for(const [k,v] of Object.entries({budgetGross:String(budget),freeGross:String(freeGross),deedGross:'0',playerNet:String(playerNet),recycle:String(recycle),tax:String(tax),splitStart,splitEnd:cursor})){check(m[k]===v&&p[k]===v);}
  const allocation=buildCumulativeFreeDeclaration(prior?.declaration??null,awards.map(a=>({wallet:a.wallet,net:BigInt(a.net)}))),declaration=allocation.nextPublication;
  check(allocation.incrementalNetKeep===playerNet&&p.root===declaration.root&&p.total===String(declaration.total)&&p.leafCount===declaration.leafCount);
  return Object.freeze({sourceHash:digest(input.manifestJson),declaration,reservations:Object.freeze(reservations.map(r=>Object.freeze(r))),awards:Object.freeze(awards.map(a=>Object.freeze(a))),netAndCustodyConsistent:true as const,historicalQualificationReverified:false as const,publicationAuthorized:false as const,consumptionAuthorized:false as const});
 }catch(error){if(error instanceof InitialFreePublicationAuditError)throw error;fail();}
}

/** Version 1 cannot acquire cumulative authority through extra caller fields. */
export function auditInitialFreePublicationManifest(input:CapturedInput){return auditFreePublicationManifest(input,null);}
/** previousPublication must already have been authenticated by the bounded owner
 * history loader. This auditor verifies its exact link and retained arithmetic. */
export function auditCumulativeFreePublicationManifest(input:CapturedInput&{previousPublication:AuditedPriorMiningPublication}){
 if(!input.previousPublication)fail();return auditFreePublicationManifest(input,input.previousPublication);
}

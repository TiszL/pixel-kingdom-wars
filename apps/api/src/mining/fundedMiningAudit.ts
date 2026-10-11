/** Complete retained ordinary-paid/free replay. Provider truth is captured once;
 * this verifier independently binds source facts, arithmetic and cumulative rights. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { KEEP_MINING_FLOOR, FORGE_INGOT, PHASE_E_POLICY as P, PHASE_E_MINING_SCORE_POLICY as SCORE,
 PHASE_E_MINING_CONTRIBUTION_V2 as V2, PHASE_E_MINING_PUBLICATION as SPLIT, PHASE_E_MINING_PARTICIPATION as R, PHASE_E_GEMS_MINING_CREDIT as GEMS_CREDIT, TOKEN } from '@shardkeep/shared';
import { type MiningAllocationPublication } from './allocationAudit';
import { assertCumulativeMiningCapture,assertCumulativeMiningDay,type AuditedPriorMiningPublication } from './cumulativeFreePublication';
import { deriveFundedMiningWallet,type FundedMiningCapture } from './fundedMiningQualification';
import { calculateMiningWeightedAllocation } from './fundedMiningKernel';
import { miningPublicationSchema } from './publicationEnvelope';
import { auditWinningMiningTaxManifest } from './winningMiningTaxAudit';
import type { InitialFreeCapturedReservation } from './initialFreePublicationAudit';
export function miningCanonical(value:unknown):string {
 let nodes=0;const walk=(v:unknown,depth:number):string=>{
  if(++nodes>200000||depth>64)throw Error('MINING_FUNDED_SOURCE_TOO_LARGE');
  if(v instanceof Date)return JSON.stringify(v.toISOString());if(typeof v==='bigint')return JSON.stringify(v.toString());
  if(v===null||typeof v==='string'||typeof v==='boolean'||typeof v==='number'&&Number.isSafeInteger(v))return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(x=>walk(x,depth+1)).join(',')+']';
  if(v&&typeof v==='object'&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null))
   return '{'+Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>JSON.stringify(k)+':'+walk(x,depth+1)).join(',')+'}';
  throw Error('MINING_FUNDED_SOURCE_CONFLICT');
 };const text=walk(value,0);if(Buffer.byteLength(text)>4194304)throw Error('MINING_FUNDED_SOURCE_TOO_LARGE');return text;
}
export const miningDigest=(s:string)=>createHash('sha256').update(s).digest('hex');
const need=(v:unknown):void=>{if(!v)throw Error('MINING_FUNDED_SOURCE_CONFLICT');};
const equal=(a:unknown,b:unknown)=>need(miningCanonical(a)===miningCanonical(b));
const amount=(v:unknown):bigint=>{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v));const n=BigInt(v as string);need(n<1n<<64n);return n;};
export const fundedMiningPolicy={pool:P.mining,floor:KEEP_MINING_FLOOR,score:SCORE,split:SPLIT,participation:R,gemsContribution:GEMS_CREDIT,capacity:FORGE_INGOT.capacity,basisPoints:P.basisPoints};
export const fundedMiningPolicyV2={...fundedMiningPolicy,capacity:{freeUnits:P.mining.freeCapacityUnitsPerWalletDay,deedUnits:null},contribution:V2};
export type FundedBase=ReturnType<typeof deriveFundedMiningWallet>[number];
export function calculateFundedMining(participants:readonly FundedBase[],budgetGross:bigint,splitStart:number,previous:MiningAllocationPublication|null){
 // Preserve original u64 weight admission and numeric unit accumulation exactly.
 const weighted=participants.map(p=>({...p,weight:amount(p.weight)}));
 const {baseAwards,awards:weightedAwards,...totals}=calculateMiningWeightedAllocation(weighted,
  BigInt(KEEP_MINING_FLOOR.minUnitsPerPool)*BigInt(P.basisPoints),budgetGross,splitStart,previous);
 const awards=weightedAwards.map(a=>({wallet:a.wallet,eligibleUnits:a.net>0n?baseAwards.filter(b=>b.wallet===a.wallet&&b.gross>0n).reduce((n,b)=>n+b.eligibleUnits,0):0,
  gross:a.gross,net:a.net,recycle:a.recycle,tax:a.tax,renown:a.renown,days:a.days,splitStart:a.splitStart,splitEnd:a.splitEnd}));
 const consumed=baseAwards.map(b=>({baseId:b.baseId,actorWallet:b.wallet,units:b.gross>0n&&awards.find(a=>a.wallet===b.wallet)!.net>0n?b.eligibleUnits:0}));
 const {declaration,...rest}=totals;
 return {...rest,awards,consumed,declaration};
}

interface Manifest {
 version:number;scope:string;input:{epochId:string;day:string;policyVersion:number};epoch:{id:string;key:string;createdAt:string;reservationSetSha256:string;reservations:{id:string;baseId:string;actorWallet:string;qty:number;idempotencyKey:string;createdAt:string}[]};
 policy:unknown;captures:FundedMiningCapture[];participants:FundedBase[];funding:{source:Record<string,unknown>;config:Record<string,unknown>;[key:string]:unknown};previousPublication:unknown;
 taxManifest:{source:{source:Record<string,unknown>;deployment:Record<string,unknown>;[key:string]:unknown};[key:string]:unknown};taxCommitment:string;projection:string;
 awards:unknown;reservations:{reservationId:string;baseId:string;actorWallet:string;reserved:number;proposedConsumed:number;proposedReturned:number}[];
 publicationAuthorized:boolean;consumptionAuthorized:boolean;renownAuthorized:boolean;[key:string]:unknown;
}
export function auditFundedMiningManifest(input:{manifestJson:string;publication:unknown;reservations:readonly InitialFreeCapturedReservation[];previousPublication:AuditedPriorMiningPublication|null}){
 need(Buffer.byteLength(input.manifestJson)<=4194304);const m=JSON.parse(input.manifestJson) as Manifest;need(miningCanonical(m)===input.manifestJson);
 const version=m.version===4?2:1;
 need((m.version===3&&m.scope==='ordinary-paid-and-deedless-v1'||m.version===4&&m.scope==='ordinary-paid-and-deedless-v2')&&m.projection==='READY'&&m.publicationAuthorized===false&&m.consumptionAuthorized===false&&m.renownAuthorized===false);
 equal(m.policy,version===2?fundedMiningPolicyV2:fundedMiningPolicy);const request=z.object({epochId:z.uuid(),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(version)}).strict().parse(m.input);
 const p=miningPublicationSchema.parse(input.publication),prior=input.previousPublication,day=BigInt(Date.parse(request.day)/86400000),end=Date.parse(request.day)+86400000;
 need(m.epoch.id===request.epochId&&m.epoch.key===`free-shadow-v${version}:${request.day}`);equal(m.previousPublication,prior?.reference??null);
 need(Array.isArray(m.epoch.reservations)&&m.epoch.reservations.length>0&&m.epoch.reservations.length<=1000);
 const originals=m.epoch.reservations.map(r=>({reservationId:r.id,baseId:r.baseId,actorWallet:r.actorWallet,ingots:r.qty}));equal(originals,input.reservations);
 need(new Set(originals.map(r=>r.reservationId)).size===originals.length);
 equal(originals,[...originals].sort((a,b)=>a.baseId.localeCompare(b.baseId)||a.reservationId.localeCompare(b.reservationId)));
 for(const r of m.epoch.reservations)need(Number.isSafeInteger(r.qty)&&r.qty>0&&r.createdAt.slice(0,10)===request.day&&r.createdAt>=m.epoch.createdAt);
 const pgJson=`[${originals.map(r=>`{"baseId": ${JSON.stringify(r.baseId)}, "ingots": ${r.ingots}, "actorWallet": ${JSON.stringify(r.actorWallet)}, "reservationId": ${JSON.stringify(r.reservationId)}}`).join(', ')}]`;
 need(miningDigest(pgJson)===m.epoch.reservationSetSha256);
 const funds=m.funding,c=funds.config,s=funds.source;need(s.programId===p.programId&&c.publisher===p.signer&&c.keepMint===p.keepMint&&c.emissionReserveOwner===p.reserveOwner);
 if(prior){assertCumulativeMiningCapture(funds,prior);assertCumulativeMiningDay(day,amount(funds.chainDay),prior);}else{
  need(c.correctionPending===false&&c.splitCursor===0&&amount(c.latestSequence)===0n&&amount(c.latestDay)===amount(c.genesisDay)-1n);
  for(const k of ['totalPublished','totalPublishedHighwater','totalClaimed','taxHighwater','taxPaid','recycledTotal','grossPublished'])need(amount(c[k])===0n);
  for(const k of ['playerOutstanding','taxOutstanding','totalOutstanding'])need(amount(funds[k])===0n);
  need(amount(funds.availableBudget)===amount(funds.vaultAmount));
 }
 need(day>=amount(c.genesisDay)&&day>amount(c.latestDay)&&day<amount(funds.chainDay)&&p.day===String(day));
 const ceiling=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals),available=amount(funds.availableBudget),budget=available<ceiling?available:ceiling;
 need(amount(funds.maximumEpochBudget)===budget&&amount(m.budgetGross)===budget);
 need(Array.isArray(m.captures)&&m.captures.length<=32);
 const actors=[...new Set(originals.map(r=>r.actorWallet))].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()));equal(m.captures.map(c=>c.wallet),actors);
 for(const capture of m.captures){need(capture.day===request.day);if(capture.gemsContribution)need(capture.gemsContribution.origins.chainIdentity.keepMint===c.keepMint);const stock=originals.filter(r=>r.actorWallet===capture.wallet);equal(capture.bases.map(b=>b.baseId),[...new Set(stock.map(r=>r.baseId))].sort());
  for(const b of capture.bases)need(b.reservedUnits===stock.filter(r=>r.baseId===b.baseId).reduce((n,r)=>n+r.ingots,0));}
 const participants=m.captures.flatMap(capture=>deriveFundedMiningWallet(capture,String(s.genesisHash),version));equal(m.participants,participants);
 const result=calculateFundedMining(participants,budget,Number(c.splitCursor),prior?.declaration??null);need(result.declaration!==null);
 for(const k of ['freeBudget','deedBudget','sumWeight','denominator','freeGross','deedGross','playerNet','recycle','tax','splitStart','splitEnd','awards'] as const)equal(m[k],result[k]);
 const remaining=new Map(result.consumed.map(b=>[b.baseId,b.units]));const dispositions=originals.map(r=>{const consumed=Math.min(r.ingots,remaining.get(r.baseId)??0);remaining.set(r.baseId,(remaining.get(r.baseId)??0)-consumed);return {reservationId:r.reservationId,baseId:r.baseId,actorWallet:r.actorWallet,reserved:r.ingots,proposedConsumed:consumed,proposedReturned:r.ingots-consumed};});equal(m.reservations,dispositions);
 const declaration=result.declaration!;for(const k of ['sequence','root','total','leafCount'] as const)equal(p[k],typeof declaration[k]==='bigint'?String(declaration[k]):declaration[k]);
 for(const k of ['budgetGross','freeGross','deedGross','playerNet','recycle','tax','splitStart','splitEnd'] as const)equal(p[k],m[k]);
 need(p.taxCommitment===m.taxCommitment);
 if(p.taxVersion===2)auditWinningMiningTaxManifest({taxManifest:m.taxManifest,funding:funds,day:request.day,taxCommitment:p.taxCommitment});
 else{
  const t=m.taxManifest,term=t.source;need(t.version===1&&t.mode==='original-term-no-beneficiary-hold'&&t.day===request.day&&t.startAt===new Date(Number(day)*86400000).toISOString()&&t.endAt===new Date(end).toISOString()&&t.futureTermReassignmentAuthorized===false);
  equal(t.beneficiaries,[]);need(miningDigest(miningCanonical(t))===p.taxCommitment&&term.source.genesisHash===s.genesisHash&&term.source.programId===s.programId
   &&term.deployment.programDataSha256===s.reviewedProgramDataSha256&&String(term.deployment.deployedSlot)===String(s.reviewedDeploymentSlot));
  need(amount(term.operatingStart)*1000n<=day*86400000n&&amount(term.operatingEnd)*1000n>=BigInt(end)&&amount(term.completedAt)*1000n<=day*86400000n&&term.winnerCount===0);
  const auctions=term.auctions as {winner:unknown;highBid:unknown}[];need(Array.isArray(auctions)&&auctions.length===P.seekerIsland.totalSpots&&auctions.every(a=>a.winner===null&&amount(a.highBid)===0n));
 }
 return {sourceHash:miningDigest(input.manifestJson),declaration,reservations:dispositions};
}

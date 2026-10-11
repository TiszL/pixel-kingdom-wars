/** Manifest5 replay binds immutable resource receipts, retained qualification,
 * exact integer weights, existing funded rights and complete basket outcomes. */
import { hasExistingMiningWalletSource, hasMiningSeekerAbsenceSource, hasMiningPostZeroSource } from './fundedMiningQualification';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { PHASE_E_POLICY as P, PHASE_E_MINING_CONTRIBUTION_V2 as V2, TOKEN } from '@shardkeep/shared';
import { MINING_CONTRIBUTION_RESOURCE_IDS, miningContributionResourceIds, miningResourceUnitValue } from '@shardkeep/shared/miningContribution';
import { MiningContributionReceiptSchema, MiningContributionRequestSchema } from '@shardkeep/shared/miningContributionApi';
import { fundedMiningPolicyV2, miningCanonical, miningDigest } from './fundedMiningAudit';
import { assertCumulativeMiningCapture, assertCumulativeMiningDay, type AuditedPriorMiningPublication } from './cumulativeFreePublication';
import { miningPublicationSchema } from './publicationEnvelope';
import { auditWinningMiningTaxManifest } from './winningMiningTaxAudit';
import { calculateResourceMining, deriveResourceMiningWallet, planResourceMiningContributions, resourceMiningValue,
 type ResourceMiningBase, type ResourceMiningCapture, type ResourceMiningOriginal, type ResourceMiningDisposition } from './resourceMiningAllocation';

const need=(v:unknown):void=>{if(!v)throw Error('MINING_RESOURCE_SOURCE_CONFLICT');};
const equal=(a:unknown,b:unknown)=>need(miningCanonical(a)===miningCanonical(b));
const amount=(v:unknown):bigint=>{need(typeof v==='string'&&/^(0|[1-9][0-9]{0,19})$/.test(v));const n=BigInt(v as string);need(n<1n<<64n);return n;};
// DB captures may preserve microseconds; receipt wire timestamps are milliseconds.
// Normalize precision before ordering so neither truncation nor lexicographic Z
// ordering can admit a receipt earlier than its source epoch.
function timestamp(value:string){
 need(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(\d{3})?Z$/.test(value));
 need(Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value.slice(0,23)+'Z');
 return value.length===24?value.slice(0,-1)+'000Z':value;
}
export const resourceMiningPolicy={...fundedMiningPolicyV2,
 resourceCatalogue:Object.fromEntries(MINING_CONTRIBUTION_RESOURCE_IDS.map(id=>[id,String(miningResourceUnitValue(id,V2.version))])),floorValuePerIngot:V2.valuePerIngot};
export const seekerResourceMiningPolicy={...resourceMiningPolicy,seekerQualification:'committed-link-and-two-archive-mint-birth-v1',seekerBonusBps:P.mining.seekerBonusBps};
export const resourceMiningPolicyV3={...resourceMiningPolicy,resourceCatalogue:Object.fromEntries(miningContributionResourceIds(3).map(id=>[id,String(miningResourceUnitValue(id,3))]))};
export const seekerResourceMiningPolicyV3={...resourceMiningPolicyV3,seekerQualification:seekerResourceMiningPolicy.seekerQualification,seekerBonusBps:seekerResourceMiningPolicy.seekerBonusBps};
export const enrolledSeekerResourceMiningPolicy={...resourceMiningPolicy,seekerQualification:'committed-enrollment-and-two-archive-holding-v2',seekerBonusBps:P.mining.seekerBonusBps};
export const enrolledSeekerResourceMiningPolicyV3={...resourceMiningPolicyV3,seekerQualification:enrolledSeekerResourceMiningPolicy.seekerQualification,seekerBonusBps:P.mining.seekerBonusBps};
export const existingWalletResourceMiningPolicy={...enrolledSeekerResourceMiningPolicy,existingWallet:'committed-identity-complete-xp-no-debit-v1'};
export const existingWalletResourceMiningPolicyV3={...enrolledSeekerResourceMiningPolicyV3,existingWallet:existingWalletResourceMiningPolicy.existingWallet};
export const seekerAbsenceResourceMiningPolicy={...existingWalletResourceMiningPolicy,seekerAbsence:'committed-marker-and-captured-birth-v1'};
export const seekerAbsenceResourceMiningPolicyV3={...existingWalletResourceMiningPolicyV3,seekerAbsence:seekerAbsenceResourceMiningPolicy.seekerAbsence};
export const postZeroResourceMiningPolicy={...seekerAbsenceResourceMiningPolicy,gemsOpening:'committed-zero-inventory-fifo-v1'};
export const postZeroResourceMiningPolicyV3={...seekerAbsenceResourceMiningPolicyV3,gemsOpening:postZeroResourceMiningPolicy.gemsOpening};
export const isResourceMiningManifest=(version:unknown)=>version===5||version===6||version===7||version===8||version===9||version===10||version===11||version===12||version===13||version===14||version===15||version===16;
export interface ResourceMiningManifest {
 version:5|6|7|8|9|10|11|12|13|14|15|16;scope:'ordinary-resource-mining-v2'|'ordinary-resource-mining-seeker-v2'|'ordinary-resource-mining-v3'|'ordinary-resource-mining-seeker-v3'|'ordinary-resource-mining-enrolled-seeker-v2'|'ordinary-resource-mining-enrolled-seeker-v3'|'ordinary-resource-mining-existing-wallet-v2'|'ordinary-resource-mining-existing-wallet-v3'|'ordinary-resource-mining-seeker-absence-v2'|'ordinary-resource-mining-seeker-absence-v3'|'ordinary-resource-mining-zero-gems-v2'|'ordinary-resource-mining-zero-gems-v3';input:{epochId:string;day:string;policyVersion:2|3};
 epoch:{id:string;key:string;createdAt:string;contributionSetSha256:string;contributions:ResourceMiningOriginal[];cutover?:{firstDay:string;policyVersion:3;installedAt:string;sha256:string}};
 policy:unknown;captures:ResourceMiningCapture[];participants:ResourceMiningBase[];
 funding:{source:Record<string,unknown>;config:Record<string,unknown>;[key:string]:unknown};previousPublication:unknown;
 taxManifest:{source:{source:Record<string,unknown>;deployment:Record<string,unknown>;[key:string]:unknown};[key:string]:unknown};
 taxCommitment:string;projection:string;contributions:ResourceMiningDisposition[];
 publicationAuthorized:boolean;consumptionAuthorized:boolean;renownAuthorized:boolean;[key:string]:unknown;
}
/** Called on authoritative DB rows before planning and again on retained source.
 * Its commitment uses canonical JSON, not PostgreSQL jsonb display whitespace. */
export function validateResourceMiningOriginals(epochId:string,day:string,epochCreatedAt:string,originals:readonly ResourceMiningOriginal[],policyVersion:2|3=2){
 need(Array.isArray(originals)&&originals.length>0&&originals.length<=1000);
 const epochAt=timestamp(epochCreatedAt);need(epochCreatedAt.slice(0,10)===day);
 need(new Set(originals.map(r=>r.id)).size===originals.length);
 equal(originals,[...originals].sort((a,b)=>a.baseId.localeCompare(b.baseId)||a.id.localeCompare(b.id)));
 const free=new Map<string,bigint>();
 for(const r of originals){
  need(Object.keys(r).sort().join(',')==='actorWallet,baseId,createdAt,id,lines,pool,request,totalValue');
  const request=MiningContributionRequestSchema.parse(r.request);
  need(request.policyVersion===policyVersion&&request.baseId===r.baseId&&request.expectedDay===day&&timestamp(r.createdAt)>=epochAt&&['free','deed'].includes(r.pool));
  MiningContributionReceiptSchema.parse({id:r.id,epochId,wallet:r.actorWallet,day,request,lines:r.lines,totalValue:r.totalValue,createdAt:r.createdAt});
  need(new PublicKey(r.actorWallet).toBase58()===r.actorWallet);
  if(r.pool==='free'){const total=(free.get(r.actorWallet)??0n)+resourceMiningValue(r.totalValue);need(total<=BigInt(V2.freeValuePerWalletDay));free.set(r.actorWallet,total);}
 }
 return miningDigest(miningCanonical(originals));
}
export function auditResourceMiningManifest(input:{manifestJson:string;publication:unknown;contributions:readonly ResourceMiningOriginal[];previousPublication:AuditedPriorMiningPublication|null}){
 need(Buffer.byteLength(input.manifestJson)<=4194304);const m=JSON.parse(input.manifestJson) as ResourceMiningManifest;need(miningCanonical(m)===input.manifestJson);
 need(Array.isArray(m.captures)&&m.captures.length<=32);
 const postZero=m.version===15||m.version===16,absence=m.version===13||m.version===14,allowAbsence=absence||postZero,existing=m.version===11||m.version===12,allowExisting=existing||allowAbsence,enrolled=m.version===9||m.version===10||allowExisting,
  seeker=m.version===6||m.version===8||m.version===9||m.version===10||allowExisting&&m.captures.some(c=>Object.hasOwn(c,'seekerQualification')),
  v3=m.version===7||m.version===8||m.version===10||m.version===12||m.version===14||m.version===16;
 need(allowAbsence||m.captures.some(hasExistingMiningWalletSource)===existing);
 need(postZero||m.captures.some(hasMiningSeekerAbsenceSource)===absence);
 need(m.captures.some(hasMiningPostZeroSource)===postZero);
 need((m.version===5&&m.scope==='ordinary-resource-mining-v2'||m.version===6&&m.scope==='ordinary-resource-mining-seeker-v2'||m.version===7&&m.scope==='ordinary-resource-mining-v3'||m.version===8&&m.scope==='ordinary-resource-mining-seeker-v3'||m.version===9&&m.scope==='ordinary-resource-mining-enrolled-seeker-v2'||m.version===10&&m.scope==='ordinary-resource-mining-enrolled-seeker-v3'||m.version===11&&m.scope==='ordinary-resource-mining-existing-wallet-v2'||m.version===12&&m.scope==='ordinary-resource-mining-existing-wallet-v3'||m.version===13&&m.scope==='ordinary-resource-mining-seeker-absence-v2'||m.version===14&&m.scope==='ordinary-resource-mining-seeker-absence-v3'||m.version===15&&m.scope==='ordinary-resource-mining-zero-gems-v2'||m.version===16&&m.scope==='ordinary-resource-mining-zero-gems-v3')
  &&m.projection==='READY'&&m.publicationAuthorized===false&&m.consumptionAuthorized===false&&m.renownAuthorized===false);
 equal(m.policy,postZero?(v3?postZeroResourceMiningPolicyV3:postZeroResourceMiningPolicy):absence?(v3?seekerAbsenceResourceMiningPolicyV3:seekerAbsenceResourceMiningPolicy):existing?(v3?existingWalletResourceMiningPolicyV3:existingWalletResourceMiningPolicy):enrolled?(v3?enrolledSeekerResourceMiningPolicyV3:enrolledSeekerResourceMiningPolicy):(v3?(seeker?seekerResourceMiningPolicyV3:resourceMiningPolicyV3):(seeker?seekerResourceMiningPolicy:resourceMiningPolicy)));
 const request=z.object({epochId:z.uuid(),day:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(v3?3:2)}).strict().parse(m.input);
 const start=Date.parse(request.day+'T00:00:00Z');need(Number.isFinite(start)&&new Date(start).toISOString().slice(0,10)===request.day);
 const p=miningPublicationSchema.parse(input.publication),prior=input.previousPublication,day=BigInt(start/86400000),end=start+86400000;
 need(m.epoch.id===request.epochId&&m.epoch.key===`resource-mining-v${request.policyVersion}:${request.day}`);equal(m.previousPublication,prior?.reference??null);
 if(v3){
  const cutover=z.object({firstDay:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),policyVersion:z.literal(3),installedAt:z.string(),sha256:z.string().regex(/^[0-9a-f]{64}$/)}).strict().parse(m.epoch.cutover);
  const {sha256,...source}=cutover;need(miningDigest(miningCanonical(source))===sha256&&cutover.firstDay<=request.day);
  need(timestamp(cutover.installedAt).slice(0,10)<cutover.firstDay&&new Date(cutover.firstDay).toISOString().slice(0,10)===cutover.firstDay);
 }else need(!Object.hasOwn(m.epoch,'cutover'));
 const originals=m.epoch.contributions;equal(originals,input.contributions);
 need(validateResourceMiningOriginals(request.epochId,request.day,m.epoch.createdAt,originals,request.policyVersion)===m.epoch.contributionSetSha256);
 const funds=m.funding,c=funds.config,s=funds.source;
 need(s.programId===p.programId&&c.publisher===p.signer&&c.keepMint===p.keepMint&&c.emissionReserveOwner===p.reserveOwner);
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
 need(m.captures.some(capture=>Object.hasOwn(capture,'seekerQualification'))===seeker);
 const actors=[...new Set(originals.map(r=>r.actorWallet))].sort((a,b)=>Buffer.compare(new PublicKey(a).toBuffer(),new PublicKey(b).toBuffer()));equal(m.captures.map(c=>c.wallet),actors);
 for(const capture of m.captures){
  need(capture.day===request.day);if(capture.gemsContribution)need(capture.gemsContribution.origins.chainIdentity.keepMint===c.keepMint);
  const stock=originals.filter(r=>r.actorWallet===capture.wallet);equal(capture.bases.map(b=>b.baseId),[...new Set(stock.map(r=>r.baseId))].sort());
  for(const b of capture.bases){need(!Object.hasOwn(b,'reservedUnits'));need(resourceMiningValue(b.reservedValue)===stock.filter(r=>r.baseId===b.baseId).reduce((n,r)=>n+resourceMiningValue(r.totalValue),0n));}
 }
 const participants=m.captures.flatMap(capture=>deriveResourceMiningWallet(capture,String(s.genesisHash),seeker,enrolled?2:1,allowExisting,allowAbsence,postZero));equal(m.participants,participants);
 const result=calculateResourceMining(participants,budget,Number(c.splitCursor),prior?.declaration??null,seeker);need(result.declaration!==null);
 for(const k of ['freeBudget','deedBudget','sumWeight','denominator','freeGross','deedGross','playerNet','recycle','tax','splitStart','splitEnd','awards'] as const)equal(m[k],result[k]);
 const contributions=planResourceMiningContributions(originals,result.consumed);equal(m.contributions,contributions);
 const declaration=result.declaration!;
 for(const k of ['sequence','root','total','leafCount'] as const)equal(p[k],typeof declaration[k]==='bigint'?String(declaration[k]):declaration[k]);
 for(const k of ['budgetGross','freeGross','deedGross','playerNet','recycle','tax','splitStart','splitEnd'] as const)equal(p[k],m[k]);
 need(p.taxCommitment===m.taxCommitment);
 if(p.taxVersion===2)auditWinningMiningTaxManifest({taxManifest:m.taxManifest,funding:funds,day:request.day,taxCommitment:p.taxCommitment});
 else{
  const t=m.taxManifest,term=t.source;need(t.version===1&&t.mode==='original-term-no-beneficiary-hold'&&t.day===request.day&&t.startAt===new Date(start).toISOString()&&t.endAt===new Date(end).toISOString()&&t.futureTermReassignmentAuthorized===false);
  equal(t.beneficiaries,[]);need(miningDigest(miningCanonical(t))===p.taxCommitment&&term.source.genesisHash===s.genesisHash&&term.source.programId===s.programId
   &&term.deployment.programDataSha256===s.reviewedProgramDataSha256&&String(term.deployment.deployedSlot)===String(s.reviewedDeploymentSlot));
  need(amount(term.operatingStart)*1000n<=BigInt(start)&&amount(term.operatingEnd)*1000n>=BigInt(end)&&amount(term.completedAt)*1000n<=BigInt(start)&&term.winnerCount===0);
  const auctions=term.auctions as {winner:unknown;highBid:unknown}[];need(Array.isArray(auctions)&&auctions.length===P.seekerIsland.totalSpots&&auctions.every(a=>a.winner===null&&amount(a.highBid)===0n));
 }
 return {sourceHash:miningDigest(input.manifestJson),declaration,contributions};
}

/** Ordinary paid and deedless qualification from closed source histories.
 * Genesis and positive historical SGT rights remain held, never inferred away. */
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { ECONOMY, FORGE_INGOT, PHASE_E_POLICY as P, PHASE_E_MINING_SCORE_POLICY as S, PHASE_E_MINING_EXPERIENCE_POLICY as X } from '@shardkeep/shared';
import { miningConsistency } from '@shardkeep/shared/miningContribution';
import { FANTASY_CATALOG_HASH, FANTASY_WORLD_ID, getFantasyTile } from '@shardkeep/shared/fantasyWorld';
import { isCanonicalSolanaSignature } from '@shardkeep/chain';
import { fantasyManifestHash, validateFantasyManifest, type FantasyMigrationManifest } from '../db/fantasyMigration';
import { NATIVE_SOL_MINT } from '../money/mintDimension';
import type { Db } from '../db/client';
import { qualifyDeedMiningRosterDay, type DeedMiningRosterSource } from './deedRosterQualification';
import { readMiningWalletActivity, readExistingMiningWalletActivity } from './walletActivity';
import { replayExistingMiningWalletInterval } from './existingMiningWallet';
import { readGemsNoDebitEvidence, replayGemsNoDebitEvidence, type GemsNoDebitEvidence } from './gemsNoDebitEvidence';
import { createGemsPostZeroContributionReader, replayGemsPostZeroContribution, type GemsPostZeroContribution } from './gemsPostZeroContribution';
import { readMiningDevelopmentEvidence } from './developmentEvidence';
import { readMiningSeekerLinkHistory } from './seekerLinkHistory';
import { readMiningSeekerAbsenceInterval, validateMiningSeekerAbsenceIntervalEvidence, type MiningSeekerAbsenceIntervalEvidence } from './seekerMiningAbsence';
import { captureMiningSeekerEnrollmentQualification, replayMiningSeekerEnrollmentQualification, type MiningSeekerEnrollmentQualificationEvidence, type SeekerMiningEnrollmentWiring } from './seekerEnrollmentQualification';
import { captureMiningSeekerQualification, replayMiningSeekerQualification, type MiningSeekerQualificationEvidence, type SeekerMiningQualificationWiring } from './seekerMiningQualification';
import { readFreeGemsEvidence } from './freeGemsEvidence';

import { composeGemsContribution } from './gemsContribution';
import { readGemsSinkUseEvidence, type GemsSinkUseEvidence } from './gemsSinkUseEvidence';
import { createGemsFinalizedOriginReader, type FinalizedGemsOrigins, type GemsFinalizedOriginWiring } from './gemsFinalizedOrigins';

// The same locked SOL land price used by the canonical deposit writer.
const LAND_PRICE_LAMPORTS=Math.round(ECONOMY.entryFeeSol*LAMPORTS_PER_SOL);
export class FundedMiningSourceError extends Error {
 constructor(readonly code:'SOURCE_CONFLICT'|'CLASSIFICATION_UNAVAILABLE'|'SEEKER_HISTORY_UNAVAILABLE'|'USEFUL_CHAIN_UNAVAILABLE') {super(`Funded mining source refused: ${code}`);}
}
function need(v:unknown):asserts v{if(!v)throw new FundedMiningSourceError('SOURCE_CONFLICT');}
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const ratio=(a:number,b:number,c:number)=>Number(BigInt(a)*BigInt(b)/BigInt(c));
function count(n:number){need(Number.isSafeInteger(n)&&n>=0);return n;}
function address(v:string){need(typeof v==='string'&&v.length<=44&&new PublicKey(v).toBase58()===v);return v;}
export type OrdinaryMiningAssignment = {claimId:string;worldId:string;tileId:number;baseId:string;assetId:string;source:string;createdAt:string;assignedAt:string;catalogHash:string;allocation:string;sourceId:string;sourceHash:string;sourceEvidence:unknown}
type Activity=Awaited<ReturnType<typeof readMiningWalletActivity>>|Awaited<ReturnType<typeof readExistingMiningWalletActivity>>;
type Qualification=Awaited<ReturnType<typeof qualifyDeedMiningRosterDay>>;
type RecordedSeekerLinkHistory=Awaited<ReturnType<typeof readMiningSeekerLinkHistory>>;
/** D153.209 explicit link source for wired enrollment (qualification2 only). Its positive identity is
 * the validated committed interval's link: no birth event, coverage date, claim, status or change
 * history is recorded or implied. Replay compares it field by field against the replayed proof. */
export interface MiningEnrolledSeekerLink {
 linkSource:'committed-enrollment-interval';wallet:string;day:string;enrollmentId:string;
 link:{wallet:string;seekerWallet:string;sgtMint:string;revokedAt:null};
}
export interface MiningAbsentSeekerLink {
 linkSource:'committed-absence-interval';wallet:string;day:string;link:null;
}
export interface MiningQualificationCapture {
 wallet:string;day:string;qualification:Qualification;activity:Activity;
 gems:Awaited<ReturnType<typeof readFreeGemsEvidence>>|GemsNoDebitEvidence|GemsPostZeroContribution;gemsContribution:{use:GemsSinkUseEvidence;origins:FinalizedGemsOrigins}|null;seeker:RecordedSeekerLinkHistory|MiningEnrolledSeekerLink|MiningAbsentSeekerLink;
 seekerAbsence?:MiningSeekerAbsenceIntervalEvidence;
 seekerQualification?:MiningSeekerQualificationEvidence|MiningSeekerEnrollmentQualificationEvidence;
 bases:{baseId:string;development:Awaited<ReturnType<typeof readMiningDevelopmentEvidence>>;ordinary:OrdinaryMiningAssignment|null}[];
}
export interface FundedMiningCapture extends Omit<MiningQualificationCapture,'bases'> {
 bases:(MiningQualificationCapture['bases'][number]&{reservedUnits:number})[];
}
function enrolledSeekerLink(e:MiningSeekerEnrollmentQualificationEvidence):MiningEnrolledSeekerLink{
 const {wallet,seekerWallet,sgtMint}=e.interval.link;
 return {linkSource:'committed-enrollment-interval',wallet:e.wallet,day:e.day,enrollmentId:e.interval.enrollmentId,link:{wallet,seekerWallet,sgtMint,revokedAt:null}};
}
const isEnrolledSeekerLink=(s:MiningQualificationCapture['seeker']):s is MiningEnrolledSeekerLink=>Object.hasOwn(s,'linkSource')&&'linkSource'in s&&s.linkSource==='committed-enrollment-interval';
const isAbsentSeekerLink=(s:MiningQualificationCapture['seeker']):s is MiningAbsentSeekerLink=>Object.hasOwn(s,'linkSource')&&'linkSource'in s&&s.linkSource==='committed-absence-interval';
export const hasMiningSeekerAbsenceSource=(c:MiningQualificationCapture)=>Object.hasOwn(c,'seekerAbsence')||isAbsentSeekerLink(c.seeker);
const isExistingWalletGems=(g:MiningQualificationCapture['gems']):g is GemsNoDebitEvidence=>Object.hasOwn(g,'sourceKind')&&'sourceKind'in g&&g.sourceKind==='committed-existing-wallet-no-debit';
const isPostZeroGems=(g:MiningQualificationCapture['gems']):g is GemsPostZeroContribution=>Object.hasOwn(g,'sourceKind')&&'sourceKind'in g&&g.sourceKind==='committed-zero-inventory-fifo';
export const hasMiningPostZeroSource=(c:MiningQualificationCapture)=>isPostZeroGems(c.gems);
export const hasExistingMiningWalletSource=(c:MiningQualificationCapture)=>Object.hasOwn(c.activity.identity,'kind')||Object.hasOwn(c.gems,'sourceKind');
/** Application-owned assignment and exact original deed, not a caller class bit.
 * All mutable source tables are fenced together while copying the retained row. */
async function ordinary(db:Db,baseId:string,assetId:string,day:string):Promise<OrdinaryMiningAssignment>{
 const rows=await db.transaction(async tx=>{
  await tx.execute(sql`lock table fantasy_land_claims,fantasy_world_catalog,fantasy_world_tiles,fantasy_migration_batches,deposits,bases,plot_reservations in share mode nowait`);
  const [mode]=await tx.execute<{rc:boolean}>(sql`select current_setting('transaction_isolation')='read committed' rc`);need(mode?.rc);
  return tx.execute<OrdinaryMiningAssignment>(sql`select c.id "claimId",c.world_id "worldId",c.tile_id "tileId",c.base_id "baseId",${assetId}::text "assetId",c.source,
   to_char(c.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "createdAt",
   to_char(c.assigned_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "assignedAt",w.catalog_hash "catalogHash",t.allocation,
   coalesce(c.manifest_hash,c.deposit_id::text) "sourceId",public.shardkeep_mining_ordinary_source(c.id) "sourceEvidence",
   encode(sha256(convert_to(public.shardkeep_mining_ordinary_source(c.id)::text,'UTF8')),'hex') "sourceHash"
   from fantasy_land_claims c join fantasy_world_catalog w using(world_id) join fantasy_world_tiles t using(world_id,tile_id)
   left join fantasy_migration_batches m on m.manifest_hash=c.manifest_hash left join deposits d on d.id=c.deposit_id
   where c.base_id=${baseId} and (c.source='purchase' and c.expected_mint is null or c.source<>'purchase' and c.expected_mint=${assetId}) and c.state='assigned' and c.assigned_at<${day}::date
    and (c.source in ('migration-active','migration-inactive') and m.manifest->>'catalogHash'=w.catalog_hash
      or c.source='purchase' and d.status='credited' and d.payload->>'baseId'=c.base_id::text) limit 2`);
 });
 if(rows.length!==1)throw new FundedMiningSourceError('CLASSIFICATION_UNAVAILABLE');
 const row=rows[0]!;checkOrdinary(row,baseId,assetId,day);return row;
}
function checkOrdinary(row:OrdinaryMiningAssignment|null,baseId:string,assetId:string,day:string){
 if(!row||row.worldId!==FANTASY_WORLD_ID||row.catalogHash!==FANTASY_CATALOG_HASH||row.baseId!==baseId||row.assetId!==assetId
  ||row.allocation!=='ordinary'||getFantasyTile(row.tileId)?.allocation!=='ordinary'||!(Date.parse(row.assignedAt)<Date.parse(day))
  ||!row.claimId||!row.sourceId||!/^[a-f0-9]{64}$/.test(row.sourceHash))throw new FundedMiningSourceError('CLASSIFICATION_UNAVAILABLE');
  const evidence=row.sourceEvidence as {kind?:unknown;manifest?:unknown;deposit?:Record<string,unknown>;reservation?:Record<string,unknown>;base?:Record<string,unknown>};
  const refuse=():never=>{throw new FundedMiningSourceError('CLASSIFICATION_UNAVAILABLE');};
  try {
   if(!evidence||Buffer.byteLength(JSON.stringify(evidence))>4194304)refuse();
   if(row.source==='migration-active'||row.source==='migration-inactive'){
    if(evidence.kind!=='migration')refuse();const manifest=evidence.manifest as FantasyMigrationManifest;
    validateFantasyManifest(manifest);if(fantasyManifestHash(manifest)!==row.sourceId||Date.parse(manifest.snapshotAt)>Date.parse(row.assignedAt))refuse();
    const entry=manifest.entries.find(e=>e.baseId===baseId);
    if(!entry||entry.mintId!==assetId||entry.tileId!==row.tileId||entry.state!==(row.source==='migration-active'?'assigned':'held'))refuse();
   }else if(row.source==='purchase'){
    const d=evidence.deposit,r=evidence.reservation,b=evidence.base;if(evidence.kind!=='purchase'||!d||!r||!b)refuse();
    const payload=d!.payload as Record<string,unknown>,address=payload?.landAddress as Record<string,unknown>|undefined;
    if(d!.id!==row.sourceId||d!.status!=='credited'||!['entry','deed'].includes(String(d!.kind))||typeof d!.reference!=='string'||new PublicKey(d!.reference).toBase58()!==d!.reference
     ||typeof d!.txSignature!=='string'||!isCanonicalSolanaSignature(d!.txSignature)||d!.mint!==NATIVE_SOL_MINT||d!.amount!==String(LAND_PRICE_LAMPORTS)
     ||!payload||'devFixture' in payload||payload.baseId!==baseId||payload.amountLamports!==LAND_PRICE_LAMPORTS
     ||typeof d!.wallet!=='string'||new PublicKey(d!.wallet).toBase58()!==d!.wallet
     ||typeof d!.createdAt!=='string'||!Number.isFinite(Date.parse(d!.createdAt))||typeof d!.finalizedAt!=='string'||Date.parse(d!.createdAt)>Date.parse(d!.finalizedAt)
     ||!(Date.parse(d!.finalizedAt)<Date.parse(day))||Date.parse(d!.finalizedAt)!==Date.parse(row.assignedAt)
     ||r!.depositId!==d!.id||r!.baseId!==baseId||r!.state!=='converted'||typeof r!.id!=='string'
     ||b!.deedAssetId!==assetId||b!.deedMintAssetId!==assetId||b!.deedMintingAt!==null||Date.parse(String(b!.landPaidAt))!==Date.parse(d!.finalizedAt))refuse();
    if(r!.addressKind==='fantasy'){
     if(address?.kind!=='fantasy'||address.worldId!==row.worldId||address.tileId!==row.tileId||r!.worldId!==row.worldId||r!.tileId!==row.tileId)refuse();
    }else if(r!.addressKind==='legacy-earth'){
     if(address?.kind==='fantasy'||!Number.isSafeInteger(r!.earthCell)||typeof r!.siteId!=='string'||!Number.isSafeInteger(r!.x)||!Number.isSafeInteger(r!.y)||typeof r!.countryA3!=='string'||payload.earthCell!==r!.earthCell||payload.siteId!==r!.siteId||payload.tx!==r!.x||payload.ty!==r!.y||payload.countryA3!==r!.countryA3)refuse();
    }else refuse();
   }else refuse();
  }catch {refuse();}
}
export async function captureMiningWalletQualification(db:Db,source:DeedMiningRosterSource,wallet:string,day:string,baseIds:readonly string[],gemsSource?:GemsFinalizedOriginWiring,policyVersion:1|2=1,seekerSource?:SeekerMiningQualificationWiring,seekerEnrollmentSource?:SeekerMiningEnrollmentWiring,existingWalletSource?:{baselineId:string;openingId?:string},seekerAbsenceSource?:true):Promise<MiningQualificationCapture>{
 if(seekerAbsenceSource!==undefined&&(seekerAbsenceSource!==true||policyVersion!==2||seekerSource||seekerEnrollmentSource))throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
 const postZero=existingWalletSource!==undefined&&Object.hasOwn(existingWalletSource,'openingId');
 if(postZero){need(policyVersion===2&&typeof existingWalletSource.openingId==='string');if(!gemsSource)throw new FundedMiningSourceError('USEFUL_CHAIN_UNAVAILABLE');need(gemsSource.trust.expectedGenesisHash===source.expectedGenesisHash);}
 const input={wallet,day,policyVersion:1 as const};
 const qualification=await qualifyDeedMiningRosterDay(db,source,input);
 if(existingWalletSource&&(policyVersion!==2||seekerSource))throw new FundedMiningSourceError('SOURCE_CONFLICT');
 const activity=existingWalletSource?await readExistingMiningWalletActivity(db,{...input,baselineId:existingWalletSource.baselineId}):await readMiningWalletActivity(db,input);
 const gems=postZero?await createGemsPostZeroContributionReader(db,gemsSource!)({wallet,day,openingId:existingWalletSource!.openingId}):existingWalletSource?await readGemsNoDebitEvidence(db,{wallet,day,baselineId:existingWalletSource.baselineId}):await readFreeGemsEvidence(db,{wallet,day});
 if(seekerSource&&seekerEnrollmentSource)throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
 let seeker:MiningQualificationCapture['seeker'],seekerQualification:MiningQualificationCapture['seekerQualification'],seekerAbsence:MiningQualificationCapture['seekerAbsence'];
 if(seekerAbsenceSource){
  // This explicit source must prove absence itself. A positive-source failure
  // never selects this branch or becomes a zero-bonus fallback.
  seekerAbsence=await readMiningSeekerAbsenceInterval(db,{wallet,day});
  seeker={linkSource:'committed-absence-interval',wallet,day,link:null};
 }else if(seekerEnrollmentSource){
  // D153.209 explicit enrollment wiring: the committed interval, never a captured birth, names the link.
  // Every refusal propagates; a wired wallet has no no_link, ordinary or reduced-bonus fallback.
  if(policyVersion!==2)throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
  const proof=await captureMiningSeekerEnrollmentQualification(db,seekerEnrollmentSource,{wallet,day});
  seekerQualification=proof;seeker=enrolledSeekerLink(proof);
 }else{
  const recorded=await readMiningSeekerLinkHistory(db,input);seeker=recorded;
  if(recorded.status!=='no_link'||recorded.openingLink!==null||recorded.closingLink!==null||recorded.changes.length){
   if(policyVersion!==2||!seekerSource)throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
   seekerQualification=await captureMiningSeekerQualification(db,seekerSource,{wallet,day});
  }
 }
 let gemsContribution:MiningQualificationCapture['gemsContribution']=null;
 if(!isExistingWalletGems(gems)&&!isPostZeroGems(gems)&&!gems.zeroQualifyingCredit){
  if(!gemsSource)throw new FundedMiningSourceError('USEFUL_CHAIN_UNAVAILABLE');
  need(gemsSource.trust.expectedGenesisHash===source.expectedGenesisHash);
  const use=await readGemsSinkUseEvidence(db,{wallet,day}),origins=await createGemsFinalizedOriginReader(db,gemsSource)({wallet,day});
  composeGemsContribution(use,origins);gemsContribution={use,origins};
 }
 const bases=[];
 for(const baseId of [...new Set(baseIds)].sort()){
  const candidate=qualification.candidates.find(r=>r.baseId===baseId);
  bases.push({baseId,
   development:await readMiningDevelopmentEvidence(db,{baseId,day,policyVersion:1}),ordinary:candidate?await ordinary(db,baseId,candidate.assetId,day):null});
 }
 const result={wallet,day,qualification,activity,gems,gemsContribution,seeker,bases,...(seekerQualification?{seekerQualification}:{}),...(seekerAbsence?{seekerAbsence}:{})};
 deriveMiningWalletQualification(result,source.expectedGenesisHash,policyVersion,seekerQualification!==undefined,seekerQualification?.version??1,existingWalletSource!==undefined,seekerAbsenceSource===true,postZero);return result;
}
export async function captureFundedMiningWallet(db:Db,source:DeedMiningRosterSource,wallet:string,day:string,stock:readonly {baseId:string;qty:number}[],gemsSource?:GemsFinalizedOriginWiring,policyVersion:1|2=1):Promise<FundedMiningCapture>{
 const captured=await captureMiningWalletQualification(db,source,wallet,day,stock.map(r=>r.baseId),gemsSource,policyVersion);
 const result={...captured,bases:captured.bases.map(b=>({baseId:b.baseId,reservedUnits:stock.filter(r=>r.baseId===b.baseId).reduce((n,r)=>n+r.qty,0),development:b.development,ordinary:b.ordinary}))};
 deriveFundedMiningWallet(result,source.expectedGenesisHash,policyVersion);return result;
}
/** Recompute score and eligibility from the owner-retained reader captures.
 * Finalized provider/index truth was established at capture, not by this replay. */
export function deriveMiningWalletQualification(c:MiningQualificationCapture,genesisHash:string,policyVersion:1|2=1,allowSeekerQualification=false,seekerQualificationVersion:1|2=1,allowExistingWallet=false,allowSeekerAbsence=false,allowPostZero=false){
 need(policyVersion===1||policyVersion===2);
 const wallet=address(c.wallet),start=Date.parse(c.day+'T00:00:00Z'),end=start+86400000,q=c.qualification,a=c.activity;
 need(Number.isSafeInteger(start)&&new Date(start).toISOString().slice(0,10)===c.day);
 need(q.wallet===wallet&&q.day===c.day&&a.wallet===wallet&&a.day===c.day&&q.sourceQualification==='complete');
 const roster=q.sources.registeredRoster,deeds=q.sources.deeds;
 need(roster.wallet===wallet&&roster.day===c.day&&Date.parse(roster.observedAt)>=end&&roster.baseline.effectiveFrom<=c.day+'T00:00:00.000000Z');
 need(deeds.targetWallet===wallet&&deeds.genesisHash===genesisHash&&new Date(deeds.startAt).getTime()===start&&new Date(deeds.endAt).getTime()===end
  &&count(deeds.throughBlockTime)*1000>=end&&deeds.evidence.trust==='trusted-finalized-rpc'
  &&deeds.evidence.numMinted===deeds.evidence.assets.length&&deeds.evidence.currentSize===deeds.evidence.numMinted);
 need(new Set(deeds.evidence.assets.map(v=>v.assetId)).size===deeds.evidence.assets.length);
 // Replay every retained interval transition; a sell-and-buy-back breaks continuity.
 const held:string[]=[],continuous:string[]=[];
 for(const asset of deeds.evidence.assets){
  address(asset.assetId);let owner=asset.ownerAtStart,any=owner===wallet,all=owner===wallet;
  for(const t of asset.transactions){
   need(Number.isSafeInteger(t.blockTime)&&t.blockTime<=deeds.throughBlockTime&&Array.isArray(t.transitions));
   if(t.blockTime*1000<start)continue;
   for(const move of t.transitions){need(!t.failed&&move.from===owner);address(move.to);
    if(t.blockTime*1000<end){any ||= move.from===wallet||move.to===wallet;if(move.from!==wallet||move.to!==wallet)all=false;}owner=move.to;}
  }
  // Mint during the day is held but never continuous. Its retained horizon owner
  // may establish any-holding when no later transfer occurred.
  if(asset.mint.blockTime*1000>=start&&asset.mint.blockTime*1000<end){all=false;any ||= asset.ownerAtHorizon===wallet;}
  if(asset.ownerAtStart!==null)need(owner===asset.ownerAtHorizon);
  if(any)held.push(asset.assetId);if(all)continuous.push(asset.assetId);
 }
 need(same([...held].sort(),[...deeds.heldDuringIntervalAssetIds].sort())&&same([...continuous].sort(),[...deeds.continuouslyHeldAssetIds].sort())
  &&deeds.deedlessThroughout===(held.length===0));
 need(c.gems.wallet===wallet&&c.gems.day===c.day);
 let usefulChainBps=0;
 if(hasExistingMiningWalletSource(c)){
  need(allowExistingWallet&&policyVersion===2&&Object.hasOwn(a.identity,'kind')&&c.gemsContribution===null);
  need('kind'in a.identity&&a.identity.kind==='committed-existing-wallet');
  const identity=a.identity;
  need(same(Object.keys(identity).sort(),['baselineId','interval','kind']));
  const interval=replayExistingMiningWalletInterval(identity.interval);
  need(interval.wallet===wallet&&interval.day===c.day&&identity.baselineId===interval.baseline.id
   &&a.experienceCoverage.fromDay===interval.baseline.firstActivityDay&&a.experienceCoverage.throughDay===c.day);
  if(isPostZeroGems(c.gems)){
   need(allowPostZero);
   const gems=replayGemsPostZeroContribution(c.gems),opening=gems.flow.opening;
   need(gems.wallet===wallet&&gems.day===c.day&&opening.wallet===wallet&&opening.baselineId===identity.baselineId
    &&same(interval.baseline,opening.baseline)&&same(interval.baseline,gems.flow.identity.baseline)
    &&gems.origins.wallet===wallet&&gems.origins.day===c.day&&gems.origins.chainIdentity.expectedGenesisHash===genesisHash);
   usefulChainBps=gems.result.usefulGemsComponentBps;
  }else{
   // An unknown discriminator never becomes a no-debit fallback.
   need(isExistingWalletGems(c.gems));const gems=replayGemsNoDebitEvidence(c.gems);
   need(gems.wallet===wallet&&gems.day===c.day&&identity.baselineId===gems.baselineId&&same(interval.baseline,gems.identity.baseline));
  }
 }else if(!isExistingWalletGems(c.gems)&&!isPostZeroGems(c.gems)&&c.gems.zeroQualifyingCredit)need(c.gems.reason==='zero'&&c.gemsContribution===null);
 else {
  need(!isExistingWalletGems(c.gems)&&!isPostZeroGems(c.gems)&&c.gems.reason==='paid-origin'&&c.gemsContribution!==null);
  const {use,origins}=c.gemsContribution;need(use.wallet===wallet&&use.day===c.day&&origins.chainIdentity.expectedGenesisHash===genesisHash);
  usefulChainBps=composeGemsContribution(use,origins).usefulGemsComponentBps;
 }
 let bonusBps=0;
 if(c.seeker.wallet!==wallet||c.seeker.day!==c.day)throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
 // A discriminator is not permission to reinterpret an unknown profile as
 // either a historical link or the other explicitly selected source.
 if(Object.hasOwn(c.seeker,'linkSource')&&!isEnrolledSeekerLink(c.seeker)&&!isAbsentSeekerLink(c.seeker))throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
 if(hasMiningSeekerAbsenceSource(c)){
  if(!allowSeekerAbsence||policyVersion!==2||Object.hasOwn(c,'seekerQualification')||!isAbsentSeekerLink(c.seeker))throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
  const proof=validateMiningSeekerAbsenceIntervalEvidence(c.seekerAbsence),s=c.seeker;
  need(same(Object.keys(s).sort(),['day','link','linkSource','wallet'])&&s.link===null&&proof.wallet===wallet&&proof.day===c.day);
  if('birthEventId'in a.identity){
   need(proof.birth.eventId===a.identity.birthEventId&&proof.birth.createdAt===a.identity.bornAt
    &&proof.birth.observedAt===a.identity.observedBirthAt&&proof.marker.coverageStartedAt===a.identity.coverageStartedAt);
  }else{
   // An existing-wallet snapshot is not a birth proof. Bind its observed player
   // to the absence reader's independently captured identity without inventing one.
   const b=a.identity.interval.baseline;
   need(proof.player.wallet===b.player.wallet&&proof.player.created_at===b.player.createdAt
    &&proof.marker.coverageStartedAt===b.identityCoverageStartedAt);
  }
  // The retained interval proves ordinary absence only; bonusBps stays zero.
 }else if(Object.hasOwn(c,'seekerQualification')){
  if(!allowSeekerQualification||policyVersion!==2)throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
  need(c.seekerQualification?.version===seekerQualificationVersion);
  if(isEnrolledSeekerLink(c.seeker)){
   // Only a replayed qualification2 may name an interval-derived link; older profiles never gain it.
   if(seekerQualificationVersion!==2)throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
   const proven=replayMiningSeekerEnrollmentQualification(c.seekerQualification),expected=enrolledSeekerLink(proven.evidence),s=c.seeker,link=s.link;
   need(link!==null&&typeof link==='object'&&same(Object.keys(s).sort(),Object.keys(expected).sort())&&same(Object.keys(link).sort(),Object.keys(expected.link).sort())
    &&s.linkSource===expected.linkSource&&s.enrollmentId===expected.enrollmentId&&proven.wallet===wallet&&proven.day===c.day
    &&link.wallet===wallet&&link.revokedAt===null&&link.seekerWallet===proven.seekerWallet&&link.sgtMint===proven.sgtMint);
   bonusBps=proven.bonusBps;
  }else{
  if(isAbsentSeekerLink(c.seeker))throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
  const proven=seekerQualificationVersion===2?replayMiningSeekerEnrollmentQualification(c.seekerQualification):replayMiningSeekerQualification(c.seekerQualification),link=c.seeker.openingLink;
  need(proven.wallet===wallet&&proven.day===c.day&&c.seeker.status==='continuous_link'&&c.seeker.changes.length===0
   &&link!==null&&link.wallet===wallet&&link.revokedAt===null&&link.seekerWallet===proven.seekerWallet&&link.sgtMint===proven.sgtMint&&same(link,c.seeker.closingLink));
  bonusBps=proven.bonusBps;
  }
 }else if(isEnrolledSeekerLink(c.seeker)||isAbsentSeekerLink(c.seeker)||c.seeker.status!=='no_link'||c.seeker.openingLink!==null||c.seeker.closingLink!==null||c.seeker.changes.length)
  throw new FundedMiningSourceError('SEEKER_HISTORY_UNAVAILABLE');
 const xp=count(a.recordedXp),experience=ratio(Math.min(xp,X.xpForFullScore),P.basisPoints,X.xpForFullScore);
 need(a.experienceBps===experience&&a.todayQualifyingRaidIds.length===new Set(a.todayQualifyingRaidIds).size&&a.days.at(-1)?.day===c.day);
 const today=a.qualifiedRaids.filter(r=>r.day===c.day),activityBps=ratio(Math.min(today.length,X.raidsForFullActivity),P.basisPoints,X.raidsForFullActivity);
 need(same([...a.todayQualifyingRaidIds].sort(),today.map(r=>r.raidId).sort()));
 const walletScoreBps=Math.floor((activityBps*S.activityWeight+experience*S.experienceWeight+usefulChainBps*S.usefulChainWeight)/(S.activityWeight+S.experienceWeight+S.usefulChainWeight));
 // V2 counts each completely covered UTC day once. Reconstruct from the same
 // retained raid identities rather than trusting a client-supplied streak count.
 let consistencyBps:number=P.basisPoints;
 if(policyVersion===2){
  need(a.experienceCoverage.throughDay===c.day&&new Set(a.qualifiedRaids.map(r=>r.raidId)).size===a.qualifiedRaids.length);
  need(a.qualifiedRaids.every(r=>Number.isFinite(Date.parse(r.firstAcceptedAt))&&new Date(r.firstAcceptedAt).toISOString().slice(0,10)===r.day));
  for(const d of a.days){const ids=a.qualifiedRaids.filter(r=>r.day===d.day).map(r=>r.raidId).sort();
   need(same([...d.qualifyingRaidIds].sort(),ids));}
  need(a.qualifiedRaids.every(r=>a.days.some(d=>d.day===r.day)));
  consistencyBps=miningConsistency(c.day,a.experienceCoverage.fromDay,a.days.map(d=>({day:d.day,qualified:d.qualifyingRaidIds.length>0}))).multiplierBps;
 }
 const age=a.latestQualifiedAt===null?null:Math.max(0,(end-Date.parse(a.latestQualifiedAt))/1000);
 const retention=age===null?0:age<=P.mining.scoreGraceSec?P.basisPoints:Math.max(0,Math.floor((S.decayZeroAfterSec-age)*P.basisPoints/(S.decayZeroAfterSec-P.mining.scoreGraceSec)));
 need(c.bases.length<=P.bases.activePerWalletMax&&new Set(c.bases.map(b=>b.baseId)).size===c.bases.length);
 return [...c.bases].sort((a,b)=>a.baseId.localeCompare(b.baseId)).map(b=>{
  const before=roster.open.bases.find(v=>v.id===b.baseId),after=roster.close.bases.find(v=>v.id===b.baseId);
  const slots=roster.open.slots.filter(v=>v.base_id===b.baseId),lastSlots=roster.close.slots.filter(v=>v.base_id===b.baseId);
  const stable=!!before&&same(before,after)&&same(slots,lastSlots)&&!roster.continuityBrokenBaseIds.includes(b.baseId)
   &&before.owner_wallet===wallet&&before.status==='active'&&slots.length===1&&slots[0]!.active&&slots[0]!.wallet===wallet;
  const paid=before?.land_paid_at!==null&&before?.deed_asset_id!=null;
  const pool=paid?'deed' as const:'free' as const;
  let eligible=stable&&today.length>0;
  if(paid){eligible &&= Date.parse(before!.land_paid_at!)<start&&before!.deed_minting_at===null&&continuous.includes(before!.deed_asset_id!);
   if(eligible)checkOrdinary(b.ordinary,b.baseId,before!.deed_asset_id!,c.day);
  }else eligible &&= deeds.deedlessThroughout&&before?.land_paid_at===null&&before.deed_asset_id===null&&before.deed_mint_asset_id===null&&before.deed_minting_at===null;
  const d=b.development;need(d.baseId===b.baseId&&d.day===c.day&&d.policyVersion===S.version&&Date.parse(d.cutoffAt)===end);
  let progress=0,parts=0;
  for(const kind of ['keep','workshop','goldforge'] as const){need(d.completed[kind].length<=1);const level=count(d.completed[kind][0]?.level??0),weight=S.developmentWeights[kind];
   eligible &&= level>=S.requiredLevel[kind];if(kind==='keep')eligible &&= d.base?.keep_level===level;
   progress+=ratio(Math.min(level,S.fullLevel[kind]),P.basisPoints,S.fullLevel[kind])*weight;parts+=weight;}
  eligible &&= d.base?.owner_wallet===wallet&&d.base.status==='active';
  const progressionBps=Math.floor(progress/parts),baseMultiplier=S.baseFloorBps+ratio(progressionBps,S.baseProgressBps,P.basisPoints);
  const originalScore=ratio(ratio(walletScoreBps,baseMultiplier,P.basisPoints),retention,P.basisPoints);
  const score=ratio(originalScore,consistencyBps,P.basisPoints);
  return {wallet,baseId:b.baseId,pool,eligible:eligible&&score>0,progressionBps,walletScoreBps,usefulChainBps,retentionBps:retention,baseScoreBps:score,bonusBps};
 });
}
/** Historical wrappers retain original capacities and exact ingot output fields. */
export function deriveFundedMiningWallet(c:FundedMiningCapture,genesisHash:string,policyVersion:1|2=1){
 c.bases.forEach(b=>count(b.reservedUnits));
 let freeRoom:number=P.mining.freeCapacityUnitsPerWalletDay;
 return deriveMiningWalletQualification(c,genesisHash,policyVersion).map(q=>{
  const reservedUnits=c.bases.find(b=>b.baseId===q.baseId)!.reservedUnits,paid=q.pool==='deed';
  const capacity=paid?(policyVersion===2?null:FORGE_INGOT.capacity.deedMinUnits+ratio(q.progressionBps,FORGE_INGOT.capacity.deedMaxUnits-FORGE_INGOT.capacity.deedMinUnits,P.basisPoints)):freeRoom;
  const units=q.eligible?Math.min(capacity??reservedUnits,reservedUnits):0;if(!paid)freeRoom-=units;
  return {wallet:q.wallet,baseId:q.baseId,pool:q.pool,reservedUnits,eligibleUnits:units,progressionBps:q.progressionBps,walletScoreBps:q.walletScoreBps,usefulChainBps:q.usefulChainBps,retentionBps:q.retentionBps,baseScoreBps:q.baseScoreBps,
   capacityUnits:capacity,bonusBps:0,weight:(BigInt(units)*BigInt(q.baseScoreBps)).toString()};
 });
}

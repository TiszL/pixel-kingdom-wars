/** Retained complete free-only history, supplied by application wiring. A caller
 * declaration proves arithmetic only; the owner loader authenticates its receipt. */
import bs58 from 'bs58';
import { z } from 'zod';
import { PHASE_E_MINING_PUBLICATION as SPLIT,PHASE_E_POLICY as P,TOKEN } from '@shardkeep/shared';
import { buildMiningAllocationTree,MINING_ALLOCATION_U64_MAX } from '@shardkeep/chain/mining-allocation';
import type { MiningBackingSnapshot } from '@shardkeep/chain/mining-backing';
import { auditMiningAllocation,type MiningAllocationPublication } from './allocationAudit';
// Technical retained-history work bound, below the chain's 65,536-leaf format.
export const CUMULATIVE_FREE_MAX_LEAVES=10_000;
const uint=z.bigint().min(0n).max(MINING_ALLOCATION_U64_MAX),hash=z.string().regex(/^[0-9a-f]{64}$/);
const decimal=z.string().max(20).regex(/^(0|[1-9][0-9]*)$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<=MINING_ALLOCATION_U64_MAX);
const referenceSchema=z.object({epochId:z.uuid(),sequence:decimal,day:decimal,root:hash,total:decimal,leafCount:z.number().int().positive().max(CUMULATIVE_FREE_MAX_LEAVES),sourceHash:hash,
 signature:z.string().min(64).max(88).refine(v=>{if(v.length>88)return false;try{const bytes=bs58.decode(v);return bytes.length===64&&bs58.encode(bytes)===v;}catch{return false;}}),publicationSlot:z.number().int().nonnegative().safe(),messageSha256:hash,wireSha256:hash}).strict();
const frontierSchema=z.object({genesisDay:uint,latestSequence:uint,latestDay:uint,totalPublished:uint,totalPublishedHighwater:uint,taxHighwater:uint,recycledTotal:uint,grossPublished:uint,splitCursor:z.number().int().min(0).max(SPLIT.splitPeriod-1)}).strict();
export type MiningPriorReference=z.infer<typeof referenceSchema>;
export interface AuditedPriorMiningPublication{
 readonly reference:MiningPriorReference;
 readonly declaration:MiningAllocationPublication;
 readonly frontier:z.infer<typeof frontierSchema>;
}
export class CumulativeFreePublicationError extends Error{constructor(readonly code:'SOURCE_CONFLICT'|'TOO_LARGE'='SOURCE_CONFLICT'){super(`Cumulative-free publication refused: ${code}`);this.name='CumulativeFreePublicationError';}}
function need(value:unknown):asserts value{if(!value)throw new CumulativeFreePublicationError();}
function complete(prior:MiningAllocationPublication):MiningAllocationPublication{
 need(prior&&typeof prior==='object'&&Array.isArray(prior.leaves));
 if(prior.leaves.length>CUMULATIVE_FREE_MAX_LEAVES)throw new CumulativeFreePublicationError('TOO_LARGE');
 need(uint.safeParse(prior.sequence).success&&prior.sequence>0n&&uint.safeParse(prior.total).success&&hash.safeParse(prior.root).success);
 // buildMiningAllocationTree validates and copies every protocol field and rejects duplicates.
 const tree=buildMiningAllocationTree(prior.leaves);
 need(tree.leaves.every(row=>row.sequence===prior.sequence)&&tree.total===prior.total&&tree.leafCount===prior.leafCount&&Buffer.from(tree.root).toString('hex')===prior.root);
 return Object.freeze({sequence:prior.sequence,root:prior.root,total:tree.total,leafCount:tree.leafCount,leaves:Object.freeze(tree.leaves.map(row=>Object.freeze({...row})))});
}
/** Own bounded copies before any later await; never retain mutable loader data. */
export function copyAuditedPriorMiningPublication(prior:AuditedPriorMiningPublication):AuditedPriorMiningPublication{
 try{
  const reference=referenceSchema.parse(prior.reference),declaration=complete(prior.declaration),frontier=frontierSchema.parse(prior.frontier);
  need(reference.sequence===String(declaration.sequence)&&reference.root===declaration.root&&reference.total===String(declaration.total)&&reference.leafCount===declaration.leafCount);
  need(frontier.latestSequence===declaration.sequence&&reference.day===String(frontier.latestDay)&&frontier.genesisDay>0n&&frontier.latestDay>=frontier.genesisDay);
  need(frontier.totalPublished===declaration.total&&frontier.totalPublishedHighwater===declaration.total&&frontier.grossPublished===declaration.total+frontier.taxHighwater+frontier.recycledTotal);
  return Object.freeze({reference:Object.freeze(reference),declaration,frontier:Object.freeze(frontier)});
 }catch(error){if(error instanceof CumulativeFreePublicationError)throw error;throw new CumulativeFreePublicationError();}
}
type CapturedFunding={config:Record<string,unknown>;chainDay:unknown;vaultAmount:unknown;playerOutstanding:unknown;taxOutstanding:unknown;totalOutstanding:unknown;availableBudget:unknown;maximumEpochBudget:unknown;slot:unknown};
/** Both the live snapshot and its canonical JSON capture follow the same exact
 * liability subtraction. Claimed KEEP and paid tax may advance within bounds. */
export function assertCumulativeMiningCapture(value:unknown,previous:AuditedPriorMiningPublication):void{
 try{
  need(value&&typeof value==='object');const funds=value as CapturedFunding,c=funds.config;need(c&&typeof c==='object');
  const prior=copyAuditedPriorMiningPublication(previous),read=(v:unknown)=>typeof v==='bigint'?uint.parse(v):BigInt(decimal.parse(v));
  need(c.correctionPending===false&&c.splitCursor===prior.frontier.splitCursor);
  for(const key of ['genesisDay','latestSequence','latestDay','totalPublished','totalPublishedHighwater','taxHighwater','recycledTotal','grossPublished'] as const)need(read(c[key])===prior.frontier[key]);
  need(typeof funds.slot==='number'&&Number.isSafeInteger(funds.slot)&&funds.slot>=prior.reference.publicationSlot);
  const claimed=read(c.totalClaimed),taxPaid=read(c.taxPaid);need(claimed<=prior.frontier.totalPublishedHighwater&&taxPaid<=prior.frontier.taxHighwater);
  const player=prior.frontier.totalPublishedHighwater-claimed,tax=prior.frontier.taxHighwater-taxPaid,total=player+tax,vault=read(funds.vaultAmount);
  need(read(funds.playerOutstanding)===player&&read(funds.taxOutstanding)===tax&&read(funds.totalOutstanding)===total&&vault>=total);
  const available=vault-total,ceiling=BigInt(P.mining.grossDailyCeilingKeep)*10n**BigInt(TOKEN.decimals);
  need(read(funds.availableBudget)===available&&read(funds.maximumEpochBudget)===(available<ceiling?available:ceiling));
 }catch(error){if(error instanceof CumulativeFreePublicationError)throw error;throw new CumulativeFreePublicationError();}
}
export function assertCumulativeMiningFunding(funds:MiningBackingSnapshot,prior:AuditedPriorMiningPublication):void{assertCumulativeMiningCapture(funds,prior);}
export function assertCumulativeMiningDay(day:bigint,chainDay:bigint,prior:AuditedPriorMiningPublication):void{
 need(day>prior.frontier.latestDay&&day>=prior.frontier.genesisDay&&day<chainDay&&day-prior.frontier.latestDay<=BigInt(SPLIT.publisherMaxGapDays));
}
/** Retain all prior wallets (including inactive and zero-valued rights), change
 * only this day's KEEP, and let the generic audit prove the complete transition. */
export function buildCumulativeFreeDeclaration(previous:MiningAllocationPublication|null,awards:readonly {wallet:string;net:bigint}[]){
 try{
 const prior=previous===null?null:complete(previous),sequence=(prior?.sequence??0n)+1n;
 need(Array.isArray(awards)&&awards.length<=32&&new Set(awards.map(a=>a.wallet)).size===awards.length);
 const next=new Map((prior?.leaves??[]).map(row=>[row.wallet,{...row,sequence}]));
 for(const award of awards){need(uint.safeParse(award.net).success);if(award.net===0n)continue;
  const old=next.get(award.wallet);if(!old&&next.size>=CUMULATIVE_FREE_MAX_LEAVES)throw new CumulativeFreePublicationError('TOO_LARGE');
  next.set(award.wallet,{wallet:award.wallet,sequence,cumulativeKeep:(old?.cumulativeKeep??0n)+award.net,cumulativeRenown:old?.cumulativeRenown??0n,cumulativeDays:old?.cumulativeDays??0n});
 }
 const tree=buildMiningAllocationTree([...next.values()]);
 return auditMiningAllocation({previousPublication:prior,nextPublication:{sequence,root:Buffer.from(tree.root).toString('hex'),total:tree.total,leafCount:tree.leafCount,leaves:tree.leaves}});
 }catch(error){if(error instanceof CumulativeFreePublicationError)throw error;throw new CumulativeFreePublicationError();}
}

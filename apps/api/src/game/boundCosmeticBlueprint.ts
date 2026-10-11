/** Bound cosmetics C2: private read-only Blueprint eligibility source. The
 * Architect Blueprint is earned once by the ORIGINAL actor of one actually
 * completed ordinary refining job (any refine_* recipe with at least one
 * output). This reader proves that from immutable crafting history through the
 * existing readOrdinaryCrafting validator inside one repeatable-read, read-only
 * snapshot. It never grants, writes, settles, or reads for a caller-supplied
 * base; a missing or self-contradicting source fails explicitly, never grants;
 * a base's later owner earns nothing from the original actor's job. */
import {PHASE_E_BOUND_COSMETICS as POLICY} from '@shardkeep/shared';
import {BOUND_COSMETIC_BLUEPRINT_ID} from '@shardkeep/shared/phaseEBoundCosmetics';
import {ORDINARY_REFINED_IDS} from '@shardkeep/shared/phaseEOrdinaryCrafting';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from '../db/client';
import {readOrdinaryCrafting} from './ordinaryCrafting';

const RULE=POLICY.v1.blueprint;
export type BoundCosmeticBlueprintReason='NOT_CONFIGURED'|'SOURCE_UNAVAILABLE'|'SOURCE_CONFLICT';
export interface BoundCosmeticBlueprintProof{blueprintId:typeof BOUND_COSMETIC_BLUEPRINT_ID;jobId:string;baseId:string;actorWallet:string;completedAt:string}
export type BoundCosmeticBlueprintEligibility=
 |{state:'eligible';proof:BoundCosmeticBlueprintProof}
 |{state:'not-earned';proof:null}
 |{state:'unavailable';reason:BoundCosmeticBlueprintReason;proof:null};
export class BoundCosmeticBlueprintError extends Error{constructor(readonly code:'INVALID_INPUT'|'TOP_LEVEL'){super(`Bound cosmetic blueprint read refused: ${code}`);this.name='BoundCosmeticBlueprintError';}}
class SourceUnavailable extends Error{constructor(readonly reason:BoundCosmeticBlueprintReason){super(`Bound cosmetic blueprint source ${reason}`);this.name='BoundCosmeticBlueprintSourceUnavailable';}}
const conflict=()=>new SourceUnavailable('SOURCE_CONFLICT');
function need(v:unknown):asserts v{if(!v)throw conflict();}
const Uuid=z.uuid().regex(/^[0-9a-f-]+$/);
const proofSchema=z.object({blueprintId:z.literal(BOUND_COSMETIC_BLUEPRINT_ID),jobId:Uuid,baseId:Uuid,actorWallet:z.string().min(32).max(44),
 completedAt:z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/).refine(v=>new Date(v).toISOString()===v)}).strict();
function walletKey(value:unknown):string{
 if(typeof value!=='string'||value.length<32||value.length>44)throw new BoundCosmeticBlueprintError('INVALID_INPUT');
 try{const p=new PublicKey(value);if(p.toBase58()!==value||p.equals(PublicKey.default))throw 0;return value;}catch{throw new BoundCosmeticBlueprintError('INVALID_INPUT');}
}
/** A five-character SQLSTATE or driver/socket code means the source could not be
 * read; a reader integrity throw (plain Error, ZodError) or a SQL raise means the
 * immutable history disagrees with itself. Neither ever becomes eligibility. */
function classify(error:unknown):BoundCosmeticBlueprintReason{
 if(error instanceof SourceUnavailable)return error.reason;
 let v=error;for(let n=0;n<8&&v&&typeof v==='object';n++){
  const code=(v as {code?:unknown}).code;
  if(typeof code==='string'&&code.length>0)return /^[0-9A-Z]{5}$/.test(code)&&code!=='P0001'||!/^[0-9A-Z]{5}$/.test(code)?'SOURCE_UNAVAILABLE':'SOURCE_CONFLICT';
  v=(v as {cause?:unknown}).cause;
 }
 return 'SOURCE_CONFLICT';
}
const REFINING_RECIPES=new Set(ORDINARY_REFINED_IDS.map(id=>`refine_${id}`));

async function selectProof(tx:DbTx,wallet:string):Promise<BoundCosmeticBlueprintProof|null>{
 // Private owner capability only: the crafting history tables are read through the service owner, never a promoted request role.
 const [owner]=await tx.execute<{allowed:boolean}>(sql`select current_user::regrole::oid=(select relowner from pg_class where oid='public.ordinary_crafting_jobs'::regclass) allowed`);
 if(!owner?.allowed)throw new SourceUnavailable('NOT_CONFIGURED');
 // Deterministic selection: the earliest actually completed refining job of this ORIGINAL actor. A pending job has
 // neither a completion time nor a receipt and is never selected; a base's later owner is never the actor. A job that
 // is completed on one side only (time without receipt, or receipt without time) is a half-state that IS selected so
 // that the reader refuses it, and a selected row that fails proof fails the read rather than being skipped.
 const rows=await tx.execute<{id:string}>(sql`select j.id from public.ordinary_crafting_jobs j left join public.ordinary_crafting_completions c on c.job_id=j.id
  where j.actor_wallet=${wallet} and (j.completed_at is not null or c.job_id is not null) and j.recipe_id like 'refine\\_%' and j.output_quantity>=${RULE.minimumOutputsPerJob}
  order by coalesce(c.completed_at,j.completed_at),j.id limit ${RULE.qualifyingCompletedRefiningJobs}`);
 if(rows.length<RULE.qualifyingCompletedRefiningJobs)return null;
 let first:BoundCosmeticBlueprintProof|null=null;
 for(const {id} of rows){
  const proven=await readOrdinaryCrafting(tx,id);need(proven);const {job,completion}=proven;
  need(completion!==null&&job.id===id&&job.actorWallet===wallet&&REFINING_RECIPES.has(job.recipeId)&&job.recipeSnapshot.recipeId===job.recipeId
   &&job.recipeSnapshot.output.itemId===job.outputItemId&&job.recipeId===`refine_${job.outputItemId}`&&job.outputQuantity>=BigInt(RULE.minimumOutputsPerJob)
   &&job.completedAt!==null&&completion.completedAt.getTime()===job.completedAt.getTime()&&completion.completedAt.getTime()>=job.readyAt.getTime());
  const proof=proofSchema.safeParse({blueprintId:BOUND_COSMETIC_BLUEPRINT_ID,jobId:job.id,baseId:job.baseId,actorWallet:job.actorWallet,completedAt:completion.completedAt.toISOString()});
  need(proof.success);first??=proof.data;
 }
 return first;
}

/** Read-only, no grant. For root's once-only grant transaction:
 * - call with the top-level Phase E service-owner Db, OUTSIDE the write transaction (a transaction handle throws
 *   TOP_LEVEL; a non-owner Db answers NOT_CONFIGURED);
 * - a thrown BoundCosmeticBlueprintError is a wiring fault (bad wallet / wrong handle), never "not earned";
 * - the earliest-job proof can differ between snapshots because settlements on different bases commit out of order,
 *   so key the once-only grant on (actorWallet, blueprintId), not on proof.jobId; re-bind the proof's job inside the
 *   grant transaction with readOrdinaryCrafting(tx, proof.jobId) under your own locks. */
export async function readBoundCosmeticBlueprintEligibility(db:Db,authenticatedWallet:string):Promise<BoundCosmeticBlueprintEligibility>{
 if('rollback'in db)throw new BoundCosmeticBlueprintError('TOP_LEVEL');
 const wallet=walletKey(authenticatedWallet);
 try{
  const proof=await db.transaction(tx=>selectProof(tx,wallet),{isolationLevel:'repeatable read',accessMode:'read only'});
  return proof===null?{state:'not-earned',proof:null}:{state:'eligible',proof};
 }catch(error){return {state:'unavailable',reason:classify(error),proof:null};}
}

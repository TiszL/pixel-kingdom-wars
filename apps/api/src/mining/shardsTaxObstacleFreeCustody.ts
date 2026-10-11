/** Registered-free base custody, never global wallet deedlessness or issuance.
 * Only an actual prospective origin and uninterrupted metadata history qualify;
 * missing old witnesses and paid/pending-deed states remain unresolved. */
import {createHash} from 'node:crypto';
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {DbOrTx} from '../db/client';
import {HttpError} from '../lib/errors';
import {readLockedShardsObstacleSource,type ShardsObstacleSource} from './shardsTaxObstacleSource';

const uuid=z.uuid().refine(v=>v===v.toLowerCase());
const key=z.string().min(32).max(44).refine(v=>{try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const baseState=z.object({id:uuid,owner_wallet:key,status:z.literal('active'),land_paid_at:z.null(),deed_asset_id:z.null(),
 deed_mint_asset_id:z.null(),deed_minting_at:z.null()}).strict();
const rowSchema=z.object({obligation_id:uuid,original_obligation:z.record(z.string(),z.unknown()),original_base:baseState,
 tx_key:z.string().regex(/^[1-9][0-9]{0,19}$/).refine(v=>BigInt(v)<=(1n<<64n)-1n),valid:z.literal(true),changed:z.literal(false)}).strict();
function held(message:string):never{throw new HttpError(503,`Obstacle free custody held: ${message}`,'SHARDS_OBSTACLE_FREE_CUSTODY_UNAVAILABLE');}
function freeze<T>(value:T):T{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
interface FreeOrigin{
 readonly obligationId:string;readonly originalObligation:Readonly<Record<string,unknown>>;
 readonly originalBase:Readonly<z.infer<typeof baseState>>;readonly txKey:string;
}
export interface ShardsObstacleFreeCustodyEvidence{
 readonly version:1;readonly purpose:'historical_obstacle_custody';readonly obligation:ShardsObstacleSource['obligation'];
 readonly accelerations:ShardsObstacleSource['accelerations'];readonly earnedAt:string;
 readonly custody:Readonly<{status:'confirmed';baseId:string;wallet:string;startsAt:string;endsAt:string;evidenceSha256:string}>;
 readonly source:Readonly<{kind:'registered_free_base';origin:FreeOrigin}>;
 readonly sourceVerified:true;readonly walletDeedlessnessAuthorized:false;
 readonly postingAuthorized:false;readonly payoutAuthorized:false;readonly operatingAdmissionAuthorized:false;
}
/** This local-only reader may share an outer transaction. The caller must not
 * treat a serialized result as authority for a later issuer transaction. */
export async function readShardsObstacleFreeCustody(db:DbOrTx,obligationId:string,deps:{clock?:()=>Date}={}):Promise<ShardsObstacleFreeCustodyEvidence>{
 uuid.parse(obligationId);const clock=deps.clock??(()=>new Date());
 return db.transaction(async tx=>{
  const local=await readLockedShardsObstacleSource(tx,obligationId);
  if(local.obligation.deedAssetId!==null)held('original registered-free base required');
  const [raw]=await tx.execute(sql`select o.obligation_id,
   o.original_obligation||jsonb_build_object('gross',o.original_obligation->>'gross') original_obligation,
   o.original_base,o.tx_key,public.shardkeep_shards_obstacle_base_origin_valid(o) valid,
   exists(select 1 from shards_obstacle_base_changes c where c.obligation_id=o.obligation_id) changed
   from shards_obstacle_base_origins o where o.obligation_id=${obligationId}`);
  const parsed=rowSchema.safeParse(raw);if(!parsed.success)held('original free classification or uninterrupted history unavailable');
  const row=parsed.data;
  if(row.original_base.id!==local.obligation.baseId||row.original_base.owner_wallet!==local.obligation.wallet
   ||row.original_obligation.id!==obligationId||row.original_obligation.evidence_sha256!==local.obligation.evidenceSha256
   ||row.original_obligation.gross!==local.obligation.gross)held('original source differs from capture');
  // Base locks prevent a concurrent classification transition until this read
  // completes. Sample the server clock only after all local evidence/lock waits.
  const milliseconds=clock().getTime();
  if(!Number.isSafeInteger(milliseconds)||milliseconds<=Date.parse(local.earnedAt))held('earning interval not closed');
  const checkedAt=new Date(milliseconds).toISOString();if(checkedAt.length!==24)held('canonical observation time required');
  const origin=freeze({obligationId:row.obligation_id,originalObligation:row.original_obligation,originalBase:row.original_base,txKey:row.tx_key});
  const source=freeze({kind:'registered_free_base' as const,origin});
  const evidenceSha256=createHash('sha256').update(JSON.stringify({version:1,kind:'obstacle_registered_free_custody',
   originalSource:local.fingerprint,source,checkedAt})).digest('hex');
  return freeze({version:1 as const,purpose:'historical_obstacle_custody' as const,obligation:local.obligation,
   accelerations:local.accelerations,earnedAt:local.earnedAt,
   custody:{status:'confirmed' as const,baseId:local.obligation.baseId,wallet:local.obligation.wallet,
    startsAt:local.obligation.capturedAt,endsAt:checkedAt,evidenceSha256},source,
   sourceVerified:true as const,walletDeedlessnessAuthorized:false as const,postingAuthorized:false as const,
   payoutAuthorized:false as const,operatingAdmissionAuthorized:false as const});
 });
}

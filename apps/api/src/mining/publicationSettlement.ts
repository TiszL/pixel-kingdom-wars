import { isResourceMiningManifest } from './resourceMiningAudit';
/** Internal original-publication recovery. No signing, broadcast or claim authority. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { createMiningPublicationReceiptVerifier,type MiningPublicationReader,type MiningPublicationTrust } from '@shardkeep/chain/mining-publication';
import type { PublishMiningInput } from '@shardkeep/chain/mining-program';
import type { Db,DbOrTx } from '../db/client';
import { getMiningPublicationAttempt,type MiningPublicationAttempt } from './publicationCustody';
import { getResourceMiningPublicationAttempt,type ResourceMiningPublicationAttempt } from './resourcePublicationCustody';
import { miningCanonical } from './fundedMiningAudit';
import type { ResourceMiningOriginal, ResourceMiningDisposition } from './resourceMiningAllocation';
import { settleMiningContribution } from '../game/miningContributions';
import { getPreparedMiningPublication } from './publicationPreparation';
import { auditStoredFreePublication, auditStoredResourcePublication } from './publicationHistory';
const hash=(v:string|Uint8Array)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown):string=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
const uuid=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),hex=z.string().regex(/^[0-9a-f]{64}$/);
const decimal=z.string().regex(/^(0|[1-9][0-9]*)$/).max(20).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const requestSchema=z.object({epochId:uuid,attemptKey:z.string().min(8).max(128),signature:z.string().min(64).max(88),signedTransaction:z.instanceof(Uint8Array)}).strict();
const publicationSchema=z.object({signer:z.string().max(44),programId:z.string().max(44),keepMint:z.string().max(44),reserveOwner:z.string().max(44),sequence:decimal,root:hex,total:decimal,leafCount:z.number().int().positive().max(10000),kind:z.literal(0),day:decimal,budgetGross:decimal,freeGross:decimal,deedGross:decimal,playerNet:decimal,recycle:decimal,tax:decimal,taxCommitment:hex,taxVersion:z.number().int().positive(),splitStart:z.number().int().nonnegative(),splitEnd:z.number().int().nonnegative(),blockhashContextSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)});
const reservationSchema=z.object({reservationId:uuid,baseId:uuid,actorWallet:z.string().max(44),reserved:z.number().int().positive(),proposedConsumed:z.number().int().nonnegative(),proposedReturned:z.number().int().nonnegative()}).strict();
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'SOURCE_CONFLICT'|'NOT_PREPARED'|'IDEMPOTENCY_BODY_MISMATCH'|'RECEIPT_UNAVAILABLE'|'BUSY'|'BASE_BUSY';
export class MiningPublicationSettlementError extends Error{constructor(readonly code:Code){super(`Mining publication settlement refused: ${code}`);this.name='MiningPublicationSettlementError';}}
function fail(code:Code):never{throw new MiningPublicationSettlementError(code);}
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_publication_settlements'::regclass) allowed`);if(!r?.allowed)fail('OWNER_REQUIRED');}
type ManifestRow={manifest_json:string;source_hash:string;intent_sha256:string;publication:unknown};
type Custody = { domain:'ingots'; attempt:MiningPublicationAttempt } | { domain:'resources'; attempt:ResourceMiningPublicationAttempt };
async function manifest(db:DbOrTx,epochId:string,custody:Custody){
 const [m]=await db.execute<ManifestRow>(sql`select manifest_json,source_hash,intent_sha256,publication from mining_publication_manifests where epoch_id=${epochId}`);if(!m)fail('NOT_PREPARED');
 try{
  if(Buffer.byteLength(m.manifest_json)>4194304||hash(m.manifest_json)!==m.source_hash)fail('SOURCE_CONFLICT');
  if(custody.domain==='resources')await auditStoredResourcePublication(db,{manifestJson:m.manifest_json,publication:m.publication});
  else await auditStoredFreePublication(db,{manifestJson:m.manifest_json,publication:m.publication,reservations:custody.attempt.reservations});
  const p=publicationSchema.parse(m.publication),raw=JSON.parse(m.manifest_json) as Record<string,unknown>;
  if((raw['input'] as Record<string,unknown>)?.['epochId']!==epochId)fail('SOURCE_CONFLICT');
  if(custody.domain==='resources'){
   if(!isResourceMiningManifest(raw.version)||!Array.isArray(raw.contributions)||raw.contributions.length!==custody.attempt.contributionCount)fail('SOURCE_CONFLICT');
   // The independent audit above derives and checks the exact full basket plan.
   return {m,p,reservations:[],contributions:raw.contributions as ResourceMiningDisposition[]};
  }
  if(!Array.isArray(raw.reservations)||raw.reservations.length>10000)fail('SOURCE_CONFLICT');
  const reservations=z.array(reservationSchema).min(1).parse(raw.reservations);
  return {m,p,reservations,contributions:[] as ResourceMiningDisposition[]};
 }catch(e){if(e instanceof MiningPublicationSettlementError)throw e;fail('SOURCE_CONFLICT');}
}
interface Disposition{reservationId:string;baseId:string;actorWallet:string;consumed:number;returned:number}
export interface MiningPublicationSettlementRequest{epochId:string;attemptKey:string;signature:string;signedTransaction:Uint8Array}
export interface MiningPublicationSettlement{epochId:string;signature:string;messageSha256:string;wireSha256:string;receipt:Record<string,unknown>;finalizedAt:string;dispositions:Disposition[]}
export type ResourceMiningPublicationSettlement=Omit<MiningPublicationSettlement,'dispositions'>&{contributions:ResourceMiningDisposition[]};
type Domain='ingots'|'resources';
type Settlement<D extends Domain>=D extends 'resources'?ResourceMiningPublicationSettlement:MiningPublicationSettlement;
async function read<D extends Domain>(db:DbOrTx,epochId:string,domain:D):Promise<Settlement<D>|null>{
 if(domain==='resources'){
  const [r]=await db.execute<{result:ResourceMiningPublicationSettlement}>(sql`select jsonb_build_object('epochId',s.epoch_id,'signature',s.signature,'messageSha256',s.message_sha256,'wireSha256',s.wire_sha256,'receipt',s.receipt,'finalizedAt',to_char(s.finalized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'contributions',(
   select jsonb_agg(jsonb_build_object('id',r.id,'baseId',r.base_id,'actorWallet',r.actor_wallet,'totalValue',r.total_value::text,'outcome',t.outcome,
    'lines',(select jsonb_agg(jsonb_build_object('resourceId',l.resource_id,'quantity',l.quantity::text,'unitValue',l.unit_value::text,'value',l.value::text) order by l.resource_id) from mining_contribution_lines l where l.receipt_id=r.id)) order by r.base_id,r.id)
   from mining_contribution_terminals t join mining_contribution_receipts r on r.id=t.receipt_id where t.epoch_id=s.epoch_id)) result
   from mining_publication_settlements s join mining_publication_attempts a using(epoch_id) where s.epoch_id=${epochId} and a.contributions is not null`);
  return (r?.result??null) as Settlement<D>|null;
 }

 const [r]=await db.execute<{result:MiningPublicationSettlement}>(sql`select jsonb_build_object('epochId',s.epoch_id,'signature',s.signature,'messageSha256',s.message_sha256,'wireSha256',s.wire_sha256,'receipt',s.receipt,'finalizedAt',to_char(s.finalized_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'dispositions',(select jsonb_agg(jsonb_build_object('reservationId',r.id,'baseId',r.base_id,'actorWallet',r.actor_wallet,'consumed',d.consumed_qty,'returned',d.returned_qty) order by r.base_id,r.id) from mining_ingot_dispositions d join mining_ingot_reservations r on r.id=d.reservation_id where d.epoch_id=s.epoch_id)) result from mining_publication_settlements s where s.epoch_id=${epochId}`);
 return (r?.result??null) as Settlement<D>|null;
}
/** Factory authority is application-owned; per-request input supplies only the
 * original wire/signature to reconcile. Accepted settlement replay needs no RPC.
 * Funding is already final: an admission pause does not erase its obligations. */
type Sources={reader:MiningPublicationReader;trust:MiningPublicationTrust;resourceClock?:()=>Date};
export function createMiningPublicationSettlement(db:Db,sources:Sources){return createSettlement(db,sources,'ingots');}
export function createResourceMiningPublicationSettlement(db:Db,sources:Sources){return createSettlement(db,sources,'resources');}
function createSettlement<D extends Domain>(db:Db,sources:Sources,domain:D){
 const verify=createMiningPublicationReceiptVerifier(sources.reader,sources.trust);
 const identity={programId:sources.trust.programId.toBase58(),keepMint:sources.trust.keepMint.toBase58(),reserveOwner:sources.trust.reserveOwner.toBase58()};
 return async(input:MiningPublicationSettlementRequest):Promise<Settlement<D>>=>{
  const parsed=requestSchema.safeParse(input);if(!parsed.success||parsed.data.signedTransaction.length<1||parsed.data.signedTransaction.length>1232)fail('INVALID_INPUT');
  const {epochId,attemptKey,signature}=parsed.data,wire=Buffer.from(parsed.data.signedTransaction),wireHash=hash(wire);
  await owner(db);
  const load=async():Promise<Custody>=>{
   if(domain==='resources'){const attempt=await getResourceMiningPublicationAttempt(db,epochId);if(!attempt)fail('NOT_PREPARED');return {domain,attempt};}
   const attempt=await getMiningPublicationAttempt(db,epochId);if(!attempt)fail('NOT_PREPARED');return {domain:'ingots',attempt};
  };
  const custody=await load(),attempt=custody.attempt;
  if(attempt.attemptKey!==attemptKey)fail('IDEMPOTENCY_BODY_MISMATCH');
  const replay=(r:Settlement<D>)=>{if(r.signature!==signature||r.wireSha256!==wireHash||r.messageSha256!==attempt.intentSha256)fail('IDEMPOTENCY_BODY_MISMATCH');return r;};
  const prior=await read(db,epochId,domain);if(prior)return replay(prior);
  if(!await getPreparedMiningPublication(db,epochId))fail('NOT_PREPARED');
  const frozen=await manifest(db,epochId,custody),{m,p,reservations,contributions}=frozen;
  if(m.intent_sha256!==attempt.intentSha256||(custody.domain==='ingots'&&(reservations.length!==custody.attempt.reservationCount||reservations.some(r=>!custody.attempt.reservations.some(a=>a.reservationId===r.reservationId&&a.baseId===r.baseId&&a.actorWallet===r.actorWallet&&a.ingots===r.reserved))))
   ||Object.entries(identity).some(([k,v])=>p[k as keyof typeof identity]!==v))fail('SOURCE_CONFLICT');
  const args:PublishMiningInput={sequence:BigInt(p.sequence),day:BigInt(p.day),kind:0,root:Buffer.from(p.root,'hex'),totalCumulative:BigInt(p.total),leafCount:p.leafCount,budgetGross:BigInt(p.budgetGross),freeGross:BigInt(p.freeGross),deedGross:BigInt(p.deedGross),sourceHash:Buffer.from(m.source_hash,'hex'),taxCommitment:Buffer.from(p.taxCommitment,'hex'),taxVersion:p.taxVersion};
  let receipt:Awaited<ReturnType<typeof verify>>;
  try{receipt=await verify({signature,signedTransaction:wire,signer:new PublicKey(p.signer),args});}catch{fail('RECEIPT_UNAVAILABLE');}
  if(receipt.slot<p.blockhashContextSlot||receipt.originalMessageSha256!==attempt.intentSha256||receipt.signedTransactionSha256!==wireHash||receipt.sourceHash!==m.source_hash||receipt.playerNet!==BigInt(p.playerNet)||receipt.tax!==BigInt(p.tax)||receipt.recycle!==BigInt(p.recycle)||receipt.splitStart!==p.splitStart||receipt.splitEnd!==p.splitEnd)fail('SOURCE_CONFLICT');
  try{return await db.transaction(async tx=>{
   await owner(tx);const duplicate=await read(tx,epochId,domain);if(duplicate)return replay(duplicate);
   const table=domain==='resources'?sql`mining_contribution_receipts`:sql`mining_ingot_reservations`;
   const discovered=await tx.execute<{base_id:string;owner_wallet:string}>(sql`select distinct r.base_id,b.owner_wallet from ${table} r join bases b on b.id=r.base_id where r.epoch_id=${epochId} order by r.base_id`);
   for(const wallet of [...new Set(discovered.map(r=>r.owner_wallet))].sort())await tx.execute(sql`select wallet from players where wallet=${wallet} for update nowait`);
   for(const source of discovered){const [base]=await tx.execute<{owner_wallet:string}>(sql`select owner_wallet from bases where id=${source.base_id} for update nowait`);if(base?.owner_wallet!==source.owner_wallet)fail('BUSY');if((await tx.execute(sql`select raid_id from base_raid_locks where base_id=${source.base_id} for update nowait`)).length)fail('BASE_BUSY');}
   await tx.execute(sql`select id from mining_ingot_epochs where id=${epochId} for update nowait`);
   const completed=await read(tx,epochId,domain);if(completed)return replay(completed);
   const locked=await manifest(tx,epochId,custody);if(locked.m.source_hash!==m.source_hash||locked.m.intent_sha256!==m.intent_sha256)fail('SOURCE_CONFLICT');
   if(custody.domain==='resources'){
    const [actual]=await tx.execute<{originals:ResourceMiningOriginal[]}>(sql`select public.shardkeep_mining_resource_originals(${epochId}) originals`);
    if(!actual||miningCanonical(actual.originals)!==miningCanonical(custody.attempt.contributions)||actual.originals.some(r=>!discovered.some(d=>d.base_id===r.baseId)))fail('SOURCE_CONFLICT');
   }else{
   const actual=await tx.execute<{id:string;base_id:string;actor_wallet:string;qty:number}>(sql`select id,base_id,actor_wallet,qty from mining_ingot_reservations where epoch_id=${epochId} order by base_id,id for update nowait`);
   if(actual.length!==reservations.length||actual.some(a=>!discovered.some(d=>d.base_id===a.base_id)||!reservations.some(r=>r.reservationId===a.id&&r.baseId===a.base_id&&r.actorWallet===a.actor_wallet&&r.reserved===a.qty)))fail('SOURCE_CONFLICT');
   for(const b of discovered)await tx.execute(sql`select public.shardkeep_assert_mining_ingot_stock(${b.base_id})`);
   }
   await tx.execute(sql`insert into mining_publication_settlements(epoch_id,signature,signed_transaction,receipt) values(${epochId},${signature},${wire},${json(receipt)}::jsonb)`);
   for(const r of contributions)await settleMiningContribution(tx,epochId,r.id,r.outcome,sources.resourceClock?.());
   for(const r of reservations){await tx.execute(sql`insert into mining_ingot_dispositions(reservation_id,epoch_id,consumed_qty,returned_qty) values(${r.reservationId},${epochId},${r.proposedConsumed},${r.proposedReturned})`);
    if(r.proposedReturned)await tx.execute(sql`insert into base_items(base_id,item_id,qty,acquired_via) values(${r.baseId},'forge_ingot',${r.proposedReturned},'craft') on conflict(base_id,item_id) do update set qty=base_items.qty+excluded.qty`);}
   const result=await read(tx,epochId,domain);if(!result)fail('SOURCE_CONFLICT');return result;
  });}catch(e){const err=e as {code?:string;cause?:{code?:string}};if((err.cause?.code??err.code)==='55P03')fail('BUSY');throw e;}
 };
}

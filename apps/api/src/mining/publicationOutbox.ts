/** Internal durable signing custody. No signer, transport, scheduler or release. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { createMiningBackingSnapshotReader,type MiningBackingReader,type MiningBackingTrust,type MiningBackingSnapshot } from '@shardkeep/chain/mining-backing';
import { verifyMiningPublicationSignedWire } from '@shardkeep/chain/mining-publication-wire';
import { phaseEMiningEnabled } from '../config';
import type { Db,DbOrTx } from '../db/client';
import { getPreparedMiningPublication,type PreparedMiningPublication } from './publicationPreparation';
const RPC_TIMEOUT_MS=30_000,MAX_BACKING_BYTES=65536;
const requestSchema=z.object({epochId:z.uuid(),attemptKey:z.string().min(8).max(128).refine(v=>v.trim()===v)}).strict();
const signedSchema=requestSchema.extend({signedTransaction:z.instanceof(Uint8Array)}).strict();
const hash=(v:Uint8Array)=>createHash('sha256').update(v).digest('hex');
const json=(v:unknown)=>JSON.stringify(v,(_,x)=>typeof x==='bigint'?x.toString():x);
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_PREPARED'|'NOT_RESERVED'|'NOT_SIGNED'|'DISABLED'|'SOURCE_DRIFT'|'SOURCE_CONFLICT'|'BUSY'|'SEQUENCE_RESERVED'|'IDEMPOTENCY_BODY_MISMATCH'|'SIGNED_WIRE_INVALID';
export class MiningPublicationOutboxError extends Error{constructor(readonly code:Code){super(`Mining publication outbox refused: ${code}`);this.name='MiningPublicationOutboxError';}}
function fail(code:Code):never{throw new MiningPublicationOutboxError(code);}
export interface MiningPublicationOutboxRequest{epochId:string;attemptKey:string}
export interface MiningPublicationSignedRequest extends MiningPublicationOutboxRequest{signedTransaction:Uint8Array}
export interface MiningPublicationSignedRecord{signature:string;signedTransactionHex:string;wireSha256:string;messageSha256:string;acceptedAt:string}
export interface MiningPublicationSigningReservation{epochId:string;attemptKey:string;genesisHash:string;programId:string;configAddress:string;sequence:string;signer:string;intentHex:string;intentSha256:string;blockhashContextSlot:number;lastValidBlockHeight:number;backing:Record<string,unknown>;reservedAt:string;signingAuthorized:false}
export interface MiningPublicationOutbox extends MiningPublicationSigningReservation{signed:MiningPublicationSignedRecord|null}
export interface MiningPublicationBroadcastAdmission{outbox:MiningPublicationOutbox;signedTransaction:Uint8Array;signature:string;backing:MiningBackingSnapshot}
async function owner(db:DbOrTx){const [r]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_publication_signing_reservations'::regclass) allowed`);if(!r?.allowed)fail('OWNER_REQUIRED');}
async function prepared(db:DbOrTx,input:MiningPublicationOutboxRequest){const p=await getPreparedMiningPublication(db,input.epochId);if(!p)fail('NOT_PREPARED');if(p.attemptKey!==input.attemptKey)fail('IDEMPOTENCY_BODY_MISMATCH');return p;}
/** Historical recovery only: this does not re-admit signing or broadcasting. */
export async function getMiningPublicationOutbox(db:DbOrTx,epochId:string):Promise<MiningPublicationOutbox|null>{
 if(!z.uuid().safeParse(epochId).success)fail('INVALID_INPUT');await owner(db);
 const [r]=await db.execute<{record:MiningPublicationOutbox}>(sql`select jsonb_build_object('epochId',r.epoch_id,'attemptKey',r.attempt_key,'genesisHash',r.genesis_hash,'programId',r.program_id,'configAddress',r.config_address,'sequence',r.sequence::text,'signer',r.signer,'intentHex',encode(a.intent_bytes,'hex'),'intentSha256',r.intent_sha256,'backing',r.backing,'reservedAt',to_char(r.reserved_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'signingAuthorized',false,'blockhashContextSlot',(m.publication->>'blockhashContextSlot')::bigint,'lastValidBlockHeight',(m.publication->>'lastValidBlockHeight')::bigint,'signed',case when w.epoch_id is null then null else jsonb_build_object('signature',w.signature,'signedTransactionHex',encode(w.signed_transaction,'hex'),'wireSha256',w.wire_sha256,'messageSha256',w.message_sha256,'acceptedAt',to_char(w.accepted_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) end) record from mining_publication_signing_reservations r join mining_publication_attempts a using(epoch_id) join mining_publication_manifests m using(epoch_id) left join mining_publication_signed_wires w using(epoch_id) where r.epoch_id=${epochId}`);
 if(!r)return null;const out=r.record,p=await prepared(db,{epochId,attemptKey:out.attemptKey});
 if(out.intentSha256!==p.intentSha256||out.intentHex!==p.intentHex||out.signer!==p.publication.signer||out.programId!==p.publication.programId||out.sequence!==p.publication.sequence)fail('SOURCE_CONFLICT');
 if(out.signed){try{const s=out.signed,v=verifyMiningPublicationSignedWire({intentBytes:Buffer.from(out.intentHex,'hex'),signedTransaction:Buffer.from(s.signedTransactionHex,'hex'),signer:new PublicKey(out.signer)});if(v.signature!==s.signature||v.wireSha256!==s.wireSha256||v.messageSha256!==s.messageSha256)fail('SOURCE_CONFLICT');}catch{fail('SOURCE_CONFLICT');}}
 return out;
}
export function createMiningPublicationOutbox(db:Db,source:{reader:MiningBackingReader;trust:MiningBackingTrust;timeoutMs?:number}){
 const readBacking=createMiningBackingSnapshotReader(source.reader,source.trust),timeoutMs=source.timeoutMs??RPC_TIMEOUT_MS;
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>RPC_TIMEOUT_MS)fail('INVALID_INPUT');
 // A timed-out provider remains one in-flight operation until it really settles.
 // Late measurements are never cached or permitted to write a reservation.
 let pending:Promise<MiningBackingSnapshot>|null=null;
 async function fresh(p:PreparedMiningPublication):Promise<MiningBackingSnapshot>{
  if(!phaseEMiningEnabled())fail('DISABLED');if(pending)fail('BUSY');let timer:ReturnType<typeof setTimeout>|undefined;
  const read=readBacking();pending=read;void read.then(()=>{if(pending===read)pending=null;},()=>{if(pending===read)pending=null;});
  let b:MiningBackingSnapshot;try{b=await Promise.race([read,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new MiningPublicationOutboxError('SOURCE_DRIFT')),timeoutMs);})]);}catch{fail('SOURCE_DRIFT');}finally{if(timer)clearTimeout(timer);}
  if(!phaseEMiningEnabled())fail('DISABLED');
  const old=JSON.parse(p.manifestJson).funding as {source:{genesisHash:string;programId:string;reviewedDeploymentSlot:number;reviewedProgramDataSha256:string};config:{address:string;genesisDay:string;latestDay:string;splitCursor:number;totalPublished:string;totalPublishedHighwater:string;totalClaimed:string;taxHighwater:string;taxPaid:string;recycledTotal:string;grossPublished:string}},c=b.config,decl=p.publication;
  if(b.slot<decl.blockhashContextSlot||b.source.genesisHash!==old.source.genesisHash||b.source.programId!==decl.programId||b.source.reviewedDeploymentSlot!==old.source.reviewedDeploymentSlot||b.source.reviewedProgramDataSha256!==old.source.reviewedProgramDataSha256
   ||c.address!==old.config.address||c.publisher!==decl.signer||(c.flags&2)!==0||c.correctionPending||c.latestSequence+1n!==BigInt(decl.sequence)||c.latestDay!==BigInt(old.config.latestDay)||c.genesisDay!==BigInt(old.config.genesisDay)||c.splitCursor!==decl.splitStart
   ||c.totalPublished!==BigInt(old.config.totalPublished)||c.totalPublishedHighwater!==BigInt(old.config.totalPublishedHighwater)
   ||c.taxHighwater!==BigInt(old.config.taxHighwater)||c.recycledTotal!==BigInt(old.config.recycledTotal)||c.grossPublished!==BigInt(old.config.grossPublished)
   ||c.totalClaimed<BigInt(old.config.totalClaimed)||c.taxPaid<BigInt(old.config.taxPaid)||c.totalPublished+BigInt(decl.playerNet)!==BigInt(decl.total)
   ||c.keepMint!==decl.keepMint||c.emissionReserveOwner!==decl.reserveOwner||BigInt(decl.day)>=b.chainDay||BigInt(decl.day)<=c.latestDay||BigInt(decl.day)-c.latestDay>BigInt(POLICY.publisherMaxGapDays)||BigInt(decl.budgetGross)>b.maximumEpochBudget)fail('SOURCE_DRIFT');
  if(Buffer.byteLength(json(b))>MAX_BACKING_BYTES)fail('SOURCE_CONFLICT');return b;
 }
 function request(value:unknown){const p=requestSchema.safeParse(value);if(!p.success)fail('INVALID_INPUT');return p.data;}
 const get=(epochId:string)=>getMiningPublicationOutbox(db,epochId);
 function replay(out:MiningPublicationOutbox,input:MiningPublicationOutboxRequest){if(out.attemptKey!==input.attemptKey)fail('IDEMPOTENCY_BODY_MISMATCH');return out;}
 async function reserveSigning(value:MiningPublicationOutboxRequest):Promise<MiningPublicationOutbox>{
  const input=request(value);await owner(db);const prior=await get(input.epochId);if(prior)return replay(prior,input);
  const p=await prepared(db,input),backing=await fresh(p);
  try{return await db.transaction(async tx=>{await owner(tx);await tx.execute(sql`select id from mining_ingot_epochs where id=${input.epochId} for update nowait`);const again=await getMiningPublicationOutbox(tx,input.epochId);if(again)return replay(again,input);if(!phaseEMiningEnabled())fail('DISABLED');const current=await prepared(tx,input);if(current.intentSha256!==p.intentSha256||current.sourceHash!==p.sourceHash)fail('SOURCE_CONFLICT');await tx.execute(sql`insert into mining_publication_signing_reservations(epoch_id,backing) values(${input.epochId},${json(backing)}::jsonb)`);const saved=await getMiningPublicationOutbox(tx,input.epochId);if(!saved)fail('SOURCE_CONFLICT');return saved;});}catch(e){const code=(e as {code?:string;cause?:{code?:string}}).cause?.code??(e as {code?:string}).code;if(code==='55P03')fail('BUSY');if(code==='23505')fail('SEQUENCE_RESERVED');throw e;}
 }
 async function acceptSigned(value:MiningPublicationSignedRequest):Promise<MiningPublicationOutbox>{
  const parsed=signedSchema.safeParse(value);if(!parsed.success||parsed.data.signedTransaction.length<1||parsed.data.signedTransaction.length>1232)fail('INVALID_INPUT');const {epochId,attemptKey}=parsed.data,wire=Buffer.from(parsed.data.signedTransaction),input={epochId,attemptKey};
  await owner(db);const prior=await get(epochId);if(!prior)fail('NOT_RESERVED');replay(prior,input);
  const exact=(out:MiningPublicationOutbox)=>{replay(out,input);if(out.signed?.wireSha256!==hash(wire))fail('IDEMPOTENCY_BODY_MISMATCH');return out;};if(prior.signed)return exact(prior);
  let checked:ReturnType<typeof verifyMiningPublicationSignedWire>;try{checked=verifyMiningPublicationSignedWire({intentBytes:Buffer.from(prior.intentHex,'hex'),signedTransaction:wire,signer:new PublicKey(prior.signer)});}catch{fail('SIGNED_WIRE_INVALID');}
  try{return await db.transaction(async tx=>{await owner(tx);await tx.execute(sql`select id from mining_ingot_epochs where id=${epochId} for update nowait`);const existing=await getMiningPublicationOutbox(tx,epochId);if(!existing)fail('NOT_RESERVED');if(existing.signed)return exact(existing);if(existing.intentSha256!==checked.messageSha256)fail('SOURCE_CONFLICT');await tx.execute(sql`insert into mining_publication_signed_wires(epoch_id,signature,signed_transaction) values(${epochId},${checked.signature},${wire})`);const saved=await getMiningPublicationOutbox(tx,epochId);if(!saved)fail('SOURCE_CONFLICT');return saved;});}catch(e){if(((e as {cause?:{code?:string}}).cause?.code??(e as {code?:string}).code)==='55P03')fail('BUSY');throw e;}
 }
 async function admitBroadcast(value:MiningPublicationOutboxRequest):Promise<MiningPublicationBroadcastAdmission>{const input=request(value);await owner(db);const out=await get(input.epochId);if(!out)fail('NOT_RESERVED');replay(out,input);if(!out.signed)fail('NOT_SIGNED');const p=await prepared(db,input),backing=await fresh(p);return {outbox:out,signedTransaction:Buffer.from(out.signed.signedTransactionHex,'hex'),signature:out.signed.signature,backing};}
 return {reserveSigning,acceptSigned,get,admitBroadcast};
}
export type MiningPublicationOutboxService=ReturnType<typeof createMiningPublicationOutbox>;

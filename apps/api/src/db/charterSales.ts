/** D153.176 private ordinary-sale storage. The HTTP workflow supplies no caller
 * authority: chain observations are checked by its application-bound readers. */
import type {CharterCreationSavedRecord} from '@shardkeep/chain/charter-creation-evidence';
import {PublicKey} from '@solana/web3.js';
import {BASE_OWNERSHIP,CLANS,PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL,PHASE_E_CHARTER_TRANSFER,PHASE_E_CHARTER_ADMISSION,PHASE_E_POLICY,RAID_RULES} from '@shardkeep/shared';
import {isDeepStrictEqual} from 'node:util';
import {copyCharterTransferOriginal,verifyCharterTransferQuote,verifyCharterTransferPacket,type CharterTransferQuote} from '@shardkeep/chain/charter-transfer-preparation';
import {verifyCharterTransferSignedWire} from '@shardkeep/chain/charter-transfer-wire';
import {verifyCharterTransferCancellation} from '@shardkeep/chain/charter-transfer-cancellation';
import {SIM_VERSION} from '@shardkeep/sim';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import type {Db,DbTx} from './client';
import {requireExactFinalizedOwnedBaseAuthority,type FinalizedDeedReader} from '../game/baseOwnership';
import {phaseECharterEnabled} from '../config';
import {HttpError} from '../lib/errors';
export type SaleDraft={clanId:string;buyer:string;priceLamports:string;sellerLeaves:boolean;idempotencyKey:string};
export type SaleDomain={genesisHash:string;economyProgram:string;craftProgram:string;treasury:string};
export type SaleEpoch={version:1;id:string;domain:SaleDomain};
export type SaleOriginal={id:string;fenceId:string;clanId:string;seller:string;buyer:string;priceLamports:string;sellerLeaves:boolean;
 termsHash:string;domain:SaleDomain;expectedRevision:number;epochId:string;creation:CharterCreationSavedRecord};
export type SaleState={version:1;original:SaleOriginal;status:'draft'|'accepted'|'members_paid'|'issuing'|'prepared'|'signed'|'completed'|'cancelled';
 fenceId:string|null;acceptance:null|{termsHash:string;buyerBaseId:string;acceptedAt:string};memberPayment:null|{id:string;totalShards:string};
 attempt:null|{id:string;candidateHex:string;policySigner:string;quote:unknown};preparation:null|{policySignatureHex:string;packet:unknown};
 signed:null|{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string};
 terminal:null|{id:string;outcome:'completed'|'cancelled';record:unknown};inventory:{version:1;revision:string;count:number;messages:readonly string[]}};
export interface ClanCharterSalesStoreOptions {finalizedDeedReader?:FinalizedDeedReader|null;deedCollection?:string|null}
export interface ClanCharterSalesStore {
 initializeEpoch(domain:SaleDomain):Promise<SaleEpoch>;
 read(actor:string,id:string):Promise<SaleState>;
 create(seller:string,input:SaleDraft,domain:SaleDomain|null):Promise<SaleState>;
 accept(buyer:string,id:string,input:{termsHash:string;buyerBaseId:string}):Promise<SaleState>;
 beginAttempt(actor:string,id:string,quote:unknown,timing:{elapsedMs:number}):Promise<SaleState>;
 retainPreparation(actor:string,id:string,attemptId:string,artifact:{policySignatureHex:string;packet:unknown}):Promise<SaleState>;
 retainSigned(actor:string,id:string,artifact:{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}):Promise<SaleState>;
 complete(actor:string,id:string,evidence:unknown):Promise<SaleState>;
 cancel(actor:string,id:string,observation:unknown):Promise<SaleState>;
}
const uuid=z.uuid().refine(v=>v===v.toLowerCase()),address=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return p.toBase58()===v&&!p.equals(PublicKey.default);}catch{return false;}});
const natural=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>BigInt(v)<=(1n<<64n)-1n),hash=z.string().length(64).regex(/^[0-9a-f]+$/);
const domainSchema=z.object({genesisHash:address,economyProgram:address,craftProgram:address,treasury:address}).strict();
const draftSchema=z.object({clanId:uuid,buyer:address,priceLamports:natural.refine(v=>v!=='0'),sellerLeaves:z.boolean(),idempotencyKey:uuid}).strict();
const acceptanceSchema=z.object({termsHash:hash,buyerBaseId:uuid}).strict();
const stateSchema=z.object({version:z.literal(1),original:z.object({id:uuid,fenceId:uuid,clanId:uuid,seller:address,buyer:address,priceLamports:natural,sellerLeaves:z.boolean(),termsHash:hash,domain:domainSchema,expectedRevision:z.number().int().min(0).max(4294967294),epochId:uuid,creation:z.unknown()}).strict(),
 status:z.enum(['draft','accepted','members_paid','issuing','prepared','signed','completed','cancelled']),fenceId:uuid.nullable(),acceptance:z.object({termsHash:hash,buyerBaseId:uuid,acceptedAt:z.string()}).strict().nullable(),
 memberPayment:z.object({id:uuid,totalShards:natural}).strict().nullable(),attempt:z.object({id:uuid,candidateHex:z.string().length(322).regex(/^[0-9a-f]+$/),policySigner:address,quote:z.unknown()}).strict().nullable(),
 preparation:z.object({policySignatureHex:z.string().length(128).regex(/^[0-9a-f]+$/),packet:z.unknown()}).strict().nullable(),signed:z.object({signedTransactionHex:z.string().min(260).max(2464).regex(/^(?:[0-9a-f]{2})+$/),signature:z.string().min(64).max(88),wireSha256:hash,messageSha256:hash}).strict().nullable(),
 terminal:z.object({id:uuid,outcome:z.enum(['completed','cancelled']),record:z.unknown()}).strict().nullable(),inventory:z.object({version:z.literal(1),revision:natural,count:z.number().int().min(0).max(1),messages:z.array(z.string().length(322).regex(/^[0-9a-f]+$/)).max(1)}).strict()}).strict();
function fail(suffix:string,status=503):never{throw new HttpError(status,'Charter sale is unavailable','CLAN_CHARTER_SALE_'+suffix);}
function translate(error:unknown):never{
 if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_SALE_'))throw error;
 let cause=error;for(let n=0;n<8&&cause&&typeof cause==='object';n++){
  if('code'in cause&&['55P03','40P01'].includes(String(cause.code)))return fail('BUSY',409);
  if('code'in cause&&cause.code==='23505')return fail('CONFLICT',409);
  if('message'in cause&&typeof cause.message==='string'&&/^CLAN_CHARTER_SALE_[A-Z_]+$/.test(cause.message)){const suffix=cause.message.slice('CLAN_CHARTER_SALE_'.length);return fail(suffix,suffix==='NOT_FOUND'?404:suffix==='CONFLICT'||suffix==='BUSY'?409:503);}
  if('code'in cause&&cause.code==='42501')return fail('OWNER');cause='cause'in cause?cause.cause:undefined;
 }
 return fail('HELD');
}
const json=(value:unknown)=>JSON.stringify(value,(_key,v:unknown)=>typeof v==='bigint'?v.toString():v);
function freeze<T>(v:T):T{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
function identity(actor:string,id?:string){if(!address.safeParse(actor).success||(id!==undefined&&!uuid.safeParse(id).success))return fail('INPUT',400);}
function state(value:unknown,actor:string,id?:string):SaleState{
 const v=stateSchema.parse(value);if((actor!==v.original.seller&&actor!==v.original.buyer)||(id!==undefined&&id!==v.original.id))return fail('NOT_FOUND',404);
 if(v.fenceId!==v.original.fenceId||v.inventory.count!==v.inventory.messages.length||v.inventory.revision!==String(v.inventory.count))return fail('HELD');
 const s=v as SaleState;transferOriginal(s);
 if(v.status!==(v.terminal?.outcome??(v.signed?'signed':v.preparation?'prepared':v.attempt?'issuing':v.memberPayment?'members_paid':v.acceptance?'accepted':'draft')))return fail('HELD');
 if(v.attempt){if(!v.acceptance||!v.memberPayment||v.inventory.count!==1||v.inventory.messages[0]!==v.attempt.candidateHex)return fail('HELD');quoteFor(s,v.attempt.quote);}
 else if(v.preparation||v.signed||v.inventory.count!==0)return fail('HELD');
 if(v.preparation)preparationFor(s,v.preparation);if(v.signed)wireFor(s,v.signed);
 if(v.terminal){if(v.terminal.outcome==='completed')evidenceFor(s,v.terminal.record);else cancellationFor(s,v.terminal.record);}
 return freeze(s);
}
function transferOriginal(state:SaleState){
 const s=state.original,original=copyCharterTransferOriginal({creation:s.creation,sale:{id:s.id,fenceId:s.fenceId,seller:s.seller,buyer:s.buyer,treasury:s.domain.treasury,expectedRevision:s.expectedRevision,priceLamports:s.priceLamports,termsHash:s.termsHash}});
 if(original.creation.chain.genesisHash!==s.domain.genesisHash||original.creation.chain.economyProgram!==s.domain.economyProgram||original.creation.chain.craftProgram!==s.domain.craftProgram||original.creation.clanId!==s.clanId)return fail('HELD');return original;
}
function quoteFor(state:SaleState,input:unknown):CharterTransferQuote{
 const quote=verifyCharterTransferQuote(input);if(!isDeepStrictEqual(quote.packetInput.original,transferOriginal(state)))return fail('HELD');
 if(state.attempt&&(quote.packetInput.candidateHex!==state.attempt.candidateHex||quote.packetInput.policySigner!==state.attempt.policySigner))return fail('HELD');return quote;
}
function preparationFor(state:SaleState,input:unknown){
 if(!state.attempt)return fail('HELD');const parsed=z.object({policySignatureHex:z.string().length(128).regex(/^[0-9a-f]+$/),packet:z.unknown()}).strict().parse(input),quote=quoteFor(state,state.attempt.quote);
 return freeze({policySignatureHex:parsed.policySignatureHex,packet:verifyCharterTransferPacket({...quote.packetInput,policySignatureHex:parsed.policySignatureHex},parsed.packet)});
}
function wireFor(state:SaleState,input:unknown){
 if(!state.preparation)return fail('HELD');const p=stateSchema.shape.signed.unwrap().parse(input),packet=preparationFor(state,state.preparation).packet,
  wire=verifyCharterTransferSignedWire({buyer:new PublicKey(state.original.buyer),seller:new PublicKey(state.original.seller),intentBytes:Buffer.from(packet.messageHex,'hex'),signedTransaction:Buffer.from(p.signedTransactionHex,'hex')});
 if(p.signature!==wire.signature||p.wireSha256!==wire.wireSha256||p.messageSha256!==wire.messageSha256)return fail('HELD');return freeze(p);
}
const receiptSchema=z.object({transferId:uuid,fenceId:uuid,clanId:uuid,seller:address,buyer:address,treasury:address,priceLamports:natural,sellerLamports:natural,royaltyLamports:natural,priorRevision:z.number().int().nonnegative(),revision:z.number().int().positive(),termsHash:hash,acceptedAt:natural}).strict();
const evidenceSchema=z.object({version:z.literal(1),signature:z.string().min(64).max(88),slot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),observedSlot:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),receipt:receiptSchema,feeLamports:natural,rentLamports:natural,wireSha256:hash,messageSha256:hash,receiptSha256:hash,finalizedTransferObserved:z.literal(true),backendClearanceVerified:z.literal(false),fenceReleaseAuthorized:z.literal(false)}).strict();
function evidenceFor(state:SaleState,input:unknown){
 if(!state.signed)return fail('HELD');const e=evidenceSchema.parse(input),s=state.original,royalty=BigInt(s.priceLamports)*BigInt(PHASE_E_CHARTER_TRANSFER.royaltyBps)/BigInt(PHASE_E_POLICY.basisPoints),expected={transferId:s.id,fenceId:s.fenceId,clanId:s.clanId,seller:s.seller,buyer:s.buyer,treasury:s.domain.treasury,priceLamports:s.priceLamports,sellerLamports:(BigInt(s.priceLamports)-royalty).toString(),royaltyLamports:royalty.toString(),priorRevision:s.expectedRevision,revision:s.expectedRevision+1,termsHash:s.termsHash,acceptedAt:e.receipt.acceptedAt};
 if(!isDeepStrictEqual(e.receipt,expected)||e.signature!==state.signed.signature||e.wireSha256!==state.signed.wireSha256||e.messageSha256!==state.signed.messageSha256||e.observedSlot<e.slot)return fail('HELD');return freeze(e);
}
function cancellationFor(state:SaleState,input:unknown){const proof=verifyCharterTransferCancellation(input);if(proof.outcome!=='absent-after-expiry'||!isDeepStrictEqual(proof.original,transferOriginal(state))||!isDeepStrictEqual(proof.inventory,state.inventory))return fail('HELD');return proof;}
async function readInTransaction(tx:DbTx,actor:string,id:string){const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_read(${actor},${id}::uuid) value`);return state(row?.value,actor,id);}
export function createClanCharterSalesStore(db:Db,options:ClanCharterSalesStoreOptions={}):ClanCharterSalesStore {
 if('rollback'in db)return fail('TOP_LEVEL');
 const reader=options.finalizedDeedReader??null,collection=options.deedCollection??null;
 async function initializeEpoch(input:SaleDomain):Promise<SaleEpoch>{
  const parsed=domainSchema.safeParse(input);if(!parsed.success)return fail('INPUT',400);if(!phaseECharterEnabled())return fail('DISABLED');
  const policy={rosterCap:CLANS.rosterCap,anteSchedule:[...PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL],royaltyBps:PHASE_E_CHARTER_TRANSFER.royaltyBps,basisPoints:PHASE_E_POLICY.basisPoints,simVersion:SIM_VERSION,batchGraceSeconds:RAID_RULES.batchOrdersGraceSec,titheBps:CLANS.chestTitheBps,observationMaxAgeMs:PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs};
  try{return await db.transaction(async tx=>{const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_epoch(${json(parsed.data)}::jsonb,${json(policy)}::jsonb) value`);
   return freeze(z.object({version:z.literal(1),id:uuid,domain:domainSchema}).strict().parse(row?.value));},{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function read(actor:string,id:string){identity(actor,id);try{return await db.transaction(tx=>readInTransaction(tx,actor,id),{isolationLevel:'read committed'});}catch(error){return translate(error);}}
 async function create(actor:string,input:SaleDraft,currentDomain:SaleDomain|null){
  identity(actor);const parsed=draftSchema.safeParse(input);if(!parsed.success)return fail('INPUT',400);
  // SQL resolves the exact original idempotency key before requiring current
  // domain or flags. Null permits history only, never a fresh draft.
  const configured=domainSchema.safeParse(currentDomain),domain=phaseECharterEnabled()&&configured.success?configured.data:null;
  try{return await db.transaction(async tx=>{const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_draft(${actor},${json(parsed.data)}::jsonb,${json(phaseECharterEnabled()?domain:null)}::jsonb) value`);return state(row?.value,actor);},{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function accept(actor:string,id:string,input:{termsHash:string;buyerBaseId:string}){
  identity(actor,id);const parsed=acceptanceSchema.safeParse(input);if(!parsed.success)return fail('INPUT',400);
  const saved=await read(actor,id);if(actor!==saved.original.buyer)return fail('NOT_FOUND',404);
  if(saved.acceptance){if(saved.acceptance.termsHash!==parsed.data.termsHash||saved.acceptance.buyerBaseId!==parsed.data.buyerBaseId)return fail('CONFLICT',409);return saved;}
  if(saved.terminal)return saved;if(!phaseECharterEnabled())return fail('DISABLED');if(!reader||!collection)return fail('DESTINATION');
  try{
   await requireExactFinalizedOwnedBaseAuthority(db,actor,parsed.data.buyerBaseId,reader,collection);
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.acceptance){if(current.acceptance.termsHash!==parsed.data.termsHash||current.acceptance.buyerBaseId!==parsed.data.buyerBaseId)return fail('CONFLICT',409);return current;}
    if(!phaseECharterEnabled())return fail('DISABLED');const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_accept(${actor},${id}::uuid,${json(parsed.data)}::jsonb,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);const result=state(row?.value,actor,id);if(!phaseECharterEnabled())return fail('DISABLED');return result;
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function beginAttempt(actor:string,id:string,input:unknown,timing:{elapsedMs:number}){
  const saved=await read(actor,id);if(saved.terminal||saved.attempt)return saved;
  if(!saved.acceptance||!saved.memberPayment||!reader||!collection||!phaseECharterEnabled())return fail('HELD');
  try{
   const quote=quoteFor(saved,input),initial=z.object({elapsedMs:z.number().finite().nonnegative().max(PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)}).strict().parse(timing),started=performance.now();
   const elapsed=()=>{const n=performance.now()-started+initial.elapsedMs;if(!Number.isFinite(n)||n<initial.elapsedMs||n>PHASE_E_CHARTER_ADMISSION.v1.observationMaxAgeMs)return fail('STALE');return n;};
   await requireExactFinalizedOwnedBaseAuthority(db,saved.original.buyer,saved.acceptance.buyerBaseId,reader,collection);elapsed();
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.terminal||current.attempt)return current;
    if(!phaseECharterEnabled())return fail('DISABLED');quoteFor(current,quote);const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_attempt(${actor},${id}::uuid,${json(quote)}::jsonb,${elapsed()}::double precision,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);
    const result=state(row?.value,actor,id);elapsed();if(!phaseECharterEnabled())return fail('DISABLED');return result;
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function retainPreparation(actor:string,id:string,attemptId:string,input:{policySignatureHex:string;packet:unknown}){
  const saved=await read(actor,id);if(saved.terminal)return saved;if(!uuid.safeParse(attemptId).success||saved.attempt?.id!==attemptId)return fail('HELD');
  try{const artifact=preparationFor(saved,input);if(saved.preparation){if(!isDeepStrictEqual(saved.preparation,artifact))return fail('CONFLICT',409);return saved;}
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;preparationFor(current,artifact);
    const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_preparation(${actor},${id}::uuid,${attemptId}::uuid,${json(artifact)}::jsonb) value`);return state(row?.value,actor,id);
   },{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function retainSigned(actor:string,id:string,input:{signedTransactionHex:string;signature:string;wireSha256:string;messageSha256:string}){
  const saved=await read(actor,id);try{const artifact=wireFor(saved,input);if(saved.signed){if(!isDeepStrictEqual(saved.signed,artifact))return fail('CONFLICT',409);return saved;}if(saved.terminal)return saved;
   return await db.transaction(async tx=>{const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;wireFor(current,artifact);const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_wire(${actor},${id}::uuid,${json(artifact)}::jsonb) value`);return state(row?.value,actor,id);},{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function complete(actor:string,id:string,input:unknown){
  const saved=await read(actor,id);if(saved.terminal)return saved;try{const evidence=evidenceFor(saved,input);return await db.transaction(async tx=>{
   const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;evidenceFor(current,evidence);const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_terminal(${actor},${id}::uuid,'completed',${json(evidence)}::jsonb) value`);return state(row?.value,actor,id);
  },{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 async function cancel(actor:string,id:string,input:unknown){
  const saved=await read(actor,id);if(saved.terminal)return saved;try{const proof=cancellationFor(saved,input);return await db.transaction(async tx=>{
   const current=await readInTransaction(tx,actor,id);if(current.terminal)return current;cancellationFor(current,proof);const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_sale_terminal(${actor},${id}::uuid,'cancelled',${json(proof)}::jsonb) value`);return state(row?.value,actor,id);
  },{isolationLevel:'read committed'});}catch(error){return translate(error);}
 }
 return Object.freeze({initializeEpoch,read,create,accept,beginAttempt,retainPreparation,retainSigned,complete,cancel});
}

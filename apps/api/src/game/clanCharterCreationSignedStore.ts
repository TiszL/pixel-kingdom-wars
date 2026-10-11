/** D153.168 original Charter wallet consent. Retain before any separate relay;
 * historical signed bytes never grant fresh mint, payment or refund authority. */
import { PublicKey } from '@solana/web3.js';
import { verifyCharterCreationSignedWire } from '@shardkeep/chain/charter-creation-wire';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db,DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { createCharterCreationPreparation,type CharterCreationPreparationState } from './clanCharterCreationPreparation';
export interface CharterCreationSignedReceipt {
 readonly attemptId:string; readonly reservationId:string; readonly creationIntentId:string;
 readonly wallet:string; readonly signature:string; readonly signedTransactionHex:string;
 readonly wireSha256:string; readonly messageSha256:string; readonly acceptedAt:string;
 readonly signingAuthorized:false; readonly relayAuthorized:false; readonly mintAuthorized:false;
 readonly paymentAuthorized:false; readonly activationAuthorized:false; readonly refundAuthorized:false;
 readonly reservationReleaseAuthorized:false;
}
const uuid=z.string().length(36).pipe(z.uuid()),hash=z.string().length(64).regex(/^[0-9a-f]+$/);
const address=z.string().min(32).max(44).refine(v=>{try{const p=new PublicKey(v);return !p.equals(PublicKey.default)&&p.toBase58()===v;}catch{return false;}});
const receiptSchema=z.object({attemptId:uuid,wallet:address,signedTransactionHex:z.string().min(132).max(2464).regex(/^(?:[0-9a-f]{2})+$/),
 signatureHex:z.string().length(128).regex(/^[0-9a-f]+$/),wireSha256:hash,messageSha256:hash,
 acceptedAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)}).strict();
const noAuthority={signingAuthorized:false,relayAuthorized:false,mintAuthorized:false,paymentAuthorized:false,
 activationAuthorized:false,refundAuthorized:false,reservationReleaseAuthorized:false} as const;
function fail(code:string):never{throw new HttpError(code==='BUSY'?409:503,'Charter signed consent refused','CLAN_CHARTER_SIGNED_'+code);}
function translate(error:unknown):never{
 if(error instanceof HttpError&&error.code?.startsWith('CLAN_CHARTER_SIGNED_'))throw error;
 let e=error;
 for(let i=0;i<8&&e&&typeof e==='object';i++){
  if('code'in e&&e.code==='55P03')return fail('BUSY');
  if('message'in e&&typeof e.message==='string'&&/^CLAN_CHARTER_SIGNED_[A-Z_]+$/.test(e.message))return fail(e.message.slice('CLAN_CHARTER_SIGNED_'.length));
  if('code'in e&&typeof e.code==='string'&&/^CLAN_CHARTER_(PREPARATION|POLICY|INVENTORY)_/.test(e.code)){
   for(const suffix of ['PAYER','OWNER','READ_COMMITTED'])if(e.code.endsWith('_'+suffix))return fail(suffix);
   return fail('SOURCE');
  }
  e='cause'in e?e.cause:undefined;
 }
 return fail('HELD');
}
function identity(wallet:string,intent:string){if(!address.safeParse(wallet).success||!uuid.safeParse(intent).success)return fail('INPUT');}
function verified(p:CharterCreationPreparationState,bytes:Uint8Array,code:string){
 if(!p.preparation)return fail('PREPARATION');
 try{return verifyCharterCreationSignedWire({intentBytes:Buffer.from(p.preparation.packet.messageHex,'hex'),signedTransaction:bytes,
  wallet:new PublicKey(p.admission.original.consent.payer)});}catch{return fail(code);}
}
async function readStored(tx:DbTx,p:CharterCreationPreparationState):Promise<CharterCreationSignedReceipt|null>{
 const c=p.admission.original.consent;
 const [row]=await tx.execute<{value:unknown}>(sql`select public.shardkeep_charter_signed_read(${c.payer},${c.creationIntentId}::uuid) value`);
 if(row?.value===null)return null;
 const parsed=receiptSchema.safeParse(row?.value);if(!parsed.success)return fail('SOURCE');const r=parsed.data;
 const bytes=Buffer.from(r.signedTransactionHex,'hex'),proof=verified(p,bytes,'SOURCE');
 if(r.attemptId!==p.attempt.id||r.wallet!==c.payer||r.signatureHex!==bytes.subarray(1,65).toString('hex')
  ||r.wireSha256!==proof.wireSha256||r.messageSha256!==proof.messageSha256||r.messageSha256!==p.preparation!.packet.messageSha256)return fail('SOURCE');
 return Object.freeze({attemptId:r.attemptId,reservationId:c.reservationId,creationIntentId:c.creationIntentId,wallet:c.payer,
  signature:proof.signature,signedTransactionHex:r.signedTransactionHex,wireSha256:r.wireSha256,messageSha256:r.messageSha256,acceptedAt:r.acceptedAt,...noAuthority});
}
export function createCharterCreationSignedStore(db:Db) {
 if('rollback'in db)return fail('TOP_LEVEL');
 const preparations=createCharterCreationPreparation(db,{chain:null,issuer:null});
 async function preparation(wallet:string,intent:string){
  identity(wallet,intent);
  await db.transaction(tx=>tx.execute(sql`select public.shardkeep_charter_signed_hooks()`),{isolationLevel:'read committed'});
  // Full D166 crypto/canonical validation is required even for duplicate reads.
  // Its immutable source is repeated under the SQL reader's canonical locks.
  return preparations.read(wallet,intent);
 }
 async function get(wallet:string,intent:string):Promise<CharterCreationSignedReceipt|null>{
  try{const p=await preparation(wallet,intent);if(!p?.preparation)return null;
   return await db.transaction(tx=>readStored(tx,p),{isolationLevel:'read committed'});
  }catch(error){return translate(error);}
 }
 async function accept(wallet:string,intent:string,signedTransaction:Uint8Array):Promise<CharterCreationSignedReceipt>{
  if(!(signedTransaction instanceof Uint8Array)||signedTransaction.byteLength<=65||signedTransaction.byteLength>1232)return fail('INPUT');
  const bytes=Buffer.from(signedTransaction),hex=bytes.toString('hex'); // Copy before the first await.
  try{const p=await preparation(wallet,intent);if(!p?.preparation)return fail('PREPARATION');
   verified(p,bytes,'WIRE'); // Never let an existing receipt bypass input verification.
   return await db.transaction(async tx=>{
    const prior=await readStored(tx,p);if(prior){if(prior.signedTransactionHex!==hex)return fail('CONFLICT');return prior;}
    await tx.execute(sql`insert into public.charter_creation_signed_wires(attempt_id,signed_transaction) values(${p.attempt.id}::uuid,${bytes})`);
    const saved=await readStored(tx,p);if(!saved||saved.signedTransactionHex!==hex)return fail('SOURCE');return saved;
   },{isolationLevel:'read committed'}); // Includes deferred constraints and actual COMMIT.
  }catch(error){return translate(error);}
 }
 return Object.freeze({get,accept});
}

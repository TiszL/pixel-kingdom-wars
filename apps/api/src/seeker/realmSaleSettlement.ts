/** Owner-attested historical success only; no signing, relay or new admission. */
import {createHash} from 'node:crypto';
import {PublicKey,SYSVAR_CLOCK_PUBKEY} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {createSeekerRealmSaleFinalityVerifier,SeekerRealmSaleFinalityError,type SeekerRealmSaleFinalityRpc} from '@shardkeep/chain/seeker-realm-sale-finality';
import type {SeekerRealmAccessTrust} from '@shardkeep/chain/seeker-realm-access-snapshot';
import {matchRealmSaleReceipt,realmSaleReceiptPda,realmSaleConfigPda,realmAccessPda,REALM_SALE_ACCOUNT_BYTES} from '@shardkeep/chain/seeker-realm-sale';
import type {Db,DbOrTx} from '../db/client';
import {getRealmSaleSigned,type RealmSaleSigned} from './realmSaleSignedStore';
import {realmSalePreparationArgs} from './realmSalePreparationStore';
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SIGNED'|'RECEIPT_UNAVAILABLE'|'RECEIPT_CONFLICT'|'BUSY'|'TIMEOUT';
export class RealmSaleSettlementError extends Error{readonly journalReleaseAuthorized=false;constructor(readonly code:Code){super(`Realm sale settlement refused: ${code}`);this.name='RealmSaleSettlementError';}}
function fail(code:Code):never{throw new RealmSaleSettlementError(code);}
const key=z.string().min(32).max(44).refine(v=>{if(v.length<32||v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}}),hash=z.string().length(64).regex(/^[0-9a-f]{64}$/);
const uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),u64=z.string().max(20).regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const request=z.object({wallet:key,idempotencyKey:z.uuid().refine(v=>v===v.toLowerCase())}).strict();
export type RealmSaleSettlementKey=z.infer<typeof request>;
const account=z.object({address:key,exists:z.literal(true),owner:key,executable:z.boolean(),dataSha256:hash}).strict();
const receiptSchema=z.object({version:z.literal(1),signature:z.string().min(64).max(88),slot:uint,blockTime:z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
 originalMessageSha256:hash,signedTransactionSha256:hash,receiptAccountHex:z.string().length(REALM_SALE_ACCOUNT_BYTES.RealmSaleReceipt*2).regex(/^[0-9a-f]+$/),
 feeLamports:u64,actualRentLamports:u64,buyerNetPaymentLamports:u64,accountRentIncreases:z.array(z.object({address:key,lamports:u64}).strict()).min(1).max(3),observedAccountSlot:uint,proofClockUnixTimestamp:u64,
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),stateProvenance:z.literal('fresh-reviewed-deployment'),genesisHash:key,programId:key,reviewedDeploymentSlot:uint,reviewedProgramDataSha256:hash,upgradeAuthority:key.nullable(),accounts:z.array(account).length(6)}).strict()}).strict();
export type RealmSaleSettlementReceipt=z.infer<typeof receiptSchema>;
const LOADER=new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),SYSVAR='Sysvar1111111111111111111111111111111111111';
function parseKey(v:unknown):RealmSaleSettlementKey{const p=request.safeParse(v);if(!p.success)fail('INVALID_INPUT');return p.data;}
function audit(value:unknown,s:RealmSaleSigned){
 const parsed=receiptSchema.safeParse(value);if(!parsed.success||!s.wire)fail('RECEIPT_CONFLICT');const r=parsed.data,a=s.preparation,w=s.wire,t=r.source,p=new PublicKey(a.source.programId),buyer=new PublicKey(a.wallet),args=realmSalePreparationArgs(a);
 if(r.signature!==w.signature||r.originalMessageSha256!==w.messageSha256||r.signedTransactionSha256!==w.wireSha256||t.genesisHash!==a.source.genesisHash||t.programId!==a.source.programId||t.reviewedDeploymentSlot!==a.source.reviewedDeploymentSlot||t.reviewedProgramDataSha256!==a.source.programDataSha256||r.slot<=t.reviewedDeploymentSlot||r.slot<a.source.admissionSlot||r.observedAccountSlot<r.slot||BigInt(r.proofClockUnixTimestamp)>((1n<<63n)-1n)||r.buyerNetPaymentLamports!==a.quote.paymentDebitLamports)fail('RECEIPT_CONFLICT');
 const addresses=[p,PublicKey.findProgramAddressSync([p.toBuffer()],LOADER)[0],realmSaleConfigPda(p),realmAccessPda(p,buyer,args.realm),SYSVAR_CLOCK_PUBKEY,realmSaleReceiptPda(p,buyer,args.saleId)];
 for(const [i,row]of t.accounts.entries())if(row.address!==addresses[i]!.toBase58()||row.owner!==(i<2?LOADER.toBase58():i===4?SYSVAR:p.toBase58())||row.executable!==(i===0))fail('RECEIPT_CONFLICT');
 const bytes=Buffer.from(r.receiptAccountHex,'hex');if(t.accounts[1]!.dataSha256!==t.reviewedProgramDataSha256||t.accounts[5]!.dataSha256!==createHash('sha256').update(bytes).digest('hex'))fail('RECEIPT_CONFLICT');
 let purchase;try{purchase=matchRealmSaleReceipt({address:addresses[5]!,owner:p,executable:false,data:bytes},{programId:p,buyer,args});}catch{fail('RECEIPT_CONFLICT');}
 if(purchase.acceptedAt>BigInt(r.proofClockUnixTimestamp)||r.accountRentIncreases.length!==a.quote.rents.length)fail('RECEIPT_CONFLICT');
 let rent=0n;for(const [i,entry]of r.accountRentIncreases.entries()){const cap=a.quote.rents[i]!;if(entry.address!==cap.address||BigInt(entry.lamports)>BigInt(cap.maxIncreaseLamports))fail('RECEIPT_CONFLICT');rent+=BigInt(entry.lamports);}
 if(rent!==BigInt(r.actualRentLamports)||BigInt(r.feeLamports)>BigInt(a.quote.feeLamports)||rent+BigInt(r.feeLamports)+BigInt(r.buyerNetPaymentLamports)>BigInt(a.quote.requiredLamports))fail('RECEIPT_CONFLICT');
 return {receipt:r,purchase:{address:purchase.address,buyer:purchase.buyer,seller:purchase.seller,developer:purchase.developer,spot:purchase.spot,realm:purchase.realm,round:purchase.round.toString(),day:purchase.day.toString(),acceptedAt:purchase.acceptedAt.toString(),priorExpiry:purchase.priorExpiry.toString(),coverageStart:purchase.coverageStart.toString(),expiresAt:purchase.expiresAt.toString(),priceLamports:purchase.priceLamports.toString(),sellerLamports:purchase.sellerLamports.toString(),developerLamports:purchase.developerLamports.toString()}};
}
export type RealmSaleSettlement=RealmSaleSettlementKey&ReturnType<typeof audit>&{saleId:string;signature:string;settledAt:string;purchaseFinalized:true;admissionAuthorized:false;relayAuthorized:false;signingAuthorized:false};
export async function getRealmSaleSettlement(db:DbOrTx,input:RealmSaleSettlementKey):Promise<RealmSaleSettlement|null>{
 const k=parseKey(input);let s;try{s=await getRealmSaleSigned(db,k);}catch{fail('RECEIPT_CONFLICT');}if(!s)return null;
 const [row]=await db.execute<{sale_id:string;receipt:unknown;settled_at:string}>(sql`select sale_id,receipt,to_char(settled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') settled_at from seeker_realm_sale_receipts where wallet=${k.wallet} and idempotency_key=${k.idempotencyKey}`);
 if(!row)return null;if(row.sale_id!==s.preparation.saleId||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.settled_at))fail('RECEIPT_CONFLICT');const checked=audit(row.receipt,s);
 return {...k,...checked,saleId:s.preparation.saleId,signature:checked.receipt.signature,settledAt:row.settled_at,purchaseFinalized:true,admissionAuthorized:false,relayAuthorized:false,signingAuthorized:false};
}
/** Pass a pool handle, not an open transaction: no RPC is held under DB locks. */
export function createRealmSaleSettlement(db:Db,options:{connect:(signal:AbortSignal)=>SeekerRealmSaleFinalityRpc;trust:SeekerRealmAccessTrust;timeoutMs?:number}){
 const timeout=options.timeoutMs??60_000;if(!Number.isInteger(timeout)||timeout<1||timeout>60_000)fail('INVALID_INPUT');
 const original=options.trust,trust={...original,programId:new PublicKey(original.programId.toBytes()),developer:new PublicKey(original.developer.toBytes()),upgradeAuthority:original.upgradeAuthority===null?null:new PublicKey(original.upgradeAuthority.toBytes())};
 const connect=options.connect;let activeSignal:AbortSignal|undefined;
 const verify=createSeekerRealmSaleFinalityVerifier(signal=>connect(activeSignal?AbortSignal.any([signal,activeSignal]):signal),trust);
 let pending:Promise<RealmSaleSettlement>|null=null;
 return async(input:RealmSaleSettlementKey):Promise<RealmSaleSettlement>=>{
  const k=parseKey(input),old=await getRealmSaleSettlement(db,k);if(old)return old;if(pending)fail('BUSY');
  const controller=new AbortController();activeSignal=controller.signal;const active=()=>{if(controller.signal.aborted)fail('TIMEOUT');};let timer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{
   const [owner]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.seeker_realm_sale_receipts'::regclass) allowed`);active();if(!owner?.allowed)fail('OWNER_REQUIRED');
   const s=await getRealmSaleSigned(db,k);active();if(!s?.wire)fail('NOT_SIGNED');const a=s.preparation,w=s.wire;
   if(a.source.genesisHash!==trust.expectedGenesisHash||a.source.programId!==trust.programId.toBase58()||a.source.reviewedDeploymentSlot!==trust.reviewedDeploymentSlot||a.source.programDataSha256!==trust.reviewedProgramDataSha256||a.terms.developer!==trust.developer.toBase58())fail('RECEIPT_CONFLICT');
   let proof;try{proof=await verify({wallet:new PublicKey(a.wallet),args:realmSalePreparationArgs(a),blockhash:a.quote.blockhash,needsAccess:a.quote.needsAccess,needsQuota:a.quote.needsQuota,preparedMessageBytes:Buffer.from(a.quote.messageHex,'hex'),signedTransaction:Buffer.from(w.signedTransactionHex,'hex'),minContextSlot:a.source.admissionSlot,newAccountRentCaps:a.quote.rents.map(r=>({address:new PublicKey(r.address),maxIncreaseLamports:BigInt(r.maxIncreaseLamports)}))});}
   catch(e){active();if(e instanceof SeekerRealmSaleFinalityError)fail(e.code==='UNAVAILABLE'?'RECEIPT_UNAVAILABLE':'RECEIPT_CONFLICT');fail('RECEIPT_UNAVAILABLE');}active();
   const e=proof.evidence,receipt=audit({version:1,signature:e.signature,slot:e.slot,blockTime:e.blockTime,originalMessageSha256:e.originalMessageSha256,signedTransactionSha256:e.signedTransactionSha256,receiptAccountHex:proof.receiptAccountHex,feeLamports:e.feeLamports,actualRentLamports:e.actualRentLamports,buyerNetPaymentLamports:e.buyerNetPaymentLamports,accountRentIncreases:e.accountRentIncreases,observedAccountSlot:proof.observedAccountSlot,proofClockUnixTimestamp:proof.proofClockUnixTimestamp.toString(),source:proof.source},s).receipt;
   return db.transaction(async tx=>{active();await tx.execute(sql`insert into seeker_realm_sale_receipts(wallet,idempotency_key,receipt) values(${k.wallet},${k.idempotencyKey},${JSON.stringify(receipt)}::jsonb) on conflict(wallet,idempotency_key) do nothing`);active();const saved=await getRealmSaleSettlement(tx,k);active();if(!saved)fail('RECEIPT_CONFLICT');return saved;});
  })();pending=work;void work.then(()=>{if(pending===work)pending=null;},()=>{if(pending===work)pending=null;});
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new RealmSaleSettlementError('TIMEOUT'));},timeout);})]);}finally{if(timer)clearTimeout(timer);controller.abort();}
 };
}

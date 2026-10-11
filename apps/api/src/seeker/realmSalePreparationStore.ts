/** Immutable unsigned consent records. Recovery rechecks structure/bytes only;
 * new signing/admission must separately refresh trusted chain observations. */
import {PublicKey} from '@solana/web3.js';
import {sql} from 'drizzle-orm';
import {z} from 'zod';
import {PHASE_E_POLICY} from '@shardkeep/shared';
import {createRealmSalePurchaseArgs} from '@shardkeep/chain/seeker-realm-sale';
import {buildRealmSaleMessage} from '@shardkeep/chain/seeker-realm-sale-message';
import type {DbOrTx} from '../db/client';
type Code='INVALID_INPUT'|'SOURCE_CONFLICT'|'REQUEST_CONFLICT';
export class RealmSalePreparationStoreError extends Error{constructor(readonly code:Code){super(`Realm sale preparation refused: ${code}`);this.name='RealmSalePreparationStoreError';}}
function fail(code:Code):never{throw new RealmSalePreparationStoreError(code);}
const P=PHASE_E_POLICY.seekerIsland;
const u64=z.string().max(20).regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const address=z.string().min(32).max(44).refine(v=>{if(v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}});
const hash=z.string().length(64).regex(/^[0-9a-f]{64}$/),slot=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const lookup=z.object({wallet:address,idempotencyKey:z.uuid()}).strict();
const artifactSchema=z.object({version:z.literal(1),wallet:address,idempotencyKey:z.uuid(),saleId:z.string().regex(/^[0-9a-f]{32}$/),spot:z.number().int().min(0).max(P.totalSpots-1),realm:z.number().int().min(0).max(P.realmCount-1),
 terms:z.object({round:u64,day:u64,seller:address,developer:address,priorExpiry:u64,validAfter:u64,validUntil:u64}).strict(),
 source:z.object({revision:z.string().min(1).max(128),genesisHash:address,programId:address,programDataSha256:hash,reviewedDeploymentSlot:slot,termProofHash:hash,snapshotHash:hash,termSlot:slot,initialSlot:slot,blockhashSlot:slot,feeSlot:slot,costSlot:slot,admissionSlot:slot}).strict(),
 quote:z.object({blockhash:address,lastValidBlockHeight:slot,unixTimestamp:u64,needsAccess:z.boolean(),needsQuota:z.boolean(),quotaRemaining:z.number().int().min(1).max(P.paidContractsPerSpotDayMax),
  messageHex:z.string().min(2).max(2334).regex(/^(?:[0-9a-f]{2})+$/),messageSha256:hash,packetBytes:z.number().int().min(1).max(1232),
  rents:z.array(z.object({address,space:z.number().int().positive().max(1232),minimumBalanceLamports:u64,existingLamports:u64,maxIncreaseLamports:u64}).strict()).min(1).max(3),
  feeLamports:u64,rentLamports:u64,paymentDebitLamports:u64,requiredLamports:u64,payerLamports:u64}).strict(),
 state:z.literal('prepared'),currentSigningAuthorized:z.literal(false),submissionAuthorized:z.literal(false),
}).strict();
export type RealmSalePreparation=z.infer<typeof artifactSchema>;
export type RealmSalePreparationKey=z.infer<typeof lookup>;
export function realmSalePreparationArgs(a:RealmSalePreparation){const t=a.terms;return createRealmSalePurchaseArgs({saleId:Buffer.from(a.saleId,'hex'),spot:a.spot,realm:a.realm,round:BigInt(t.round),day:BigInt(t.day),seller:new PublicKey(t.seller),developer:new PublicKey(t.developer),priorExpiry:BigInt(t.priorExpiry),validAfter:BigInt(t.validAfter),validUntil:BigInt(t.validUntil)});}
function parse(value:unknown,code:Code):RealmSalePreparation{
 const parsed=artifactSchema.safeParse(value);if(!parsed.success)fail(code);const a=parsed.data,q=a.quote,s=a.source;
 try{
  const args=realmSalePreparationArgs(a),plan=buildRealmSaleMessage(new PublicKey(s.programId),{wallet:new PublicKey(a.wallet),args,blockhash:q.blockhash,needsAccess:q.needsAccess,needsQuota:q.needsQuota});
  const times=[s.reviewedDeploymentSlot,s.termSlot,s.initialSlot,s.blockhashSlot,s.feeSlot,s.costSlot,s.admissionSlot];
  if(times.some((n,i)=>i>0&&n<times[i-1]!)||BigInt(q.unixTimestamp)<args.validAfter||BigInt(q.unixTimestamp)>args.validUntil)fail(code);
  if(q.messageHex!==Buffer.from(plan.messageBytes).toString('hex')||q.messageSha256!==plan.messageSha256||q.packetBytes!==plan.packetBytes||q.rents.length!==plan.expectedNewAccounts.length)fail(code);
  let rent=0n;for(const [i,r]of q.rents.entries()){
   const expected=plan.expectedNewAccounts[i]!;if(r.address!==expected.address||r.space!==expected.space)fail(code);
   const minimum=BigInt(r.minimumBalanceLamports),existing=BigInt(r.existingLamports),deficit=minimum>existing?minimum-existing:0n;
   if(BigInt(r.maxIncreaseLamports)!==deficit)fail(code);rent+=deficit;
  }
  const required=rent+BigInt(q.feeLamports)+plan.buyerNetPaymentLamports;
  if(rent!==BigInt(q.rentLamports)||BigInt(q.paymentDebitLamports)!==plan.buyerNetPaymentLamports||required!==BigInt(q.requiredLamports)||required>BigInt(q.payerLamports))fail(code);
  return a;
 }catch{fail(code);}
}
/** Application-side validation is repeated on recovery; SQL artifacts alone do
 * not attest a reviewed quote source or permit new signing. */
export function validateRealmSalePreparation(value:unknown):RealmSalePreparation{return parse(value,'INVALID_INPUT');}
export async function getRealmSalePreparation(db:DbOrTx,input:RealmSalePreparationKey):Promise<RealmSalePreparation|null>{
 const key=lookup.safeParse(input);if(!key.success)fail('INVALID_INPUT');const [row]=await db.execute<{artifact:unknown}>(sql`select artifact from seeker_realm_sale_preparations where wallet=${key.data.wallet} and idempotency_key=${key.data.idempotencyKey}`);
 if(!row)return null;const a=parse(row.artifact,'SOURCE_CONFLICT');if(a.wallet!==key.data.wallet||a.idempotencyKey!==key.data.idempotencyKey)fail('SOURCE_CONFLICT');return a;
}
/** Internal verified-source writer, never a route-body decoder. A competing
 * quote for the same request loses to the first immutable actor/key artifact. */
export async function saveRealmSalePreparation(db:DbOrTx,value:RealmSalePreparation):Promise<RealmSalePreparation>{
 const a=parse(value,'INVALID_INPUT'),key={wallet:a.wallet,idempotencyKey:a.idempotencyKey};
 const match=(prior:RealmSalePreparation)=>{if(prior.spot!==a.spot||prior.realm!==a.realm)fail('REQUEST_CONFLICT');return prior;};
 const prior=await getRealmSalePreparation(db,key);if(prior)return match(prior);
 await db.execute(sql`insert into seeker_realm_sale_preparations(artifact) values(${JSON.stringify(a)}::jsonb) on conflict(wallet,idempotency_key) do nothing`);
 const saved=await getRealmSalePreparation(db,key);if(!saved)fail('SOURCE_CONFLICT');return match(saved);
}

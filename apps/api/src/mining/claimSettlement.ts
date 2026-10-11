/** Owner-verified immutable success. Runtime recovery never acquires a writer. */
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { decodeMiningAllocationLeaf,decodeMiningAllocationProof } from '@shardkeep/chain/mining-allocation';
import { createMiningClaimReceiptVerifier,MiningClaimReceiptError,type MiningClaimReceipt,type MiningClaimReceiptReader,type MiningClaimReceiptTrust } from '@shardkeep/chain/mining-claim-receipt';
import type { DbOrTx } from '../db/client';
import { getMiningClaimSigned,type MiningClaimSigned } from './claimSignedStore';
type Code='INVALID_INPUT'|'OWNER_REQUIRED'|'NOT_SIGNED'|'RECEIPT_UNAVAILABLE'|'RECEIPT_CONFLICT'|'BUSY'|'TIMEOUT';
export class MiningClaimSettlementError extends Error{constructor(readonly code:Code){super(`Mining claim settlement refused: ${code}`);this.name='MiningClaimSettlementError';}}
function fail(code:Code):never{throw new MiningClaimSettlementError(code);}
const key=z.string().min(32).max(44).refine(v=>{if(v.length<32||v.length>44)return false;try{return new PublicKey(v).toBase58()===v;}catch{return false;}}),hash=z.string().regex(/^[0-9a-f]{64}$/);
const uint=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),u64=z.string().regex(/^(0|[1-9][0-9]{0,19})$/).refine(v=>/^(0|[1-9][0-9]{0,19})$/.test(v)&&BigInt(v)<(1n<<64n));
const request=z.object({wallet:key,claimId:z.uuid(),ordinal:z.number().int().min(0).max(1)}).strict();
export interface MiningClaimSettlementKey{wallet:string;claimId:string;ordinal:number}
export interface MiningClaimSettlement extends MiningClaimSettlementKey{signature:string;receipt:MiningClaimReceipt;settledAt:string;claimFinalized:true}
const receiptSchema=z.object({version:z.literal(1),kind:z.enum(['combined','setup','claim']),wallet:key,day:u64,sequence:u64.refine(v=>v!=='0'),root:hash,paidKeepBaseUnits:u64,signature:z.string().min(64).max(88),slot:uint,blockTime:uint,observedAccountSlot:uint,originalMessageSha256:hash,signedTransactionSha256:hash,
 source:z.object({trust:z.literal('trusted-finalized-rpc-reviewed-program'),genesisHash:key,programId:key,configAddress:key,sourceHash:hash,reviewedDeploymentSlot:uint,reviewedProgramDataSha256:hash}).strict(),
 currentClaimedTotal:u64,currentGlobalClaimedTotal:u64,currentMinerSequence:u64,currentRenownTotal:u64,currentDaysAttested:u64,currentRenownSequence:u64,currentClaimsAuthorized:z.literal(false)}).strict();
function parseKey(v:unknown):MiningClaimSettlementKey{const p=request.safeParse(v);if(!p.success)fail('INVALID_INPUT');return p.data;}
function audit(v:unknown,s:MiningClaimSigned,ordinal:number):MiningClaimReceipt{
 const p=receiptSchema.safeParse(v);if(!p.success)fail('RECEIPT_CONFLICT');const r=p.data,a=s.preparation,h=a.header,w=s.wires.find(x=>x.ordinal===ordinal);if(!w)fail('RECEIPT_CONFLICT');
 const leaf=decodeMiningAllocationLeaf(Buffer.from(a.leafHex,'hex'));
 if(r.wallet!==a.wallet||r.kind!==w.kind||r.signature!==w.signature||r.originalMessageSha256!==w.messageSha256||r.signedTransactionSha256!==w.wireSha256||r.day!==h.day||r.sequence!==h.sequence||r.root!==h.root
  ||r.source.genesisHash!==h.genesisHash||r.source.programId!==h.programId||r.source.configAddress!==h.configAddress||r.source.sourceHash!==h.sourceHash||r.slot<a.blockhashContextSlot||r.slot<=r.source.reviewedDeploymentSlot||r.observedAccountSlot<r.slot
  ||BigInt(r.currentGlobalClaimedTotal)<BigInt(r.currentClaimedTotal)||BigInt(r.currentRenownTotal)>BigInt(r.currentDaysAttested))fail('RECEIPT_CONFLICT');
 const paid=BigInt(r.paidKeepBaseUnits);
 if(r.kind==='setup'){if(paid!==0n)fail('RECEIPT_CONFLICT');}
 else if(paid<=0n||paid>leaf.cumulativeKeep||(r.kind==='combined'&&a.needsMinerRecords&&paid!==leaf.cumulativeKeep)||BigInt(r.currentClaimedTotal)<leaf.cumulativeKeep||BigInt(r.currentMinerSequence)<leaf.sequence||BigInt(r.currentRenownSequence)<leaf.sequence||BigInt(r.currentRenownTotal)<leaf.cumulativeRenown||BigInt(r.currentDaysAttested)<leaf.cumulativeDays)fail('RECEIPT_CONFLICT');
 return r;
}
export async function getMiningClaimSettlement(db:DbOrTx,input:MiningClaimSettlementKey):Promise<MiningClaimSettlement|null>{
 const k=parseKey(input),s=await getMiningClaimSigned(db,{wallet:k.wallet,claimId:k.claimId});if(!s)return null;
 const [row]=await db.execute<{wallet:string;receipt:unknown;settled_at:string}>(sql`select wallet,receipt,to_char(settled_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') settled_at from mining_claim_receipts where claim_id=${k.claimId} and ordinal=${k.ordinal} and wallet=${k.wallet}`);
 const [failure]=await db.execute(sql`select claim_id from mining_claim_failures where claim_id=${k.claimId} and ordinal=${k.ordinal} and wallet=${k.wallet}`);
 if(row&&failure)fail('RECEIPT_CONFLICT');if(!row)return null;if(row.wallet!==k.wallet||typeof row.settled_at!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(row.settled_at))fail('RECEIPT_CONFLICT');
 const receipt=audit(row.receipt,s,k.ordinal);return {...k,signature:receipt.signature,receipt,settledAt:row.settled_at,claimFinalized:true};
}
export function createMiningClaimSettlement(db:DbOrTx,options:{reader:MiningClaimReceiptReader;trust:MiningClaimReceiptTrust;timeoutMs?:number}){
 const verify=createMiningClaimReceiptVerifier(options.reader,options.trust),timeout=options.timeoutMs??30_000;if(!Number.isInteger(timeout)||timeout<1||timeout>30_000)fail('INVALID_INPUT');
 let pending:Promise<MiningClaimSettlement>|null=null;
 return async(input:MiningClaimSettlementKey):Promise<MiningClaimSettlement>=>{
  const k=parseKey(input),old=await getMiningClaimSettlement(db,k);if(old)return old;if(pending)fail('BUSY');
  let expired=false,timer:ReturnType<typeof setTimeout>|undefined;
  const work=(async()=>{
   const [authority]=await db.execute<{allowed:boolean}>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.mining_claim_receipts'::regclass) allowed`);
   if(!authority?.allowed)fail('OWNER_REQUIRED');
   const s=await getMiningClaimSigned(db,{wallet:k.wallet,claimId:k.claimId}),w=s?.wires.find(x=>x.ordinal===k.ordinal);if(!s||!w)fail('NOT_SIGNED');const a=s.preparation,h=a.header;
   let receipt:MiningClaimReceipt;try{receipt=await verify({signature:w.signature,signedTransaction:Buffer.from(w.signedTransactionHex,'hex'),kind:w.kind,blockhashContextSlot:a.blockhashContextSlot,sourceHash:h.sourceHash,...(a.format?{format:a.format}:{}),
    plan:{wallet:new PublicKey(a.wallet),root:Buffer.from(h.root,'hex'),sequence:BigInt(h.sequence),day:BigInt(h.day),totalCumulative:BigInt(h.totalCumulative),leaf:decodeMiningAllocationLeaf(Buffer.from(a.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(a.proofHex,'hex')),blockhash:a.blockhash,needsAta:a.needsAta,needsMinerRecords:a.needsMinerRecords}});}catch(e){if(expired)fail('TIMEOUT');if(e instanceof MiningClaimReceiptError)fail(e.code==='UNAVAILABLE'?'RECEIPT_UNAVAILABLE':'RECEIPT_CONFLICT');fail('RECEIPT_UNAVAILABLE');}
   if(expired)fail('TIMEOUT');receipt=audit(receipt,s,k.ordinal);
   await db.execute(sql`insert into mining_claim_receipts(claim_id,ordinal,receipt) values(${k.claimId},${k.ordinal},${JSON.stringify(receipt)}::jsonb) on conflict(claim_id,ordinal) do nothing`);
   const saved=await getMiningClaimSettlement(db,k);if(!saved)fail('RECEIPT_CONFLICT');return saved;
  })();pending=work;
  void work.then(()=>{if(pending===work)pending=null;},()=>{if(pending===work)pending=null;});
  try{return await Promise.race([work,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new MiningClaimSettlementError('TIMEOUT'));},timeout);})]);}finally{if(timer)clearTimeout(timer);}
 };
}

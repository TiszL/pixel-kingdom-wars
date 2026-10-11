/** Immutable ancestry only. A continuation suppresses old admission, never custody. */
import {sql} from 'drizzle-orm';
import type {DbOrTx} from '../db/client';
import {getMiningClaimSigned,type MiningClaimSigned} from './claimSignedStore';
import {getMiningClaimSettlement,type MiningClaimSettlement} from './claimSettlement';
export async function hasMiningClaimContinuation(db:DbOrTx,wallet:string,claimId:string):Promise<boolean>{
 const [row]=await db.execute(sql`select parent_claim_id from mining_claim_continuations where wallet=${wallet} and parent_claim_id=${claimId}`);return !!row;
}
export function sameMiningClaimEntitlement(a:MiningClaimSigned['preparation'],b:MiningClaimSigned['preparation']):boolean{
 return a.wallet===b.wallet&&JSON.stringify(a.header)===JSON.stringify(b.header)&&a.leafHex===b.leafHex&&a.proofHex===b.proofHex
  &&!!a.format&&!!b.format&&a.format.preset===b.format.preset&&a.format.expectedLookupTable.address===b.format.expectedLookupTable.address&&a.format.expectedLookupTable.dataSha256===b.format.expectedLookupTable.dataSha256;
}
/** Bounded traversal validates every actual link and original before returning
 * its authentic zero-payment setup receipt. No supplied setup ID is accepted. */
export async function miningClaimSetup(db:DbOrTx,signed:MiningClaimSigned,requireChildHeadroom=false):Promise<MiningClaimSettlement|null>{
 const maxAncestors=64;let current=signed;const seen=new Set<string>();
 for(let depth=0;depth<maxAncestors;depth++){
  const p=current.preparation;if(seen.has(p.claimId))throw Error('MINING_CLAIM_CONTINUATION_CYCLE');seen.add(p.claimId);
  if(p.transactions.length===2&&p.transactions[0]?.kind==='setup'&&p.transactions[1]?.kind==='claim'){
   if(requireChildHeadroom&&depth+1===maxAncestors)throw Error('MINING_CLAIM_CONTINUATION_BOUND');
   const receipt=await getMiningClaimSettlement(db,{wallet:p.wallet,claimId:p.claimId,ordinal:0});
   if(receipt&&receipt.receipt.kind==='setup'&&receipt.receipt.paidKeepBaseUnits==='0')return receipt;return null;
  }
  if(!p.format||p.transactions.length!==1||p.transactions[0]?.kind!=='claim'||p.needsAta||p.needsMinerRecords)return null;
  const [row]=await db.execute<{parent_claim_id:string;wallet:string}>(sql`select parent_claim_id,wallet from mining_claim_continuations where child_claim_id=${p.claimId}`);if(!row)return null;
  if(row.wallet!==p.wallet)throw Error('MINING_CLAIM_CONTINUATION_SOURCE');
  const parent=await getMiningClaimSigned(db,{wallet:p.wallet,claimId:row.parent_claim_id});
  if(!parent||!sameMiningClaimEntitlement(parent.preparation,p)||parent.preparation.blockhash===p.blockhash)throw Error('MINING_CLAIM_CONTINUATION_SOURCE');current=parent;
 }
 throw Error('MINING_CLAIM_CONTINUATION_BOUND');
}
export function miningClaimSetupBinding(setup:MiningClaimSettlement){return {claimId:setup.claimId,signature:setup.signature,slot:setup.receipt.slot,observedAccountSlot:setup.receipt.observedAccountSlot,messageSha256:setup.receipt.originalMessageSha256,wireSha256:setup.receipt.signedTransactionSha256};}

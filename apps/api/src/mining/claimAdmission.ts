/** Internal current-state admission only. The caller must still check finalized
 * blockheight/status and use a bounded transport; this does not send a packet. */
import {PublicKey} from '@solana/web3.js';
import {decodeMiningAllocationLeaf,decodeMiningAllocationProof} from '@shardkeep/chain/mining-allocation';
import {buildMiningClaimMessages} from '@shardkeep/chain/mining-claim-message';
import {attestMiningClaimLookup} from '@shardkeep/chain/mining-claim-format';
import { z } from 'zod';
import type { MiningClaimSnapshotReader,MiningClaimSnapshotTrust } from '@shardkeep/chain/mining-claim-snapshot';
import type { Db } from '../db/client';
import { phaseEMiningEnabled } from '../config';
import { createMiningClaimReader } from './claimStatus';
import {hasMiningClaimContinuation,miningClaimSetup} from './claimContinuationStore';
import { getMiningClaimSigned } from './claimSignedStore';

type Code='INVALID_INPUT'|'NOT_FOUND'|'NOT_SIGNED'|'DISABLED'|'EXPIRED'|'SOURCE_UNAVAILABLE'|'CLAIM_PROOF_STALE'|'NOT_READY'|'SETUP_REQUIRED'|'SETUP_CHANGED'|'INSUFFICIENT_SOL'|'CONTINUED';
export class MiningClaimAdmissionError extends Error{constructor(readonly code:Code){super(`Mining claim admission refused: ${code}`);this.name='MiningClaimAdmissionError';}}
function fail(code:Code):never{throw new MiningClaimAdmissionError(code);}
const inputSchema=z.object({wallet:z.string().min(32).max(44),claimId:z.uuid(),ordinal:z.number().int().min(0).max(1)}).strict();
export function createMiningClaimAssessment(db:Db,sources:{reader:MiningClaimSnapshotReader;trust:MiningClaimSnapshotTrust;now?:()=>Date;timeoutMs?:number},requireSigned=true){
 const assessment=createMiningClaimReader(db,sources),now=sources.now??(()=>new Date());
 return async(value:unknown)=>{
  const p=inputSchema.safeParse(value);if(!p.success)fail('INVALID_INPUT');const {wallet,claimId,ordinal}=p.data;
  const saved=await getMiningClaimSigned(db,{wallet,claimId});if(!saved)fail('NOT_FOUND');const wire=saved.wires.find(w=>w.ordinal===ordinal);if(requireSigned&&!wire)fail('NOT_SIGNED');
  const prepared=saved.preparation,tx=prepared.transactions[ordinal];
  if(prepared.format&&await hasMiningClaimContinuation(db,wallet,claimId))fail('CONTINUED');if(!tx)fail('SOURCE_UNAVAILABLE');
  const active=()=>{if(!phaseEMiningEnabled())fail('DISABLED');const at=now();if(!(at instanceof Date)||!Number.isFinite(+at))fail('SOURCE_UNAVAILABLE');if(+at<Date.parse(prepared.preparedAt))fail('SOURCE_UNAVAILABLE');if(+at>=Date.parse(prepared.expiresAt))fail('EXPIRED');};active();
  const fresh=await assessment.assess(wallet);active();const {status,projection,snapshot}=fresh;
  if(status.state==='unavailable'){if(status.reason==='UNSUPPORTED_FRONTIER')fail('CLAIM_PROOF_STALE');fail('SOURCE_UNAVAILABLE');}
  if(!projection||projection.kind!=='entitlement'||!snapshot)fail('NOT_READY');
  if(Object.entries(prepared.header).some(([key,v])=>projection.header[key as keyof typeof projection.header]!==v))fail('CLAIM_PROOF_STALE');
  if(status.state!=='ready'||!status.preparationAllowed)fail('NOT_READY');
  if(snapshot.slot<prepared.blockhashContextSlot||projection.leafHex!==prepared.leafHex||projection.proofHex!==prepared.proofHex)fail('SOURCE_UNAVAILABLE');
  const setup=prepared.format||ordinal>0?await miningClaimSetup(db,saved):null;
  if(setup&&snapshot.slot<Math.max(setup.receipt.slot,setup.receipt.observedAccountSlot))fail('SOURCE_UNAVAILABLE');
  if(setup&&(snapshot.minerClaim===null||snapshot.renownRecord===null||!snapshot.claimantAta.exists||snapshot.minerClaim.claimedTotal<BigInt(setup.receipt.currentClaimedTotal)||snapshot.minerClaim.lastSequence<BigInt(setup.receipt.currentMinerSequence)||snapshot.renownRecord.lastSequence<BigInt(setup.receipt.currentRenownSequence)||snapshot.renownRecord.renownTotal<BigInt(setup.receipt.currentRenownTotal)||snapshot.renownRecord.daysAttested<BigInt(setup.receipt.currentDaysAttested)||snapshot.backing.config.totalClaimed<BigInt(setup.receipt.currentGlobalClaimedTotal)))fail('SETUP_CHANGED');
  if(ordinal>0){
   if(!setup)fail('SETUP_REQUIRED');
   if(snapshot.slot<Math.max(setup.receipt.slot,setup.receipt.observedAccountSlot)||snapshot.minerClaim===null||snapshot.renownRecord===null||!snapshot.claimantAta.exists)fail('SETUP_CHANGED');
   const h=prepared.header,plan=buildMiningClaimMessages({programId:new PublicKey(h.programId),keepMint:new PublicKey(h.keepMint),reserveOwner:new PublicKey(h.reserveOwner)},
    {wallet:new PublicKey(wallet),root:Buffer.from(h.root,'hex'),sequence:BigInt(h.sequence),day:BigInt(h.day),totalCumulative:BigInt(h.totalCumulative),leaf:decodeMiningAllocationLeaf(Buffer.from(prepared.leafHex,'hex')),proof:decodeMiningAllocationProof(Buffer.from(prepared.proofHex,'hex')),blockhash:prepared.blockhash,needsAta:false,needsMinerRecords:false},prepared.format);
   if(plan.transactions.length!==1||plan.transactions[0]!.kind!=='claim'||plan.transactions[0]!.messageSha256!==tx.messageSha256||Buffer.from(plan.transactions[0]!.messageBytes).toString('hex')!==tx.messageHex)fail('SETUP_CHANGED');
  }else{
   if(prepared.needsMinerRecords&&snapshot.minerClaim!==null)fail('SETUP_CHANGED');
   if(!prepared.needsMinerRecords&&snapshot.minerClaim===null)fail('SETUP_CHANGED');
   if(!prepared.needsAta&&!snapshot.claimantAta.exists)fail('SETUP_CHANGED');
  }
  if(prepared.format)await attestMiningClaimLookup(sources.reader,prepared.format,snapshot.slot);
  active();if(prepared.format&&await hasMiningClaimContinuation(db,wallet,claimId))fail('CONTINUED');active();
  if(snapshot.payer.lamports===null||snapshot.payer.lamports<BigInt(tx.feeLamports)+BigInt(tx.rentLamports))fail('INSUFFICIENT_SOL');
  const bytes=wire?Buffer.from(wire.signedTransactionHex,'hex'):Buffer.alloc(0);
  return Object.freeze({wallet,claimId,ordinal,kind:tx.kind,signature:wire?.signature??'',preparation:prepared,setup,get signedTransaction(){return Uint8Array.from(bytes);},
   snapshotSlot:snapshot.slot,genesisHash:prepared.header.genesisHash,lastValidBlockHeight:prepared.lastValidBlockHeight,
   currentClaimsAuthorized:false as const});
 };
}

export function createMiningClaimAdmission(db:Db,sources:Parameters<typeof createMiningClaimAssessment>[1]){return createMiningClaimAssessment(db,sources,true);}

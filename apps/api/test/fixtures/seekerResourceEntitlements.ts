/** R1 synthetic retained term. Exercises the real immutable pin service. */
import { Keypair, PublicKey } from '@solana/web3.js';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import bs58 from 'bs58';
import type { Db } from '../../src/db/client';
import { pinOperatingExpeditionTerm } from '../../src/game/expeditionTermStore';
import type { ExpeditionTermSnapshot } from '../../src/game/expeditionTerms';
export async function retainResourceViewTerm(db: Db, termId: string, wallet: string | null) {
 const key=(n:number)=>new PublicKey(new Uint8Array(32).fill(n)).toBase58();
 const startsAt='2035-01-01T00:00:00.000Z';
 const snapshot:ExpeditionTermSnapshot={version:1,termId,startsAt,endsAt:new Date(Date.parse(startsAt)+PHASE_E_POLICY.seekerIsland.operatingTermSec*1000).toISOString(),
  source:{kind:'solana_auction_round',genesisHash:key(201),programId:key(202),auctionConfig:Keypair.generate().publicKey.toBase58(),round:'1'},
  spots:Array.from({length:PHASE_E_POLICY.seekerIsland.totalSpots},(_,spotId)=>({spotId,ownerWallet:spotId===0?wallet:null,auctionAccount:key(spotId+1),
   settlementSignature:bs58.encode(new Uint8Array(64).fill(7)),settlementSlot:String(100+spotId),termsHash:'ab'.repeat(32)}))};
 return pinOperatingExpeditionTerm(db,new Date(startsAt),{async readOperatingTerm(at){return {snapshot,finality:{commitment:'finalized',contextSlot:'200',observedAt:at}};}});
}

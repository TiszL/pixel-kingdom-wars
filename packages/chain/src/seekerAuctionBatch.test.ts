/** T5 supplement: builder packets remain consumable by existing settlement evidence. */
import { describe,expect,it } from 'vitest';
import bs58 from 'bs58';
import { Keypair,PublicKey,TransactionMessage,VersionedTransaction,type VersionedTransactionResponse } from '@solana/web3.js';
import { getAssociatedTokenAddressSync,TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { PHASE_E_POLICY,PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { buildSettleIx } from './seekerAuctionInstructions';
import { canonicalSeekerRegistry,hashSeekerRegistry,hashSeekerAuctionTerms,seekerAuctionConfigPda,seekerAuctionPda,seekerRegistryPda,seekerTermPda,type SeekerAuctionTerms } from './seekerAuctionProtocol';
import { seekerSettlementEvidence } from './seekerSettlementEvidence';
import idl from './idl/shardkeep_economy.json' with {type:'json'};
const program=new PublicKey(idl.address),signer=Keypair.fromSeed(Buffer.alloc(32,4)),wallet=signer.publicKey;
const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)),mint=pk(10),prizeOwner=pk(11),genesis=pk(12),round=0n,config=seekerAuctionConfigPda(program);
function terms(spotId:number):SeekerAuctionTerms {
 const auction=seekerAuctionPda(program,config,spotId,round),operatingStart=1791158400n;
 return {...canonicalSeekerRegistry()[spotId]!,config,auction,term:seekerTermPda(program,config,round),registry:seekerRegistryPda(program),registryHash:hashSeekerRegistry(canonicalSeekerRegistry()),round,
  auctionStart:operatingStart-BigInt(PHASE_E_POLICY.seekerIsland.overlappingAuctionSec),auctionEnd:operatingStart,operatingStart,operatingEnd:operatingStart+BigInt(PHASE_E_POLICY.seekerIsland.operatingTermSec),
  mint,tokenProgram:TOKEN_PROGRAM_ID,vault:getAssociatedTokenAddressSync(mint,auction,true),prizeOwner,prizeAta:getAssociatedTokenAddressSync(mint,prizeOwner,true),prizeBps:PHASE_E_SEEKER_AUCTION.prizeBps,
  grace:BigInt(PHASE_E_SEEKER_AUCTION.settlementGraceSec),openingBid:10n,registryVersion:1,auctionFormat:1,termsFormat:1};
}
describe('T5 distinct-auction batch',()=>{
 it('proves each of four top-level settlements independently, including an unsold sentinel',()=>{
  const rows=[0,1,20,99].map(terms),instructions=rows.map((t,i)=>buildSettleIx(program,{wallet,mint,round,spot:t.spotId,prizeOwner,highBidder:i===3?null:wallet,highBid:i===3?0n:20n}));
  const message=new TransactionMessage({payerKey:wallet,recentBlockhash:pk(13).toBase58(),instructions}).compileToLegacyMessage(),tx=new VersionedTransaction(message);tx.sign([signer]);
  expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  const signature=bs58.encode(tx.signatures[0]!);
  const evidence:VersionedTransactionResponse={slot:500,blockTime:null,version:'legacy',transaction:{message,signatures:[signature]},meta:{err:null,fee:5000,preBalances:[],postBalances:[],innerInstructions:[]}};
  for(const[tIndex,t]of rows.entries())expect(seekerSettlementEvidence(evidence,{signature,genesisHash:genesis,programId:program,terms:t,termsHash:hashSeekerAuctionTerms(t),winner:tIndex===3?null:wallet,highBid:tIndex===3?0n:20n,settledAt:t.auctionEnd+t.grace,settledSlot:500n},genesis)).toMatchObject({instructionIndex:tIndex,method:'permissionless'});
 });
});

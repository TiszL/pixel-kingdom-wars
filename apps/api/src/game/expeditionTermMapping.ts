/** Pure shared representation, never provenance or current-term admission.
 * Both readers must independently verify their chain source before mapping it. */
import {createHash} from 'node:crypto';
import type {FinalizedSeekerTerm} from '@shardkeep/chain/seeker-terms';
import {parseExpeditionTermSnapshot} from './expeditionTerms';

// RFC4122 URL namespace. Keep the original source name byte-for-byte stable.
const URL_NAMESPACE=Buffer.from('6ba7b8119dad11d180b400c04fd430c8','hex');
function termId(genesis:string,program:string,config:string,round:string):string{
 const name=`shardkeep:seeker-term:v1:${genesis}:${program}:${config}:${round}`;
 const bytes=createHash('sha1').update(URL_NAMESPACE).update(name,'utf8').digest().subarray(0,16);
 bytes[6]=(bytes[6]!&0x0f)|0x50;bytes[8]=(bytes[8]!&0x3f)|0x80;
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
export function seekerTermInteger(value:bigint):string{
 if(typeof value!=='bigint')throw new Error('Invalid verified Seeker integer');
 return value.toString();
}
export function seekerTermInstant(seconds:bigint):string{
 if(typeof seconds!=='bigint')throw new Error('Invalid verified Seeker clock');
 const milliseconds=seconds*1_000n;
 // JavaScript Date's exact finite range, not a game duration or price.
 if(milliseconds< -8_640_000_000_000_000n||milliseconds>8_640_000_000_000_000n)
  throw new Error('Verified Seeker clock exceeds UTC storage range');
 return new Date(Number(milliseconds)).toISOString();
}
export function mapVerifiedSeekerTermSnapshot(result:FinalizedSeekerTerm,
 expected:Readonly<{genesis:string;program:string;config:string;round:string}>){
 const source=result.source,round=seekerTermInteger(source.round);
 if(source.genesisHash!==expected.genesis||source.programId!==expected.program||source.config!==expected.config||round!==expected.round)
  throw new Error('Verified Seeker source differs from reviewed policy');
 return parseExpeditionTermSnapshot({
  version:1,termId:termId(source.genesisHash,source.programId,source.config,round),
  startsAt:seekerTermInstant(result.operatingStart),endsAt:seekerTermInstant(result.operatingEnd),
  source:{kind:'solana_auction_round',genesisHash:source.genesisHash,programId:source.programId,auctionConfig:source.config,round},
  spots:result.auctions.map(auction=>{
   if(auction.settlement.slot!==auction.settledSlot)throw new Error('Verified Seeker settlement slot differs from original account');
   return {spotId:auction.terms.spotId,ownerWallet:auction.winner,auctionAccount:auction.terms.auction,
    settlementSignature:auction.settlement.signature,settlementSlot:seekerTermInteger(auction.settledSlot),termsHash:auction.termsHash};
  }),
 });
}

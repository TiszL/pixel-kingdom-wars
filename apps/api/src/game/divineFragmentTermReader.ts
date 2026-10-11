/** D153.192 private chain boundary. A policy/reader/certificate-shaped object
 * is not a source. The service must separately authenticate the original Divine
 * event and earning instant; this reader confers no issuance or stock authority. */
import type {ReviewedSeekerSourcePolicy,SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import {PHASE_E_DIVINE_TRIALS as P} from '@shardkeep/shared';
import {copyHistoricalShardsSourcePolicy} from '../mining/shardsTaxHistoricalTermReader';
import {prefetchHistoricalShardsTermAt} from '../mining/shardsTaxHistoricalTermDiscovery';
import type {HistoricalShardsTermCertificate} from '../mining/shardsTaxObstacleEvidence';

export interface DivineFragmentTermSource {readonly genesisHash:string;readonly programId:string;readonly auctionConfig:string;}
type PrivateSource={readonly connect:(signal:AbortSignal)=>SeekerTermRpc;readonly policy:ReviewedSeekerSourcePolicy};
const sources=new WeakMap<DivineFragmentTermSource,PrivateSource>();
export function createDivineFragmentTermSource(connect:PrivateSource['connect'],reviewed:ReviewedSeekerSourcePolicy):DivineFragmentTermSource{
 if(typeof connect!=='function')throw Error('DIVINE_FRAGMENT_TERM_SOURCE');
 const policy=copyHistoricalShardsSourcePolicy(reviewed);
 const source=Object.freeze({genesisHash:policy.genesisHash.toBase58(),programId:policy.programId.toBase58(),auctionConfig:policy.config.toBase58()});
 sources.set(source,{connect,policy});return source;
}
/** Call before acquiring gameplay locks. No cache or current-round fallback. */
export async function readDivineFragmentHistoricalTerm(source:DivineFragmentTermSource,earnedAt:string,expectedGenesis:string):Promise<HistoricalShardsTermCertificate>{
 const original=source&&typeof source==='object'?sources.get(source):undefined;
 if(!original)throw Error('DIVINE_FRAGMENT_TERM_SOURCE');
 if(expectedGenesis!==original.policy.genesisHash.toBase58())throw Error('DIVINE_FRAGMENT_TERM_DOMAIN');
 const certificate=await prefetchHistoricalShardsTermAt(original.connect,original.policy,earnedAt,{deadlineMs:P.rpcTimeoutMs});
 const term=certificate.snapshot;
 if(term.source.genesisHash!==expectedGenesis||term.source.programId!==source.programId||term.source.auctionConfig!==source.auctionConfig
  ||certificate.completedAt>earnedAt||earnedAt<term.startsAt||earnedAt>=term.endsAt)throw Error('DIVINE_FRAGMENT_TERM_ORIGINAL');
 return certificate;
}

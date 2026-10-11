/** Historical chain prefetch only: no database, current-round discovery or issuer
 * mount. Call before gameplay locks with an independently reviewed original-round
 * policy. A serialized certificate is not itself a posting/custody capability. */
import {PublicKey} from '@solana/web3.js';
import {readFinalizedHistoricalSeekerTerm,type ReviewedSeekerSourcePolicy,type ReviewedSeekerTermPolicy,type SeekerTermRpc} from '@shardkeep/chain/seeker-terms';
import {mapVerifiedSeekerTermSnapshot,seekerTermInteger,seekerTermInstant} from '../game/expeditionTermMapping';
import {hashExpeditionTermSnapshot} from '../game/expeditionTerms';
import {parseHistoricalShardsTermCertificate,type HistoricalShardsTermCertificate} from './shardsTaxObstacleEvidence';

export function copyHistoricalShardsSourcePolicy(reviewedPolicy:ReviewedSeekerSourcePolicy):ReviewedSeekerSourcePolicy{
 // PublicKey contains mutable integer storage. Copy its bytes as well as every
 // nested pin before the first await; caller mutation cannot change this attempt.
 const key=(value:PublicKey)=>new PublicKey(value.toBytes());
 return Object.freeze({
  programId:key(reviewedPolicy.programId),config:key(reviewedPolicy.config),
  mint:key(reviewedPolicy.mint),prizeOwner:key(reviewedPolicy.prizeOwner),prizeAta:key(reviewedPolicy.prizeAta),
  genesisHash:key(reviewedPolicy.genesisHash),stateProvenance:reviewedPolicy.stateProvenance,
  deployment:Object.freeze({programDataAddress:reviewedPolicy.deployment.programDataAddress,
   programDataSha256:reviewedPolicy.deployment.programDataSha256,upgradeAuthority:reviewedPolicy.deployment.upgradeAuthority}),
 });
}
export async function prefetchHistoricalShardsTerm(connect:(signal:AbortSignal)=>SeekerTermRpc,
 reviewedPolicy:ReviewedSeekerTermPolicy):Promise<HistoricalShardsTermCertificate>{
 const policy=Object.freeze({...copyHistoricalShardsSourcePolicy(reviewedPolicy),round:reviewedPolicy.round});
 // This reader verifies actual finalized accounts and original settlement
 // instructions, bracketed by the reviewed deployment. Unavailable proof throws;
 // an all-unsold result requires the same complete independent verification.
 const result=await readFinalizedHistoricalSeekerTerm(connect,policy);
 return mapHistoricalShardsTermCertificate(result,policy);
}
/** Representation only; callers must obtain result from the complete verifier. */
export function mapHistoricalShardsTermCertificate(result:Awaited<ReturnType<typeof readFinalizedHistoricalSeekerTerm>>,
 policy:ReviewedSeekerTermPolicy):HistoricalShardsTermCertificate{
 const expected={genesis:policy.genesisHash.toBase58(),program:policy.programId.toBase58(),
  config:policy.config.toBase58(),round:seekerTermInteger(policy.round)};
 if(result.deployment.programDataAddress!==policy.deployment.programDataAddress
  ||result.deployment.programDataSha256!==policy.deployment.programDataSha256
  ||result.deployment.upgradeAuthority!==policy.deployment.upgradeAuthority)
  throw new Error('Historical Seeker deployment differs from reviewed policy');
 const snapshot=mapVerifiedSeekerTermSnapshot(result,expected);
 return parseHistoricalShardsTermCertificate({version:1,purpose:'historical_shards_attribution',snapshot,
  termHash:hashExpeditionTermSnapshot(snapshot),completedAt:seekerTermInstant(result.completedAt),
  completedSlot:seekerTermInteger(result.completedSlot),
  deployment:{programDataAddress:result.deployment.programDataAddress,programDataSha256:result.deployment.programDataSha256,
   deployedSlot:seekerTermInteger(result.deployment.deployedSlot),upgradeAuthority:result.deployment.upgradeAuthority},
  finality:{commitment:result.finality.commitment,contextSlot:seekerTermInteger(result.finality.contextSlot),observedAt:result.finality.observedAt},
  operatingAdmissionAuthorized:result.operatingAdmissionAuthorized,
 });
}

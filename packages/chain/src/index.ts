/**
 * @shardkeep/chain — server-side TS clients for the Anchor programs
 * (shardkeep-core, shardkeep-distributor) plus KEEP token and Metaplex Core
 * Land Deed helpers (ARCHITECTURE §3/§4).
 */
export {
  CORE_PROGRAM_ID,
  DISTRIBUTOR_PROGRAM_ID,
  claimStatusPda,
  configPda,
  coreProgram,
  distributorPda,
  distributorProgram,
  epochRootPda,
  isCanonicalPlayerAccount,
  makeProvider,
  parsePaymentMadeEvents,
  playerPda,
  vaultAuthorityPda,
  type PaymentMadeEvent,
} from './programs';
export {
  addressesFileName,
  legacyBootstrapBucketKey,
  loadAddresses,
  runBootstrap,
  smokeTestPayEntry,
  type BootstrapPaths,
  type ChainAddresses,
  type DevnetAddresses,
  type GameSolanaCluster,
  type LegacyBootstrapAddresses,
  type ReviewedProgramDeployment,
} from './bootstrap';
export {
  SOLANA_GENESIS_HASH,
  SolanaClusterRpcError,
  assertIndependentRpcProviders,
  assertSolanaCluster,
} from './cluster';
export {
  assertMainnetAddressRegistry,
  assertReviewedProgramDeployment,
} from './registryAttestation';
export {
  buildMerkleTree,
  hashLeaf,
  toHex,
  verifyProof,
  type MerkleLeafInput,
  type MerkleTree,
} from './merkle';
export { postEpochRoot } from './programs';
export {
  deserializePreparedKeepWithdrawal,
  makeHotWalletKeepSender,
  makeRemotePolicyKeepSender,
  prepareKeepWithdrawalWithKeypair,
  serializePreparedKeepWithdrawal,
  validateKeepWithdrawalPreparationRequest,
  validatePreparedKeepWithdrawal,
  validatePreparedKeepWithdrawalForRequest,
  validatePreparedKeepWithdrawalMatchesRequest,
  PolicySignerRequestRefusedError,
  PolicySignerUnavailableError,
  type KeepTransferSender,
  type KeepWithdrawalFinality,
  type KeepWithdrawalPreparationRequest,
  type KeepWithdrawalSnapshot,
  type PolicySignerPrepareRequest,
  type PreparedKeepWithdrawal,
  type RemotePolicySignerOptions,
  type SerializedPreparedKeepWithdrawal,
  type WithdrawalReconciliationSource,
} from './hotWallet';
export { createBrandedMint, type CreateBrandedMintOpts, type CreateBrandedMintResult } from './token';
export {
  PaymentProofUnavailableError, finalizedPaymentTransactions, finalizedReferenceTransactions, isCanonicalSolanaSignature, keepAta, verifyKeepDeposit,
  verifyKeepDepositCommit, verifySolPayment, verifySolPaymentCommit, verifySplitPayment, verifySplitPaymentCommit,
  type FinalizedReferenceTransaction,
} from './keepDeposit';
export {
  addDeedUpdateDelegate, createDeedCollection, deedAssetName, deedJsonUri, deedJsonUriVersioned,
  deriveLandDeedAsset,
  deedUriVersion, fetchDeedCollectionRoyalties, fetchDeedUpdateDelegates, mintLandDeed,
  setDeedCollectionRoyaltyCreator, setDeedRoyalties,
  thawLandDeed, updateLandDeedUri, updateLandDeedUris,
  type BatchUpdateResult, type DeedChainOpts, type DeedUriUpdate,
} from './landDeed';
export { getAssetOwner, getOwnedCoreAssets, type AssetOwnership, type OwnedCoreAsset } from './das';
export {
  coreOwnershipFromAccounts, getFinalizedCoreAssetOwner, getFinalizedCoreAssetOwnerBatch,
  getFinalizedCoreAssetOwners, type FinalizedAssetOwnership,
  type FinalizedAssetOwnershipBatch, type FinalizedAssetOwnershipRequest,
} from './coreOwnership';
export {
  assertMainnetCluster, checkSgtMint, independentSourceCount, SeekerRpcError,
  SeekerSourceConflictError, verifySgtOwnership,
  type ParsedMintAccount, type SgtHolding, type SgtVerification,
} from './seeker';
export {
  decodeNameRecord, deriveSkrNameAccount, deriveSkrReverseAccount, discoverSkrOwnedBy,
  parseSkrLabel, resolveSkrOwnedBy, type SkrRecord,
} from './skr';

export { readDeedMintInventory, readDeedMintProof, makeDeedMintInventoryConnection, DeedMintInventoryError, DeedMintTransportError, type MintInventoryConnection, type MintInventoryAttempt, type MintInventoryDiagnostics, type DeedMintProof } from './deedMintEvidence';
export { readDeedOwnerAtClose } from './deedCloseEvidence';

/** Translate explicit operator settings into the separately reviewed market
 * transport. Selected startup economy identity supplies the mint and genesis. */
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import type { Config } from '../config';
import type { EconomyChainBinding } from '../money/economyIdentity';
import { selectPhaseEKeepRuntimeIdentity, type PhaseEKeepIdentity, type PhaseEKeepRegistry,
  type PhaseEKeepSelection } from '../money/phaseEKeepIdentity';
import { createKeepEquipmentRuntime } from './keepEquipmentRuntime';

export function createConfiguredKeepMarketRuntime(config: Config & PhaseEKeepSelection,
  economy: Pick<EconomyChainBinding, 'cluster' | 'keepMint'> & Pick<PhaseEKeepRegistry, 'keepMintV4'>,
  phaseE?: PhaseEKeepIdentity) {
  // Admission is owned by the startup resolver/DB gate. The market does not
  // invent deployment pins or accept a structural copy of that capability.
  const identity = selectPhaseEKeepRuntimeIdentity(config, phaseE, {
    programId: phaseE?.economyProgram, slot: phaseE?.economyDeployment?.reviewedDeploymentSlot,
    sha256: phaseE?.economyDeployment?.reviewedProgramDataSha256,
    upgradeAuthority: phaseE?.economyDeployment?.upgradeAuthority,
  });
  if ((identity && (economy.cluster !== identity.cluster || economy.keepMintV4 !== identity.keepMint))
      || (economy.keepMintV4 !== undefined && economy.keepMintV4 === economy.keepMint)) {
    throw Error('KEEP market identity is missing or mismatched; serving is refused');
  }
  const limits = [config.KEEP_MARKET_MIN_CONTEXT_SLOT, config.KEEP_MARKET_TRANSACTION_VERSION,
    config.KEEP_MARKET_MAX_FEE_LAMPORTS, config.KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS, config.KEEP_MARKET_MAX_COMPUTE_UNIT_LIMIT];
  if (limits.every(value => value === undefined) && !config.KEEP_MARKET_BROADCAST_RPC_URL) return null;
  if (limits.some(value => value === undefined) || !config.SOLANA_RPC_URL_2
      || !config.SOLANA_RPC_PROVIDER || !config.SOLANA_RPC_PROVIDER_2 || config.SOLANA_CLUSTER !== economy.cluster
      || !['legacy', '0'].includes(config.KEEP_MARKET_TRANSACTION_VERSION!)
      || config.SOLANA_RPC_PROVIDER.toLowerCase() === config.SOLANA_RPC_PROVIDER_2.toLowerCase()) {
    throw Error('KEEP market requires complete reviewed limits and two independent labelled RPC providers');
  }
  const providers = [config.SOLANA_RPC_PROVIDER.toLowerCase(), config.SOLANA_RPC_PROVIDER_2.toLowerCase()] as const;
  return createKeepEquipmentRuntime({ nodeEnv: config.NODE_ENV,
    readRpcUrls: [config.SOLANA_RPC_URL, config.SOLANA_RPC_URL_2], readProviders: providers,
    ...(config.KEEP_MARKET_BROADCAST_RPC_URL ? { broadcastRpcUrl: config.KEEP_MARKET_BROADCAST_RPC_URL } : {}),
    trust: { expectedGenesisHash: identity?.genesisHash ?? SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER],
      expectedKeepMint: identity?.keepMint ?? economy.keepMint,
      providerIds: providers, minContextSlot: config.KEEP_MARKET_MIN_CONTEXT_SLOT!, deadlineMs: 30_000,
      transactionVersion: config.KEEP_MARKET_TRANSACTION_VERSION === 'legacy' ? 'legacy' : 0,
      maxFeeLamports: BigInt(config.KEEP_MARKET_MAX_FEE_LAMPORTS!),
      maxPriorityFeeLamports: BigInt(config.KEEP_MARKET_MAX_PRIORITY_FEE_LAMPORTS!),
      maxComputeUnitLimit: config.KEEP_MARKET_MAX_COMPUTE_UNIT_LIMIT! } });
}

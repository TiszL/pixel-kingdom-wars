import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
/** Process-owned, read-only PoR wiring. Operator pins are never request inputs. */
import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config';
import type { Db } from '../db/client';
import type { EconomyChainBinding } from './economyIdentity';
import { assertNoObsoletePhaseEKeepConfiguration, selectPhaseEKeepRuntimeIdentity, type PhaseEKeepIdentity, type PhaseEKeepSelection } from './phaseEKeepIdentity';
import { createMiningTransparencyReader } from './miningTransparency';

export function createMiningTransparencyRuntime(db: Db, config: Config & PhaseEKeepSelection, economy: EconomyChainBinding, phaseE?: PhaseEKeepIdentity) {
  assertNoObsoletePhaseEKeepConfiguration(config);
  const pins = [config.MINING_TRANSPARENCY_PROGRAM_ID, config.MINING_TRANSPARENCY_DEPLOYMENT_SLOT,
    config.MINING_TRANSPARENCY_PROGRAM_DATA_SHA256];
  if (pins.every(value => value === undefined)) return null;
  const identity = selectPhaseEKeepRuntimeIdentity(config, phaseE, { programId: config.MINING_TRANSPARENCY_PROGRAM_ID,
    slot: config.MINING_TRANSPARENCY_DEPLOYMENT_SLOT, sha256: config.MINING_TRANSPARENCY_PROGRAM_DATA_SHA256 });
  if (!config.MINING_TRANSPARENCY_PROGRAM_ID || config.MINING_TRANSPARENCY_DEPLOYMENT_SLOT === undefined
      || !config.MINING_TRANSPARENCY_PROGRAM_DATA_SHA256 || (!identity && !config.GEMS_RESERVE_OWNER)
      || !config.HOT_WALLET_PUBKEY || economy.cluster !== config.SOLANA_CLUSTER) {
    throw new Error('Mining transparency requires complete admitted deployment and reserve identity');
  }
  const expectedGenesisHash = identity?.genesisHash ?? SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER];
  const rpcUrl = config.SOLANA_RPC_URL;
  const lifetime = new AbortController();
  const read = createMiningTransparencyReader(db, {
    economy, ...(identity ? { phaseE: identity } : {}), expectedGenesisHash, hotWallet: config.HOT_WALLET_PUBKEY,
    trust: {
      programId: new PublicKey(config.MINING_TRANSPARENCY_PROGRAM_ID),
      keepMint: new PublicKey(identity?.keepMint ?? economy.keepMint),
      reserveOwner: new PublicKey(identity?.reserveOwner ?? config.GEMS_RESERVE_OWNER!),
      expectedGenesisHash,
      reviewedDeploymentSlot: config.MINING_TRANSPARENCY_DEPLOYMENT_SLOT,
      reviewedProgramDataSha256: config.MINING_TRANSPARENCY_PROGRAM_DATA_SHA256,
    },
    source: (signal) => {
      lifetime.signal.throwIfAborted();
      // No subscription/socket or default public endpoint; each HTTP request is
      // bounded by the cached reader deadline and the application lifetime.
      const connection = new Connection(rpcUrl, {
        commitment: 'finalized', disableRetryOnRateLimit: true,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.any([signal, lifetime.signal]) }),
      });
      return {
        getGenesisHash: () => connection.getGenesisHash(),
        getSlot: (commitment) => connection.getSlot(commitment),
        getMultipleAccountsInfoAndContext: async (addresses, options) => {
          const result = await connection.getMultipleAccountsInfoAndContext(addresses, options);
          return { context: result.context, value: result.value.map((row, i) => row && {
            address: addresses[i]!, owner: row.owner, executable: row.executable, data: row.data,
          }) };
        },
      };
    },
  });
  return { read, close: () => lifetime.abort() };
}

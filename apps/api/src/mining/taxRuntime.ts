/** Process-owned historical tax sources; no signer, DB or terminal writer. */
import { keepAta, SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { seekerAuctionConfigPda } from '@shardkeep/chain/seeker-auction-protocol';
import { createMiningTaxQuoteReader } from '@shardkeep/chain/mining-tax-quote';
import type { MiningTaxSnapshotTrust } from '@shardkeep/chain/mining-tax-snapshot';
import type { MiningTaxReceiptReaderRpc } from '@shardkeep/chain/mining-tax-receipt-reader';
import type { MiningTaxFailureRpc } from '@shardkeep/chain/mining-tax-failure';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config';
import type { EconomyChainBinding } from '../money/economyIdentity';
import { assertNoObsoletePhaseEKeepConfiguration, selectPhaseEKeepRuntimeIdentity, type PhaseEKeepIdentity, type PhaseEKeepSelection } from '../money/phaseEKeepIdentity';
import type { MiningTaxClaimPreparationSources } from './taxClaimPreparation';
import type { MiningTaxClaimRelaySources } from './taxClaimReconcile';

// Operational transport limits, not reward or tax policy.
const TIMEOUT_MS = 30_000, MAX_RPC_BYTES = 32 * 1024 * 1024;
export function createMiningTaxRuntime(config: Config & PhaseEKeepSelection, economy: EconomyChainBinding, phaseE?: PhaseEKeepIdentity) {
  assertNoObsoletePhaseEKeepConfiguration(config);
  const pins = [config.MINING_TAX_PROGRAM_ID, config.MINING_TAX_DEPLOYMENT_SLOT, config.MINING_TAX_PROGRAM_DATA_SHA256,
    config.MINING_TAX_UPGRADE_AUTHORITY, config.MINING_TAX_AUCTION_MINT, config.MINING_TAX_PRIZE_OWNER, config.MINING_TAX_STATE_PROVENANCE];
  if (pins.every(value => value === undefined)) return null;
  const identity = selectPhaseEKeepRuntimeIdentity(config, phaseE, { programId: config.MINING_TAX_PROGRAM_ID,
    slot: config.MINING_TAX_DEPLOYMENT_SLOT, sha256: config.MINING_TAX_PROGRAM_DATA_SHA256,
    upgradeAuthority: config.MINING_TAX_UPGRADE_AUTHORITY === 'none' ? null : config.MINING_TAX_UPGRADE_AUTHORITY });
  if (pins.some(value => value === undefined) || (!identity && !config.GEMS_RESERVE_OWNER) || !config.HOT_WALLET_PUBKEY
      || economy.cluster !== config.SOLANA_CLUSTER || !Number.isSafeInteger(config.MINING_TAX_DEPLOYMENT_SLOT)
      || config.MINING_TAX_DEPLOYMENT_SLOT! < 0 || !/^[0-9a-f]{64}$/.test(config.MINING_TAX_PROGRAM_DATA_SHA256!)
      || config.MINING_TAX_STATE_PROVENANCE !== 'fresh-reviewed-deployment') throw Error('Mining tax requires complete reviewed deployment, auction and reserve identity');
  const key = (value: string) => {
    const result = new PublicKey(value);
    if (result.equals(PublicKey.default) || result.toBase58() !== value) throw Error('Invalid mining tax identity');
    return result;
  };
  const programId = key(config.MINING_TAX_PROGRAM_ID!), mint = key(config.MINING_TAX_AUCTION_MINT!),
    prizeOwner = key(config.MINING_TAX_PRIZE_OWNER!), genesisHash = identity?.genesisHash ?? SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER],
    upgradeAuthority = config.MINING_TAX_UPGRADE_AUTHORITY === 'none' ? null : key(config.MINING_TAX_UPGRADE_AUTHORITY!).toBase58();
  const trust: MiningTaxSnapshotTrust = Object.freeze({
    mining: Object.freeze({ programId, keepMint: key(identity?.keepMint ?? economy.keepMint), reserveOwner: key(identity?.reserveOwner ?? config.GEMS_RESERVE_OWNER!),
      expectedGenesisHash: genesisHash, reviewedDeploymentSlot: config.MINING_TAX_DEPLOYMENT_SLOT!,
      reviewedProgramDataSha256: config.MINING_TAX_PROGRAM_DATA_SHA256! }),
    seeker: Object.freeze({ programId, config: seekerAuctionConfigPda(programId), mint, prizeOwner, prizeAta: keepAta(prizeOwner, mint, true),
      genesisHash: new PublicKey(genesisHash), stateProvenance: 'fresh-reviewed-deployment' as const,
      deployment: Object.freeze({ programDataAddress: PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58(),
        programDataSha256: config.MINING_TAX_PROGRAM_DATA_SHA256!, upgradeAuthority }) }),
  });
  createMiningTaxQuoteReader(() => { throw Error('No RPC during trust validation'); }, trust);
  const endpoint = new URL(config.SOLANA_RPC_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.hash) throw Error('Invalid mining tax RPC URL');
  const url = endpoint.toString(), lifetime = new AbortController();
  const connect = (signal: AbortSignal) => {
    const active = AbortSignal.any([signal, lifetime.signal]); active.throwIfAborted();
    return new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: async (input, init) => {
      const deadline = AbortSignal.any([active, AbortSignal.timeout(TIMEOUT_MS)]); deadline.throwIfAborted();
      const response = await fetch(input, { ...init, signal: deadline, redirect: 'error' });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error('Mining tax RPC unavailable'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > MAX_RPC_BYTES) throw Error('Mining tax RPC exceeds work bound'); chunks.push(next.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      deadline.throwIfAborted(); const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(Buffer.concat(chunks), { status: response.status, headers });
    } });
  };
  const preparationSources = Object.freeze<MiningTaxClaimPreparationSources>({ connect, trust });
  const relaySources = Object.freeze<MiningTaxClaimRelaySources>({ admission: preparationSources, transport: signal => {
    const rpc = connect(signal);
    return { getGenesisHash: () => rpc.getGenesisHash(), getSignatureStatuses: (signatures, options) => rpc.getSignatureStatuses([...signatures], options),
      getBlockHeight: options => rpc.getBlockHeight(options), sendRawTransaction: (bytes, options) => rpc.sendRawTransaction(bytes, options) };
  } });
  // Terminal readers have no send method and never enter public AppDeps.
  const receiptSource = (signal: AbortSignal): MiningTaxReceiptReaderRpc => {
    const rpc = connect(signal);
    return { getGenesisHash: () => rpc.getGenesisHash(), getSlot: commitment => rpc.getSlot(commitment),
      getMultipleAccountsInfoAndContext: (addresses, options) => rpc.getMultipleAccountsInfoAndContext(addresses, options),
      getSignaturesForAddress: (address, options, commitment) => rpc.getSignaturesForAddress(address, options, commitment),
      getTransaction: (signature, options) => rpc.getTransaction(signature, options), getBlock: rpc.getBlock.bind(rpc) };
  };
  const failureSource = (signal: AbortSignal): MiningTaxFailureRpc => {
    const rpc = connect(signal);
    return { getGenesisHash: () => rpc.getGenesisHash(), getSlot: commitment => rpc.getSlot(commitment),
      getTransaction: (signature, options) => rpc.getTransaction(signature, options),
      getMultipleAccountsInfoAndContext: async (addresses, options) => {
        const bank = await rpc.getMultipleAccountsInfoAndContext(addresses, options);
        return { context: bank.context, value: bank.value.map((row, index) => row && {
          address: addresses[index]!, owner: row.owner, executable: row.executable, data: row.data,
        }) };
      } };
  };
  return Object.freeze({ preparationSources, relaySources, receiptSource, failureSource, trust, close: () => lifetime.abort() });
}

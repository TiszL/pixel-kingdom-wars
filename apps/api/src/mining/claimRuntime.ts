import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
/** Process-owned quote/relay sources. No signer, private DB or terminal writer. */
import { createMiningClaimSnapshotReader } from '@shardkeep/chain/mining-claim-snapshot';
import type { MiningClaimReceiptReader } from '@shardkeep/chain/mining-claim-receipt';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config';
import type { EconomyChainBinding } from '../money/economyIdentity';
import { assertNoObsoletePhaseEKeepConfiguration, selectPhaseEKeepRuntimeIdentity, type PhaseEKeepIdentity, type PhaseEKeepSelection } from '../money/phaseEKeepIdentity';
import type { MiningClaimsProvider } from './claimRoutes';

// Transport bounds, not game policy. A service deadline also aborts response bodies.
const TIMEOUT_MS = 30_000, MAX_RPC_BYTES = 32 * 1024 * 1024;
export function createMiningClaimRuntime(config: Config & PhaseEKeepSelection, economy: EconomyChainBinding, phaseE?: PhaseEKeepIdentity) {
  assertNoObsoletePhaseEKeepConfiguration(config);
  const pins = [config.MINING_CLAIM_PROGRAM_ID, config.MINING_CLAIM_DEPLOYMENT_SLOT,
    config.MINING_CLAIM_PROGRAM_DATA_SHA256];
  const orderedPins=[config.MINING_CLAIM_LOOKUP_TABLE,config.MINING_CLAIM_LOOKUP_TABLE_SHA256];
  if((config.MINING_CLAIM_ORDERED_ENABLED==='true'||orderedPins.some(v=>v!==undefined))&&(orderedPins.some(v=>v===undefined)||pins.some(v=>v===undefined)))throw new Error('Ordered mining claims require complete independent pins');
  if (pins.every(value => value === undefined)) return null;
  const identity = selectPhaseEKeepRuntimeIdentity(config, phaseE, { programId: config.MINING_CLAIM_PROGRAM_ID,
    slot: config.MINING_CLAIM_DEPLOYMENT_SLOT, sha256: config.MINING_CLAIM_PROGRAM_DATA_SHA256 });
  if (pins.some(value => value === undefined) || (!identity && !config.GEMS_RESERVE_OWNER)
      || !config.HOT_WALLET_PUBKEY || economy.cluster !== config.SOLANA_CLUSTER
      || !Number.isSafeInteger(config.MINING_CLAIM_DEPLOYMENT_SLOT) || config.MINING_CLAIM_DEPLOYMENT_SLOT! < 0
      || !/^[0-9a-f]{64}$/.test(config.MINING_CLAIM_PROGRAM_DATA_SHA256!)) {
    throw new Error('Mining claims require complete reviewed deployment and reserve identity');
  }
  const key = (value: string) => {
    const result = new PublicKey(value);
    if (result.equals(PublicKey.default) || result.toBase58() !== value) throw new Error('Invalid mining claim identity');
    return result;
  };
  const ordered=config.MINING_CLAIM_ORDERED_ENABLED==='true'?Object.freeze({address:key(config.MINING_CLAIM_LOOKUP_TABLE!).toBase58(),dataSha256:config.MINING_CLAIM_LOOKUP_TABLE_SHA256!}):undefined;
  if(ordered&&!/^[0-9a-f]{64}$/.test(ordered.dataSha256))throw new Error('Invalid ordered mining lookup pin');
  const trust = Object.freeze({
    programId: key(config.MINING_CLAIM_PROGRAM_ID!), keepMint: key(identity?.keepMint ?? economy.keepMint),
    reserveOwner: key(identity?.reserveOwner ?? config.GEMS_RESERVE_OWNER!), expectedGenesisHash: identity?.genesisHash ?? SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER],
    reviewedDeploymentSlot: config.MINING_CLAIM_DEPLOYMENT_SLOT!,
    reviewedProgramDataSha256: config.MINING_CLAIM_PROGRAM_DATA_SHA256!,
  });
  const rpcUrl = new URL(config.SOLANA_RPC_URL);
  if (!['http:', 'https:'].includes(rpcUrl.protocol)) throw new Error('Invalid mining claim RPC URL');
  const endpoint = rpcUrl.toString(), lifetime = new AbortController();
  const connection = (signal?: AbortSignal) => {
    lifetime.signal.throwIfAborted(); signal?.throwIfAborted();
    return new Connection(endpoint, { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: async (input, init) => {
        const aborted = AbortSignal.any([lifetime.signal, AbortSignal.timeout(TIMEOUT_MS), ...(signal ? [signal] : [])]);
        aborted.throwIfAborted();
        const response = await fetch(input, { ...init, signal: aborted, redirect: 'error' });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {}); throw new Error('Mining claim RPC unavailable');
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RPC_BYTES) throw new Error('Mining claim RPC response exceeds work bound');
            chunks.push(next.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        aborted.throwIfAborted();
        return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
      },
    });
  };
  // Reconciler wraps these methods in a bounded Proxy; its method properties must remain configurable.
  const snapshotReader = (rpc: Connection): MiningClaimsProvider['reader'] => ({
    getGenesisHash: () => rpc.getGenesisHash(),
    getSlot: (commitment) => rpc.getSlot(commitment),
    getMultipleAccountsInfoAndContext: async (addresses, options) => {
      const result = await rpc.getMultipleAccountsInfoAndContext(addresses, options);
      return { context: result.context, value: result.value.map((row, index) => row && {
        address: addresses[index]!, owner: row.owner, executable: row.executable, data: row.data, lamports: row.lamports,
      }) };
    },
  });
  const reader = snapshotReader(connection());
  createMiningClaimSnapshotReader(reader, trust); // Validate frozen trust without RPC.
  const provider = Object.freeze<MiningClaimsProvider>({ reader, trust,...(ordered?{ordered}:{}),
    quoteSource: (signal: AbortSignal) => {
      const rpc = connection(signal);
      return {getAccountInfoAndContext:(address,options)=>rpc.getAccountInfoAndContext(address,options), getGenesisHash: () => rpc.getGenesisHash(), getSlot: (commitment) => rpc.getSlot(commitment),
        getBlockHeight: (options) => rpc.getBlockHeight(options),
        getLatestBlockhashAndContext: (options) => rpc.getLatestBlockhashAndContext(options),
        getFeeForMessage: (message, commitment) => rpc.getFeeForMessage(message, commitment),
        getMinimumBalanceForRentExemption: (space, commitment) => rpc.getMinimumBalanceForRentExemption(space, commitment) };
    },
    transport: (signal: AbortSignal) => {
      const rpc = connection(signal);
      return { getGenesisHash: () => rpc.getGenesisHash(),
        getSignatureStatuses: (signatures, options) => rpc.getSignatureStatuses([...signatures], options),
        getBlockHeight: (options) => rpc.getBlockHeight(options),
        sendRawTransaction: (bytes, options) => rpc.sendRawTransaction(bytes, options) };
    },
  });
  // Separate read-only connector for a process-owned verifier. Never enters AppDeps.
  const receiptSource = (signal: AbortSignal): MiningClaimReceiptReader => {
    const rpc = connection(signal);
    return { ...snapshotReader(rpc), getTransaction: (signature, options) => rpc.getTransaction(signature, options) };
  };
  return Object.freeze({ provider, receiptSource, close: () => lifetime.abort() });
}

/** Private read-only publication connector. Independent of claim feature pins,
 * quote transports, signing and legacy Gems identity. No construction RPC. */
import { Connection, PublicKey } from '@solana/web3.js';
import type { MiningPublicationReader, MiningPublicationTrust } from '@shardkeep/chain/mining-publication';
import type { Config } from '../config';
import { requirePhaseEKeepRuntimeIdentity, type PhaseEKeepIdentity, type PhaseEKeepSelection } from '../money/phaseEKeepIdentity';
const TIMEOUT_MS = 30_000, MAX_RPC_BYTES = 32 * 1024 * 1024;
type Configuration = Config & PhaseEKeepSelection & {
  MINING_PUBLICATION_RECOVERY_ENABLED?: string; MINING_PUBLICATION_TESTER_STACK?: string;
};
export function createMiningPublicationReceiptRuntime(config: Configuration, selected?: PhaseEKeepIdentity) {
  if (config.MINING_PUBLICATION_RECOVERY_ENABLED !== 'true') return null;
  if (config.MINING_PUBLICATION_TESTER_STACK !== 'true' || config.SOLANA_CLUSTER !== 'devnet') {
    throw Error('Publication receipts require an explicit devnet tester stack');
  }
  const identity = requirePhaseEKeepRuntimeIdentity(config, selected, {
    programId: selected?.economyProgram, slot: selected?.economyDeployment.reviewedDeploymentSlot,
    sha256: selected?.economyDeployment.reviewedProgramDataSha256,
  });
  const trust: MiningPublicationTrust = Object.freeze({ programId: new PublicKey(identity.economyProgram),
    keepMint: new PublicKey(identity.keepMint), reserveOwner: new PublicKey(identity.reserveOwner),
    expectedGenesisHash: identity.genesisHash, reviewedDeploymentSlot: identity.economyDeployment.reviewedDeploymentSlot,
    reviewedProgramDataSha256: identity.economyDeployment.reviewedProgramDataSha256 });
  const endpoint = new URL(config.SOLANA_RPC_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol)) throw Error('Invalid publication RPC URL');
  const lifetime = new AbortController();
  const receiptSource = (signal: AbortSignal): MiningPublicationReader => {
    const active = () => { lifetime.signal.throwIfAborted(); signal.throwIfAborted(); };
    active();
    const rpc = new Connection(endpoint.toString(), { commitment: 'finalized', disableRetryOnRateLimit: true,
      fetch: async (input, init) => {
        const deadline = AbortSignal.any([lifetime.signal, signal, AbortSignal.timeout(TIMEOUT_MS)]);
        deadline.throwIfAborted();
        const response = await fetch(input, { ...init, signal: deadline, redirect: 'error' });
        if (!response.ok || !response.body) {
          await response.body?.cancel().catch(() => {}); throw Error('Publication RPC unavailable');
        }
        const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
        try {
          for (;;) {
            deadline.throwIfAborted(); const next = await reader.read(); if (next.done) break;
            size += next.value.byteLength;
            if (size > MAX_RPC_BYTES) throw Error('Publication RPC exceeds work bound');
            chunks.push(next.value);
          }
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
        deadline.throwIfAborted();
        return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
      },
    });
    async function read<T>(call: () => Promise<T>) { active(); const result = await call(); active(); return result; }
    const reader: MiningPublicationReader = {
      getGenesisHash: () => read(() => rpc.getGenesisHash()),
      getSlot: (commitment: 'finalized') => read(() => rpc.getSlot(commitment)),
      getTransaction: (signature, options) => read(() => rpc.getTransaction(signature, options)),
      getMultipleAccountsInfoAndContext: (addresses, options) => read(async () => {
        const result = await rpc.getMultipleAccountsInfoAndContext(addresses, options);
        return { context: result.context, value: result.value.map((row, index) => row && {
          address: addresses[index]!, owner: row.owner, executable: row.executable, data: row.data,
        }) };
      }),
    };
    return Object.freeze(reader);
  };
  return Object.freeze({ receiptSource, trust, close: () => lifetime.abort() });
}

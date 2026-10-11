/** Explicit reviewed original recovery only. No quote, issuer, signer or relay. */
import { Connection, PublicKey } from '@solana/web3.js';
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import type { CharterCreationEvidenceTrust, CharterCreationProgramTrust } from '@shardkeep/chain/charter-creation-evidence';
import type { CharterTransferRpc } from '@shardkeep/chain/charter-transfer-evidence';
import type { Config } from '../config';

const CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
// Three reviewed ProgramData accounts can each be 8 MiB before base64 encoding.
// Operational transport limits, independent of game values.
const MAX_BYTES = 36 * 1024 * 1024, TIMEOUT_MS = 30_000;
export type CharterRecoverySource = Readonly<{ trust: CharterCreationEvidenceTrust; connect: (signal: AbortSignal) => CharterTransferRpc }>;
export function createCharterRecoveryRuntime(config: Config) {
  const families = ['ECONOMY', 'CRAFT', 'CORE'] as const;
  const values = families.flatMap(family => [
    ...(family === 'CORE' ? [] : [config[`CHARTER_RECOVERY_${family}_PROGRAM_ID`]]),
    config[`CHARTER_RECOVERY_${family}_DEPLOYMENT_SLOT`], config[`CHARTER_RECOVERY_${family}_PROGRAM_DATA_SHA256`],
    config[`CHARTER_RECOVERY_${family}_UPGRADE_AUTHORITY`],
  ]).concat(config.CHARTER_RECOVERY_STATE_PROVENANCE);
  if (values.every(value => value === undefined)) return null;
  if (values.some(value => value === undefined) || config.CHARTER_RECOVERY_STATE_PROVENANCE !== 'fresh-reviewed-deployment') {
    throw Error('Charter recovery requires complete reviewed trust');
  }
  const address = (value: string) => {
    const key = new PublicKey(value);
    if (key.equals(PublicKey.default) || key.toBase58() !== value) throw Error('Invalid Charter recovery address');
    return key.toBase58();
  };
  const program = (family: typeof families[number]): CharterCreationProgramTrust => {
    const slot = config[`CHARTER_RECOVERY_${family}_DEPLOYMENT_SLOT`]!, hash = config[`CHARTER_RECOVERY_${family}_PROGRAM_DATA_SHA256`]!;
    if (!Number.isSafeInteger(slot) || slot < 0 || !/^[0-9a-f]{64}$/.test(hash)) throw Error('Invalid Charter recovery deployment');
    const authority = config[`CHARTER_RECOVERY_${family}_UPGRADE_AUTHORITY`]!;
    return Object.freeze({ programId: family === 'CORE' ? CORE : address(config[`CHARTER_RECOVERY_${family}_PROGRAM_ID`]!),
      reviewedDeploymentSlot: slot, reviewedProgramDataSha256: hash, upgradeAuthority: authority === 'none' ? null : address(authority) });
  };
  const trust: CharterCreationEvidenceTrust = Object.freeze({ expectedGenesisHash: SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER],
    economy: program('ECONOMY'), craft: program('CRAFT'), core: program('CORE'), stateProvenance: 'fresh-reviewed-deployment' });
  if (new Set([trust.economy.programId, trust.craft.programId, trust.core.programId]).size !== 3) throw Error('Charter programs must be distinct');
  const endpoint = new URL(config.SOLANA_RPC_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.hash) throw Error('Invalid Charter recovery RPC URL');
  const url = endpoint.toString(), lifetime = new AbortController();
  const connect = (caller: AbortSignal): CharterTransferRpc => {
    const signal = AbortSignal.any([caller, lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    signal.throwIfAborted();
    const rpc = new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: async (input, init) => {
      signal.throwIfAborted();
      const response = await fetch(input, { ...init, signal, redirect: 'error' });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error('Charter recovery RPC unavailable'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > MAX_BYTES) throw Error('Charter recovery response exceeds work bound'); chunks.push(next.value); }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      signal.throwIfAborted(); const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(Buffer.concat(chunks), { status: response.status, headers });
    } });
    const read = async <T>(operation: () => Promise<T>): Promise<T> => {
      signal.throwIfAborted(); const result = await operation(); signal.throwIfAborted(); return result;
    };
    return Object.freeze({
      getGenesisHash: () => read(() => rpc.getGenesisHash()),
      getSlot: (commitment: 'finalized') => read(() => rpc.getSlot(commitment)),
      getMultipleAccountsInfoAndContext: (addresses: PublicKey[], options: { commitment: 'finalized'; minContextSlot: number }) => {
        const keys = addresses.map(key => new PublicKey(key.toBytes())), settings = { ...options };
        return read(async () => { const result = await rpc.getMultipleAccountsInfoAndContext(keys, settings);
          return { context: result.context, value: result.value.map((row, i) => row ? { address: keys[i]!, owner: row.owner, executable: row.executable, data: row.data } : null) }; });
      },
      getTransaction: (signature: string, options: { commitment: 'finalized'; maxSupportedTransactionVersion: 0 }) =>
        read(() => rpc.getTransaction(signature, { ...options })),
    });
  };
  const source: CharterRecoverySource = Object.freeze({ trust, connect });
  return Object.freeze({ source, close: () => lifetime.abort() });
}

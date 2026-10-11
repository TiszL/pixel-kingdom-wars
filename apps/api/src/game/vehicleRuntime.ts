/** Explicit Core runtime sources for the existing owner-scoped vehicle services.
 * Registry admission remains independent; these pins never prove acquired minting. */
import { SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { makeVehicleBurnFinalityRpc, type VehicleBurnCoreTrust } from '@shardkeep/chain/vehicle-burn-finality';
import { vehicleClientCurrentRpcConnection } from '@shardkeep/chain/vehicle-client-current';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config';
import type { VehicleWorkflowDependencies } from './vehicleWorkflow';
import type { VehicleClientDependencies } from './vehicleClient';

export interface VehicleRuntimeSources {
  workflow: { connect: NonNullable<VehicleWorkflowDependencies['connect']>; trust: VehicleBurnCoreTrust;
    getBlockhash: NonNullable<VehicleWorkflowDependencies['getBlockhash']> };
  current: NonNullable<VehicleClientDependencies['current']>;
}
// Operational transport bounds; no gameplay rule changes.
const TIMEOUT_MS = 30_000, MAX_BLOCKHASH_BYTES = 1024 * 1024;
export function createVehicleRuntime(config: Config) {
  const pins = [config.VEHICLE_CORE_DEPLOYMENT_SLOT, config.VEHICLE_CORE_PROGRAM_DATA_SHA256, config.VEHICLE_CORE_UPGRADE_AUTHORITY];
  if (pins.every(value => value === undefined)) return null;
  if (pins.some(value => value === undefined) || !Number.isSafeInteger(config.VEHICLE_CORE_DEPLOYMENT_SLOT)
      || config.VEHICLE_CORE_DEPLOYMENT_SLOT! < 0 || !/^[0-9a-f]{64}$/.test(config.VEHICLE_CORE_PROGRAM_DATA_SHA256!)) {
    throw Error('Vehicle sources require complete reviewed Core deployment pins');
  }
  let authority: string | null = null;
  if (config.VEHICLE_CORE_UPGRADE_AUTHORITY !== 'none') {
    const key = new PublicKey(config.VEHICLE_CORE_UPGRADE_AUTHORITY!);
    if (key.equals(PublicKey.default) || key.toBase58() !== config.VEHICLE_CORE_UPGRADE_AUTHORITY) throw Error('Invalid Core upgrade authority');
    authority = key.toBase58();
  }
  const trust: VehicleBurnCoreTrust = Object.freeze({ expectedGenesisHash: SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER],
    reviewedDeploymentSlot: config.VEHICLE_CORE_DEPLOYMENT_SLOT!, reviewedProgramDataSha256: config.VEHICLE_CORE_PROGRAM_DATA_SHA256!, upgradeAuthority: authority });
  const endpoint = new URL(config.SOLANA_RPC_URL);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.hash) throw Error('Invalid vehicle RPC URL');
  const url = endpoint.toString(), lifetime = new AbortController(), current = vehicleClientCurrentRpcConnection(url);
  const active = (signal: AbortSignal) => {
    const combined = AbortSignal.any([signal, lifetime.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    combined.throwIfAborted(); return combined;
  };
  const checked = <T extends object>(rpc: T, signal: AbortSignal): T => new Proxy(rpc, { get(target, name, receiver) {
    const value = Reflect.get(target, name, receiver); if (typeof value !== 'function') return value;
    return async (...args: unknown[]) => { signal.throwIfAborted(); const result = await value.apply(target, args); signal.throwIfAborted(); return result; };
  } });
  const getBlockhash = async () => {
    const signal = active(new AbortController().signal);
    const rpc = new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: async (input, init) => {
      signal.throwIfAborted(); const response = await fetch(input, { ...init, signal, redirect: 'error' });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error('Vehicle blockhash unavailable'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > MAX_BLOCKHASH_BYTES) throw Error('Vehicle blockhash exceeds work bound'); chunks.push(next.value); }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      signal.throwIfAborted(); const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(Buffer.concat(chunks), { status: response.status, headers });
    } });
    const result = await rpc.getLatestBlockhashAndContext('finalized'); signal.throwIfAborted();
    return { ...result.value, contextSlot: result.context.slot };
  };
  const sources: VehicleRuntimeSources = Object.freeze({
    workflow: Object.freeze({ connect: (signal: AbortSignal) => { const bound = active(signal); return checked(makeVehicleBurnFinalityRpc(url, bound), bound); }, trust, getBlockhash }),
    current: Object.freeze({ connect: (signal: AbortSignal) => { const bound = active(signal); return checked(current(bound), bound); }, trust }),
  });
  return Object.freeze({ sources, close: () => lifetime.abort() });
}

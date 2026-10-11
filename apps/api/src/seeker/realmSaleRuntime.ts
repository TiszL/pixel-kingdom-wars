/** Reviewed process-owned quote and same-wire relay sources; no signer or terminal owner. */
import { keepAta, SOLANA_GENESIS_HASH } from '@shardkeep/chain';
import { seekerAuctionConfigPda } from '@shardkeep/chain/seeker-auction-protocol';
import { createSeekerRealmSaleQuoteReader, type SeekerRealmSaleQuotePolicy } from '@shardkeep/chain/seeker-realm-sale-quote';
import type { SeekerRealmSaleFinalityRpc } from '@shardkeep/chain/seeker-realm-sale-finality';
import type { SeekerRealmAccessRpc } from '@shardkeep/chain/seeker-realm-access-snapshot';
import type { SeekerTermRpc } from '@shardkeep/chain/seeker-terms';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Config } from '../config';
import type { RealmSalePreparationSources } from './realmSalePreparation';
import type { RealmSaleRelaySources } from './realmSaleReconcile';

// Transport bounds, not auction/price/term policy.
const TIMEOUT_MS = 30_000, MAX_RPC_BYTES = 32 * 1024 * 1024;
export function createRealmSaleRuntime(config: Config) {
  const values = [config.SEEKER_REALM_SALE_PROGRAM_ID, config.SEEKER_REALM_SALE_DEPLOYMENT_SLOT,
    config.SEEKER_REALM_SALE_PROGRAM_DATA_SHA256, config.SEEKER_REALM_SALE_UPGRADE_AUTHORITY,
    config.SEEKER_REALM_SALE_AUCTION_MINT, config.SEEKER_REALM_SALE_PRIZE_OWNER,
    config.SEEKER_REALM_SALE_DEVELOPER, config.SEEKER_REALM_SALE_ROUND,
    config.SEEKER_REALM_SALE_POLICY_REVISION, config.SEEKER_REALM_SALE_STATE_PROVENANCE];
  if (values.every(value => value === undefined)) return null;
  if (values.some(value => value === undefined)
      || !Number.isSafeInteger(config.SEEKER_REALM_SALE_DEPLOYMENT_SLOT) || config.SEEKER_REALM_SALE_DEPLOYMENT_SLOT! < 0
      || !/^[0-9a-f]{64}$/.test(config.SEEKER_REALM_SALE_PROGRAM_DATA_SHA256!)
      || !/^(0|[1-9][0-9]{0,19})$/.test(config.SEEKER_REALM_SALE_ROUND!)
      || BigInt(config.SEEKER_REALM_SALE_ROUND!) >= 1n << 64n
      || !/^[A-Za-z0-9_.:-]{1,128}$/.test(config.SEEKER_REALM_SALE_POLICY_REVISION!)
      || config.SEEKER_REALM_SALE_STATE_PROVENANCE !== 'fresh-reviewed-deployment') {
    throw Error('Realm sales require the complete reviewed operator policy');
  }
  const key = (value: string) => {
    const result = new PublicKey(value);
    if (result.equals(PublicKey.default) || result.toBase58() !== value) throw Error('Invalid realm sale identity');
    return result;
  };
  const programId = key(config.SEEKER_REALM_SALE_PROGRAM_ID!), mint = key(config.SEEKER_REALM_SALE_AUCTION_MINT!),
    prizeOwner = key(config.SEEKER_REALM_SALE_PRIZE_OWNER!), developer = key(config.SEEKER_REALM_SALE_DEVELOPER!),
    upgradeAuthority = config.SEEKER_REALM_SALE_UPGRADE_AUTHORITY === 'none' ? null : key(config.SEEKER_REALM_SALE_UPGRADE_AUTHORITY!),
    expectedGenesisHash = SOLANA_GENESIS_HASH[config.SOLANA_CLUSTER];
  const policy: SeekerRealmSaleQuotePolicy = Object.freeze({
    revision: config.SEEKER_REALM_SALE_POLICY_REVISION!,
    term: Object.freeze({ programId, config: seekerAuctionConfigPda(programId), round: BigInt(config.SEEKER_REALM_SALE_ROUND!),
      mint, prizeOwner, prizeAta: keepAta(prizeOwner, mint, true), genesisHash: new PublicKey(expectedGenesisHash),
      stateProvenance: 'fresh-reviewed-deployment' as const,
      deployment: Object.freeze({ programDataAddress: PublicKey.findProgramAddressSync([programId.toBuffer()], new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'))[0].toBase58(),
        programDataSha256: config.SEEKER_REALM_SALE_PROGRAM_DATA_SHA256!, upgradeAuthority: upgradeAuthority?.toBase58() ?? null }) }),
    access: Object.freeze({ programId, developer, expectedGenesisHash, reviewedDeploymentSlot: config.SEEKER_REALM_SALE_DEPLOYMENT_SLOT!,
      reviewedProgramDataSha256: config.SEEKER_REALM_SALE_PROGRAM_DATA_SHA256!, upgradeAuthority,
      stateProvenance: 'fresh-reviewed-deployment' as const }),
  });
  createSeekerRealmSaleQuoteReader(() => { throw Error('No RPC during policy validation'); }, policy);
  const endpoint = new URL(config.SOLANA_RPC_URL);
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.hash) throw Error('Invalid realm sale RPC URL');
  const url = endpoint.toString(), lifetime = new AbortController();
  const connect = (signal: AbortSignal) => {
    const active = AbortSignal.any([signal, lifetime.signal]); active.throwIfAborted();
    return new Connection(url, { commitment: 'finalized', disableRetryOnRateLimit: true, fetch: async (input, init) => {
      const deadline = AbortSignal.any([active, AbortSignal.timeout(TIMEOUT_MS)]); deadline.throwIfAborted();
      const response = await fetch(input, { ...init, signal: deadline, redirect: 'error' });
      if (!response.ok || !response.body) { await response.body?.cancel().catch(() => {}); throw Error('Realm sale RPC unavailable'); }
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const next = await reader.read(); if (next.done) break;
          size += next.value.byteLength; if (size > MAX_RPC_BYTES) throw Error('Realm sale RPC exceeds work bound'); chunks.push(next.value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      deadline.throwIfAborted(); const headers = new Headers(response.headers); headers.delete('content-length'); headers.delete('content-encoding');
      return new Response(Buffer.concat(chunks), { status: response.status, headers });
    } });
  };
  const preparationSources = Object.freeze<RealmSalePreparationSources>({ connect, policy });
  const relaySources = Object.freeze<RealmSaleRelaySources>({ admission: preparationSources,
    transport: signal => {
      const rpc = connect(signal);
      // Configurable method properties allow the existing bounded Proxy wrapper.
      return { getGenesisHash: () => rpc.getGenesisHash(), getSignatureStatuses: (signatures, options) => rpc.getSignatureStatuses([...signatures], options),
        getBlockHeight: options => rpc.getBlockHeight(options), sendRawTransaction: (bytes, options) => rpc.sendRawTransaction(bytes, options) };
    },
  });
  // Separate read-only connector for the process-owned verifier, outside AppDeps.
  const receiptSource = (signal: AbortSignal): SeekerRealmSaleFinalityRpc => {
    const rpc = connect(signal);
    return { getGenesisHash: () => rpc.getGenesisHash(), getSlot: commitment => rpc.getSlot(commitment),
      getTransaction: (signature, options) => rpc.getTransaction(signature, options),
      getMultipleAccountsInfoAndContext: async (addresses, options) => {
        const response = await rpc.getMultipleAccountsInfoAndContext(addresses, options);
        return { context: response.context, value: response.value.map((row, index) => row && {
          address: addresses[index]!, owner: row.owner, executable: row.executable, data: row.data,
        }) };
      } };
  };
  // Gameplay shares the reviewed Seeker identity, never the sale quote's selected
  // round. Its own admission flags remain independent of sales. Actual returned
  // RPC objects expose only reads; no Connection/send method escapes this seam.
  const { round: _saleRound, ...sourcePolicy } = policy.term;
  const termSources = Object.freeze({ policy: Object.freeze(sourcePolicy), connect: (signal: AbortSignal): SeekerTermRpc => {
    const rpc=connect(signal);
    return { getGenesisHash:()=>rpc.getGenesisHash(),
      getMultipleAccountsInfoAndContext:(addresses,options)=>rpc.getMultipleAccountsInfoAndContext(addresses,options),
      getSignaturesForAddress:(address,options,commitment)=>rpc.getSignaturesForAddress(address,options,commitment),
      getTransaction:(signature,options)=>rpc.getTransaction(signature,options),getBlock:rpc.getBlock.bind(rpc) };
  } });
  const accessSources=Object.freeze({trust:policy.access,connect:(signal:AbortSignal):SeekerRealmAccessRpc=>{
    const rpc=receiptSource(signal);
    return {getGenesisHash:rpc.getGenesisHash,getSlot:rpc.getSlot,getMultipleAccountsInfoAndContext:rpc.getMultipleAccountsInfoAndContext};
  }});
  const gameplaySources=Object.freeze({term:termSources,access:accessSources});
  return Object.freeze({ preparationSources, relaySources, receiptSource, trust: policy.access, gameplaySources, close: () => lifetime.abort() });
}
export type SeekerGameplaySources=NonNullable<ReturnType<typeof createRealmSaleRuntime>>['gameplaySources'];

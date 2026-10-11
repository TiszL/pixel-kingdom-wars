/** Complete explicit current Charter authority; issuer-only and read-only
 * recovery remain independently available for retained originals. No keys/Db. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import type { Config } from '../config';
import { charterIssuerAuthToken, createCharterPolicyIssuerClient } from '../charterPolicyIssuerClient';
import type { CharterClientOptions } from './clanCharterClient';
import type { CharterTournamentsOptions } from './clanCharterTournaments';
import type { CharterMigrationWorkflowOptions } from './clanCharterMigrationWorkflow';
import type { CharterRetirementWorkflowOptions } from './clanCharterRetirementWorkflow';
import type { CharterRecoverySource } from './clanCharterRecoveryRuntime';
import { createCharterWorkflowRpc } from './charterWorkflowRpc';

async function tokenFile(file: string): Promise<string> {
  if (!path.isAbsolute(file) || file.includes('\0')) throw Error('Charter issuer token file unavailable');
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const buffer = Buffer.alloc(1025);
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.nlink !== 1 || before.size > 1024) throw Error();
    let bytes = 0;
    while (bytes < buffer.length) { const read = await handle.read(buffer, bytes, buffer.length - bytes, bytes); if (!read.bytesRead) break; bytes += read.bytesRead; }
    const after = await handle.stat();
    if (bytes !== before.size || bytes > 1024 || after.size !== before.size || after.ctimeMs !== before.ctimeMs || after.mtimeMs !== before.mtimeMs) throw Error();
    return charterIssuerAuthToken(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)).replace(/\r?\n$/, ''));
  } catch { throw Error('Charter issuer token file unavailable'); }
  finally { buffer.fill(0); await handle?.close(); }
}
export async function createConfiguredCharterWorkflowRuntime(config: Config, recovery?: CharterRecoverySource) {
  let issuer: ReturnType<typeof createCharterPolicyIssuerClient> | null = null;
  let rpc: ReturnType<typeof createCharterWorkflowRpc> | null = null;
  try {
    const issuerFields = [config.CHARTER_POLICY_ISSUER_URL, config.CHARTER_POLICY_ISSUER_PUBLIC_KEY, config.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE];
    if (issuerFields.some(v => v !== undefined) || config.CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP === 'true') {
      if (issuerFields.some(v => v === undefined)) throw Error('Incomplete Charter issuer client configuration');
      issuer = createCharterPolicyIssuerClient({ endpoint: config.CHARTER_POLICY_ISSUER_URL!, currentPublicKey: config.CHARTER_POLICY_ISSUER_PUBLIC_KEY!,
        authToken: await tokenFile(config.CHARTER_POLICY_ISSUER_AUTH_TOKEN_FILE!), allowPrivateHttp: config.CHARTER_POLICY_ISSUER_ALLOW_PRIVATE_HTTP === 'true' });
    }
    const capturedRecovery = recovery ? Object.freeze({ trust: structuredClone(recovery.trust), connect: recovery.connect.bind(recovery) }) : null;
    let client: CharterClientOptions = { creation: { issuer, recovery: capturedRecovery }, sales: { issuer, recovery: capturedRecovery } };
    let tournaments: CharterTournamentsOptions = { issuer, recovery: capturedRecovery };
    let retirement: CharterRetirementWorkflowOptions = { issuer, recovery: capturedRecovery };
    let migration: CharterMigrationWorkflowOptions = { issuer, recovery: capturedRecovery };
    const currentFields = [config.CHARTER_WORKFLOW_METADATA_URI_PREFIX, config.CHARTER_WORKFLOW_SALE_TREASURY,
      config.CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS, config.CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256, config.CHARTER_WORKFLOW_CORE_COST_PROFILE,
      config.CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS, config.CHARTER_WORKFLOW_MAX_RENT_LAMPORTS,
      config.CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS, config.CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS];
    if (currentFields.some(v => v !== undefined) || config.CHARTER_WORKFLOW_RELAY_RPC_URL) {
      if (currentFields.some(v => v === undefined) || !issuer || !capturedRecovery) throw Error('Incomplete current Charter configuration');
      const address = (value: string) => { const p = new PublicKey(value); if (p.equals(PublicKey.default) || p.toBase58() !== value) throw Error('Invalid Charter address'); return value; };
      const amount = (value: string) => { if (!/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) throw Error('Invalid Charter cost limit'); return BigInt(value); };
      const uri = new URL(config.CHARTER_WORKFLOW_METADATA_URI_PREFIX!);
      if (uri.protocol !== 'https:' || uri.username || uri.password || Buffer.byteLength(config.CHARTER_WORKFLOW_METADATA_URI_PREFIX!) > 256
          || config.CHARTER_WORKFLOW_CORE_COST_PROFILE !== 'mpl-core-0.15.2-charter-pfd-seq-none'
          || !/^[0-9a-f]{64}$/.test(config.CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256!)) throw Error('Invalid current Charter source');
      const trust = capturedRecovery.trust, expectedCurrentSigner = address(config.CHARTER_POLICY_ISSUER_PUBLIC_KEY!);
      const lookupTable = Object.freeze({ address: address(config.CHARTER_WORKFLOW_LOOKUP_TABLE_ADDRESS!), dataSha256: config.CHARTER_WORKFLOW_LOOKUP_TABLE_SHA256! });
      const domain = Object.freeze({ genesisHash: trust.expectedGenesisHash, economyProgram: trust.economy.programId, craftProgram: trust.craft.programId });
      const saleDomain = Object.freeze({ ...domain, treasury: address(config.CHARTER_WORKFLOW_SALE_TREASURY!) });
      const maxNetworkFeeLamports = amount(config.CHARTER_WORKFLOW_MAX_NETWORK_FEE_LAMPORTS!), maxRentLamports = amount(config.CHARTER_WORKFLOW_MAX_RENT_LAMPORTS!);
      const transferLimits = Object.freeze({ maxNetworkFeeLamports, maxRentLamports, maxAdditionalLamports: amount(config.CHARTER_WORKFLOW_MAX_ADDITIONAL_LAMPORTS!) });
      const creationLimits = Object.freeze({ maxNetworkFeeLamports, maxRentLamports, maxTotalLamports: amount(config.CHARTER_WORKFLOW_MAX_TOTAL_LAMPORTS!) });
      rpc = createCharterWorkflowRpc({ readRpcUrl: config.SOLANA_RPC_URL, nodeEnv: config.NODE_ENV,
        ...(config.CHARTER_WORKFLOW_RELAY_RPC_URL ? { relayRpcUrl: config.CHARTER_WORKFLOW_RELAY_RPC_URL } : {}) });
      const transport = rpc;
      const combinedRead = (signal: AbortSignal) => { const quote = transport.quoteConnect(signal), original = transport.recoveryConnect(signal);
        return Object.freeze({ ...quote, getTransaction: original.getTransaction }); };
      const pins = { trust, expectedCurrentSigner, lookupTable };
      const delivery = transport.deliveryConnect ? Object.freeze({ ...pins, connect: transport.deliveryConnect }) : null;
      client = { creation: { issuer, recovery: capturedRecovery, newCreation: { domain, metadataUriPrefix: config.CHARTER_WORKFLOW_METADATA_URI_PREFIX! },
        chain: { ...pins, connect: transport.quoteConnect, costLimits: creationLimits,
          coreCostProfile: { version: 1, profile: config.CHARTER_WORKFLOW_CORE_COST_PROFILE!, reviewedProgramDataSha256: trust.core.reviewedProgramDataSha256 } } },
        sales: { issuer, recovery: capturedRecovery, newSaleDomain: saleDomain, chain: { ...pins, connect: combinedRead, costLimits: transferLimits } }, delivery };
      tournaments = { issuer, recovery: capturedRecovery, chain: { ...pins, connect: combinedRead, costLimits: transferLimits }, delivery };
      retirement = { issuer, recovery: capturedRecovery, chain: { ...pins, connect: transport.quoteConnect, costLimits: transferLimits }, delivery };
      migration = { issuer, recovery: capturedRecovery, newMigration: { domain, metadataUriPrefix: config.CHARTER_WORKFLOW_METADATA_URI_PREFIX! }, chain: { ...pins, connect: transport.quoteConnect, costLimits: creationLimits, coreCostProfile: { version: 1, profile: config.CHARTER_WORKFLOW_CORE_COST_PROFILE!, reviewedProgramDataSha256: trust.core.reviewedProgramDataSha256 } }, delivery };
    }
    return Object.freeze({ client: Object.freeze(client), tournaments: Object.freeze(tournaments), retirement: Object.freeze(retirement), migration: Object.freeze(migration), close: () => { issuer?.close(); rpc?.close(); } });
  } catch (error) { issuer?.close(); rpc?.close(); throw error; }
}

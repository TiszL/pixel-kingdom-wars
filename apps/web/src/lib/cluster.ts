import devnetAddresses from '../../../../infra/devnet.addresses.json';
import { SEEKER } from '@shardkeep/shared';

/** The only economy clusters the game understands. Anything else is a build
 * configuration error, never permission to let wallet libraries guess. */
export type GameSolanaCluster = 'devnet' | 'mainnet-beta';
export type SolanaWalletChain = `solana:${GameSolanaCluster}`;
/** Public identity, independent of an RPC endpoint's claims. */
export function expectedSolanaGenesis(cluster: GameSolanaCluster): string {
  return cluster === 'devnet' ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG' : SEEKER.mainnetGenesisHash;
}

interface PublicWebEnv {
  VITE_SOLANA_CLUSTER?: string | undefined;
  VITE_SOLANA_RPC_URL?: string | undefined;
  VITE_CORE_PROGRAM_ID?: string | undefined;
  VITE_CORE_CONFIG_PDA?: string | undefined;
  VITE_TREASURY_LIQUIDITY?: string | undefined;
  VITE_TREASURY_DEV?: string | undefined;
  VITE_TREASURY_OPS?: string | undefined;
  VITE_KEEP_MINT?: string | undefined;
}

export interface WebChainAddresses {
  coreProgram: string;
  config: string;
  keepMint: string;
  treasuries: { liquidity: string; dev: string; ops: string };
}

export interface WebSolanaConfig {
  cluster: GameSolanaCluster;
  chain: SolanaWalletChain;
  rpcUrl: string;
  addresses: WebChainAddresses;
}

const DEVNET_RPC = 'https://api.devnet.solana.com';

function required(env: PublicWebEnv, key: keyof PublicWebEnv): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required when VITE_SOLANA_CLUSTER=mainnet-beta`);
  return value;
}

/** Resolve the complete public client configuration in one place. Mainnet has
 * no checked-in placeholder registry: every address must be supplied by the
 * reviewed release environment, or module startup fails before a wallet can
 * sign anything. Devnet keeps the existing checked-in registry and RPC default. */
export function resolveWebSolanaConfig(
  env: PublicWebEnv,
  options: { production?: boolean; origin?: string | undefined } = {},
): WebSolanaConfig {
  const rawCluster = env.VITE_SOLANA_CLUSTER?.trim() || 'devnet';
  if (rawCluster !== 'devnet' && rawCluster !== 'mainnet-beta') {
    throw new Error(`Unsupported VITE_SOLANA_CLUSTER=${rawCluster}`);
  }
  const cluster: GameSolanaCluster = rawCluster;
  const rawRpc = env.VITE_SOLANA_RPC_URL?.trim();
  if (options.production && !rawRpc) {
    throw new Error('VITE_SOLANA_RPC_URL must select the protected RPC relay in production');
  }
  if (cluster === 'mainnet-beta' && !rawRpc) {
    throw new Error('VITE_SOLANA_RPC_URL is required when VITE_SOLANA_CLUSTER=mainnet-beta');
  }
  const rpcUrl = rawRpc || DEVNET_RPC;
  let parsedRpc: URL;
  try { parsedRpc = new URL(rpcUrl); } catch {
    throw new Error('VITE_SOLANA_RPC_URL must be an absolute URL');
  }
  if (parsedRpc.protocol !== 'http:' && parsedRpc.protocol !== 'https:') {
    throw new Error('VITE_SOLANA_RPC_URL must use http or https');
  }
  if (cluster === 'mainnet-beta' && parsedRpc.protocol !== 'https:') {
    throw new Error('VITE_SOLANA_RPC_URL must use https for mainnet-beta');
  }
  if (parsedRpc.username || parsedRpc.password) {
    throw new Error('VITE_SOLANA_RPC_URL must not contain URL credentials');
  }
  if (options.production && (parsedRpc.protocol !== 'https:'
    || parsedRpc.origin !== options.origin
    || parsedRpc.pathname !== `/api/rpc/solana/${cluster}`
    || parsedRpc.search || parsedRpc.hash)) {
    throw new Error('VITE_SOLANA_RPC_URL must use the same-origin protected RPC relay for the selected cluster');
  }

  const addresses: WebChainAddresses = cluster === 'devnet'
    ? {
        coreProgram: devnetAddresses.coreProgram,
        config: devnetAddresses.config,
        keepMint: devnetAddresses.keepMint,
        treasuries: { ...devnetAddresses.treasuries },
      }
    : {
        coreProgram: required(env, 'VITE_CORE_PROGRAM_ID'),
        config: required(env, 'VITE_CORE_CONFIG_PDA'),
        keepMint: required(env, 'VITE_KEEP_MINT'),
        treasuries: {
          liquidity: required(env, 'VITE_TREASURY_LIQUIDITY'),
          dev: required(env, 'VITE_TREASURY_DEV'),
          ops: required(env, 'VITE_TREASURY_OPS'),
        },
      };

  return { cluster, chain: `solana:${cluster}`, rpcUrl, addresses };
}

export const SOLANA = resolveWebSolanaConfig({
  VITE_SOLANA_CLUSTER: import.meta.env.VITE_SOLANA_CLUSTER,
  VITE_SOLANA_RPC_URL: import.meta.env.VITE_SOLANA_RPC_URL,
  VITE_CORE_PROGRAM_ID: import.meta.env.VITE_CORE_PROGRAM_ID,
  VITE_CORE_CONFIG_PDA: import.meta.env.VITE_CORE_CONFIG_PDA,
  VITE_TREASURY_LIQUIDITY: import.meta.env.VITE_TREASURY_LIQUIDITY,
  VITE_TREASURY_DEV: import.meta.env.VITE_TREASURY_DEV,
  VITE_TREASURY_OPS: import.meta.env.VITE_TREASURY_OPS,
  VITE_KEEP_MINT: import.meta.env.VITE_KEEP_MINT,
}, {
  production: import.meta.env.PROD,
  origin: typeof window === 'undefined' ? undefined : window.location.origin,
});
export const SOLANA_CLUSTER = SOLANA.cluster;
export const SOLANA_CHAIN = SOLANA.chain;
export const SOLANA_RPC_URL = SOLANA.rpcUrl;
/** Explicit port preservation: web3's default derivation increments HTTP ports,
 * but the same-origin development proxy serves HTTP and WS on one port. */
export function rpcWebSocketUrl(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
export const SOLANA_WS_URL = rpcWebSocketUrl(SOLANA_RPC_URL);
export const KEEP_MINT = SOLANA.addresses.keepMint;

/** Solana Explorer omits the cluster query for mainnet-beta. Keeping this in
 * the same validated config prevents a mainnet transaction link from opening
 * the devnet explorer (or vice versa). */
export function explorerUrl(kind: 'tx' | 'address', value: string, cluster = SOLANA_CLUSTER): string {
  const suffix = cluster === 'devnet' ? '?cluster=devnet' : '';
  return `https://explorer.solana.com/${kind}/${encodeURIComponent(value)}${suffix}`;
}

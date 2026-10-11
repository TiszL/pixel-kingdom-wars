import type { GameSolanaCluster } from './bootstrap';

/** Stable public cluster identities returned by getGenesisHash. */
export const SOLANA_GENESIS_HASH: Readonly<Record<GameSolanaCluster, string>> = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
};

export class SolanaClusterRpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SolanaClusterRpcError';
  }
}

function providerHost(rpcUrl: string): string {
  return new URL(rpcUrl).hostname.toLowerCase();
}

/** Mainnet requires failure independence, not two URLs at the same provider. */
export function assertIndependentRpcProviders(rpcUrls: readonly string[]): void {
  if (rpcUrls.length < 2) throw new Error('two Solana RPC providers are required');
  const hosts = rpcUrls.map(providerHost);
  if (new Set(hosts).size !== hosts.length) {
    throw new Error('Solana RPC redundancy requires different provider hosts');
  }
}

/** Proves an endpoint serves the configured economy cluster before money paths
 * use it. Unreachable is distinguishable from a confirmed wrong genesis. */
export async function assertSolanaCluster(opts: {
  rpcUrl: string;
  cluster: GameSolanaCluster;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<void> {
  const doFetch = opts.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(opts.rpcUrl, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getGenesisHash', params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 5_000),
    });
  } catch {
    throw new SolanaClusterRpcError('Solana RPC is unreachable during cluster attestation');
  }
  if (!response.ok) {
    throw new SolanaClusterRpcError(
      `Solana RPC returned HTTP ${response.status} during cluster attestation`,
    );
  }
  let rawBody: unknown;
  try {
    rawBody = await response.json() as unknown;
  } catch {
    throw new SolanaClusterRpcError('Solana RPC returned malformed JSON during cluster attestation');
  }
  if (rawBody === null || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
    throw new SolanaClusterRpcError(
      'Solana RPC did not return a JSON-RPC object',
    );
  }
  const body = rawBody as { result?: string; error?: { message?: string } };
  if (body.error || typeof body.result !== 'string') {
    throw new SolanaClusterRpcError(
      'Solana RPC did not return a genesis hash',
    );
  }
  const expected = SOLANA_GENESIS_HASH[opts.cluster];
  if (body.result !== expected) {
    throw new Error(
      `Solana RPC serves a different genesis; expected ${opts.cluster}`,
    );
  }
}

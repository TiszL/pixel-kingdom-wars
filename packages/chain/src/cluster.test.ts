import { describe, expect, it, vi } from 'vitest';
import { SEEKER } from '@shardkeep/shared';
import {
  SOLANA_GENESIS_HASH, SolanaClusterRpcError, assertIndependentRpcProviders,
  assertSolanaCluster,
} from './cluster';

function rpc(result: string, status = 200): typeof fetch {
  return vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status, headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

describe('economy cluster attestation', () => {
  // Independently pinned from Anza SDK cluster-type/src/lib.rs and public mainnet
  // getGenesisHash (2026-09-21). A map-derived fixture masked the previous typo.
  it('admits the actual mainnet identity shared with Seeker and rejects the historical typo', async () => {
    const authoritative = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
    expect(SOLANA_GENESIS_HASH['mainnet-beta']).toBe(authoritative);
    expect(SEEKER.mainnetGenesisHash).toBe(authoritative);
    await expect(assertSolanaCluster({ rpcUrl: 'https://one.example', cluster: 'mainnet-beta',
      fetchImpl: rpc(authoritative) })).resolves.toBeUndefined();
    await expect(assertSolanaCluster({ rpcUrl: 'https://one.example', cluster: 'mainnet-beta',
      fetchImpl: rpc('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d52') })).rejects.toThrow('expected mainnet-beta');
  });

  it.each(['devnet', 'mainnet-beta'] as const)('accepts only the %s genesis', async (cluster) => {
    await expect(assertSolanaCluster({
      rpcUrl: 'https://one.example', cluster, fetchImpl: rpc(SOLANA_GENESIS_HASH[cluster]),
    })).resolves.toBeUndefined();
    const other = cluster === 'devnet' ? 'mainnet-beta' : 'devnet';
    await expect(assertSolanaCluster({
      rpcUrl: 'https://one.example', cluster, fetchImpl: rpc(SOLANA_GENESIS_HASH[other]),
    })).rejects.toThrow(`expected ${cluster}`);
  });

  it('distinguishes an unavailable endpoint from a confirmed wrong cluster', async () => {
    const unavailable = vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    await expect(assertSolanaCluster({
      rpcUrl: 'https://one.example', cluster: 'devnet', fetchImpl: unavailable,
    })).rejects.toBeInstanceOf(SolanaClusterRpcError);
  });

  it('treats a malformed JSON response as an RPC failure, not a cluster verdict', async () => {
    const malformed = vi.fn(async () => new Response('{not-json', {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    await expect(assertSolanaCluster({
      rpcUrl: 'https://one.example', cluster: 'devnet', fetchImpl: malformed,
    })).rejects.toBeInstanceOf(SolanaClusterRpcError);
    await expect(assertSolanaCluster({
      rpcUrl: 'https://one.example', cluster: 'devnet', fetchImpl: malformed,
    })).rejects.toThrow(/malformed JSON/);
    const nonObject = vi.fn(async () => new Response('null', {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    await expect(assertSolanaCluster({
      rpcUrl: 'https://one.example', cluster: 'devnet', fetchImpl: nonObject,
    })).rejects.toBeInstanceOf(SolanaClusterRpcError);
  });

  it('requires two different provider hosts', () => {
    expect(() => assertIndependentRpcProviders([
      'https://primary.example/rpc', 'https://backup.example/rpc',
    ])).not.toThrow();
    expect(() => assertIndependentRpcProviders([
      'https://same.example/one', 'https://same.example/two',
    ])).toThrow(/different provider hosts/);
    expect(() => assertIndependentRpcProviders(['https://only.example'])).toThrow(/two Solana RPC/);
  });
});


it('never includes endpoint credentials, raw upstream messages or arbitrary genesis data in attestation failures', async () => {
  const rpcUrl = 'https://secret-host.invalid/?api-key=PRIVATE_KEY';
  const responses: typeof fetch[] = [
    vi.fn(async () => { throw new Error(`${rpcUrl} PRIVATE_BODY`); }),
    vi.fn(async () => new Response('PRIVATE_BODY', { status: 503 })),
    vi.fn(async () => new Response('PRIVATE_BODY', { status: 200 })),
    rpc('PRIVATE_BODY'),
  ];
  for (const fetchImpl of responses) {
    const error = await assertSolanaCluster({ rpcUrl, cluster: 'devnet', fetchImpl }).catch(error => error);
    expect(error).toBeInstanceOf(Error);
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toMatch(/PRIVATE|secret-host/);
    expect(fetchImpl).toHaveBeenCalledWith(rpcUrl, expect.objectContaining({ redirect: 'error' }));
  }
});

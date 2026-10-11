/** Startup order is the safety property: no migration, ledger bootstrap, route,
 * or worker may run before both the selected address registry and RPC genesis
 * are proved. Source-order guard matches the existing server-startup suite and
 * avoids importing server.ts (which deliberately executes main()). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
const baseSource = readFileSync(new URL('../src/game/base.ts', import.meta.url), 'utf8');

describe('economy cluster startup fence', () => {
  it('selects the exact cluster registry and proves RPC genesis before opening the database', () => {
    const registryAt = source.indexOf('loadAddresses(repoRoot, config.SOLANA_CLUSTER)');
    const genesisAt = source.indexOf('await assertSolanaCluster({ rpcUrl, cluster: config.SOLANA_CLUSTER })');
    const stateAt = source.indexOf('assertMainnetAddressRegistry(makeDepositRpcConnection(rpcUrl), addresses)');
    const databaseAt = source.indexOf('createDb(config.DATABASE_URL)');
    expect(registryAt).toBeGreaterThan(0);
    expect(genesisAt).toBeGreaterThan(registryAt);
    expect(stateAt).toBeGreaterThan(genesisAt);
    expect(databaseAt).toBeGreaterThan(stateAt);
  });

  it('attests an isolated mint evidence endpoint before any state can be touched', () => {
    const mintAt = source.indexOf('await assertSolanaCluster({ rpcUrl: config.MINT_EVIDENCE_RPC_URL, cluster: config.SOLANA_CLUSTER })');
    expect(mintAt).toBeGreaterThan(0);
    expect(source.indexOf('createDb(config.DATABASE_URL)')).toBeGreaterThan(mintAt);
  });

  it('requires the named mainnet registry and independent RPC providers', () => {
    expect(source).toContain('/infra/mainnet.addresses.json');
    expect(source).toContain('assertIndependentRpcProviders(economyRpcUrls)');
  });

  it('threads the selected cluster into marketplace DAS reads', () => {
    expect(source).toContain('cluster: config.SOLANA_CLUSTER');
  });

  it('never sends devnet faucet instructions from a mainnet welcome path', () => {
    expect(baseSource).toContain("process.env['SOLANA_CLUSTER'] ?? 'devnet'");
    expect(baseSource).toMatch(/subject: devnet \?/);
    expect(baseSource).toMatch(/body: \(devnet \? \[/);
  });
});

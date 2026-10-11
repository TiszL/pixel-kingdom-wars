import { readFileSync } from 'node:fs';
import { afterAll, describe, expect, it } from 'vitest';
import devnet from '../../../infra/devnet.addresses.json';
import { assertEconomyChainIdentity } from '../src/money/economyIdentity';
import { connectTestDb } from './helpers';

const conn = connectTestDb();
const binding = {
  cluster: 'devnet' as const,
  keepMint: devnet.keepMint,
  coreProgram: devnet.coreProgram,
  configPda: devnet.config,
};

afterAll(async () => conn.sql.end());

describe('persistent economy chain identity', () => {
  it('binds a legacy nonempty DB only to known devnet and then rejects every mismatch', async () => {
    await assertEconomyChainIdentity(conn.db, binding, binding);
    await expect(assertEconomyChainIdentity(conn.db, binding, binding)).resolves.toBeUndefined();
    await expect(assertEconomyChainIdentity(conn.db, {
      ...binding, cluster: 'mainnet-beta', keepMint: '11111111111111111111111111111111',
    }, binding)).rejects.toThrow(/runtime selected mainnet-beta/);
    await expect(assertEconomyChainIdentity(conn.db, {
      ...binding, keepMint: '11111111111111111111111111111111',
    }, binding)).rejects.toThrow(/database economy identity/);
  });

  it('is asserted before API bootstrap and independently at worker startup', () => {
    const server = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
    const jobs = readFileSync(new URL('../src/jobs.ts', import.meta.url), 'utf8');
    expect(server.indexOf('assertEconomyChainIdentity(db')).toBeLessThan(server.indexOf('bootstrapEconomyAllocations(db)'));
    expect(jobs.slice(jobs.indexOf('export async function startWorkers')))
      .toContain('await assertEconomyChainIdentity(db');
  });
});

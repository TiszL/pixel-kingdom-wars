import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertMatchingCustodyEvidence, hotWalletInfo, liquidityWallet,
} from '../src/jobs';
import type { CustodyReserveEvidence } from '../src/money/reserves';

const originalRoot = process.env['REPO_ROOT'];
const originalHot = process.env['HOT_WALLET_PUBKEY'];
const temporary: string[] = [];

afterEach(async () => {
  if (originalRoot === undefined) delete process.env['REPO_ROOT'];
  else process.env['REPO_ROOT'] = originalRoot;
  if (originalHot === undefined) delete process.env['HOT_WALLET_PUBKEY'];
  else process.env['HOT_WALLET_PUBKEY'] = originalHot;
  for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true });
});

function evidence(overrides: Partial<CustodyReserveEvidence> = {}): CustodyReserveEvidence {
  return {
    role: 'liquid_hot_custody', commitment: 'finalized', account: 'account', owner: 'owner',
    mint: 'mint', tokenProgram: 'token', canonicalAta: true, slot: 10,
    state: 'initialized', delegate: null, delegatedAmountBaseUnits: 0n,
    observedBalanceBaseUnits: 1_000_000_000n, observedBalanceKeep: 1_000n,
    eligible: true, ineligibilityReason: null, ...overrides,
  };
}

describe('jobs chain/PoR wiring', () => {
  it('requires independent finalized custody evidence to agree exactly except for slot', () => {
    expect(() => assertMatchingCustodyEvidence(evidence(), evidence({ slot: 11 }))).not.toThrow();
    expect(() => assertMatchingCustodyEvidence(
      evidence(), evidence({ observedBalanceKeep: 999n, observedBalanceBaseUnits: 999_000_000n }),
    )).toThrow(/independent finalized custody RPCs disagree/);
    expect(() => assertMatchingCustodyEvidence(
      evidence(), evidence({ delegate: Keypair.generate().publicKey.toBase58() }),
    )).toThrow(/independent finalized custody RPCs disagree/);
  });

  it('loads the explicitly selected mainnet registry in direct helper calls', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'shardkeep-jobs-cluster-'));
    temporary.push(root);
    await mkdir(path.join(root, 'infra'));
    const address = () => Keypair.generate().publicKey.toBase58();
    const hot = address();
    const mainnet = {
      cluster: 'mainnet-beta', coreProgram: address(), distributorProgram: address(),
      keepMint: address(), config: address(), deedCollection: address(),
      treasuries: { liquidity: address(), dev: address(), ops: address() },
      updatedAt: new Date(0).toISOString(),
    };
    const devnet = { ...mainnet, cluster: 'devnet', keepMint: address(), treasuries: {
      liquidity: address(), dev: address(), ops: address(),
    } };
    await writeFile(path.join(root, 'infra', 'mainnet.addresses.json'), JSON.stringify(mainnet));
    await writeFile(path.join(root, 'infra', 'devnet.addresses.json'), JSON.stringify(devnet));
    process.env['REPO_ROOT'] = root;
    process.env['HOT_WALLET_PUBKEY'] = hot;

    expect(hotWalletInfo({ SOLANA_CLUSTER: 'mainnet-beta' })?.keepMint.toBase58())
      .toBe(mainnet.keepMint);
    expect(liquidityWallet({ SOLANA_CLUSTER: 'mainnet-beta' })?.toBase58())
      .toBe(mainnet.treasuries.liquidity);
  });
});

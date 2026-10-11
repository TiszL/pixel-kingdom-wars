import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import devnetAddresses from '../../../infra/devnet.addresses.json';
import { currentKeepMint } from '../src/money/mintDimension';

const priorRoot = process.env['REPO_ROOT'];
const roots: string[] = [];

afterEach(() => {
  if (priorRoot === undefined) delete process.env['REPO_ROOT'];
  else process.env['REPO_ROOT'] = priorRoot;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ledger mint dimension follows the selected cluster registry', () => {
  it('never falls back to devnet when mainnet-beta was selected', () => {
    const root = mkdtempSync(join(tmpdir(), 'shardkeep-mint-cluster-'));
    roots.push(root);
    mkdirSync(join(root, 'infra'));
    writeFileSync(join(root, 'infra', 'mainnet.addresses.json'), JSON.stringify({
      ...devnetAddresses,
      cluster: 'mainnet-beta',
      keepMint: 'So11111111111111111111111111111111111111112',
    }));
    process.env['REPO_ROOT'] = root;

    expect(currentKeepMint('mainnet-beta')).toBe('So11111111111111111111111111111111111111112');
    expect(currentKeepMint('devnet')).toBeNull();
  });
});

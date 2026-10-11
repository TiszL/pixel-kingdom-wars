import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
const root = fileURLToPath(new URL('../src/', import.meta.url));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? sources(join(directory, entry.name)) : entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []);
}
describe('devnet-only static dependency fence', () => {
  it('keeps every devnet-only specifier behind the loader', () => {
    for (const file of sources(root)) {
      const name = relative(root, file); const source = readFileSync(file, 'utf8');
      const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\(\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]!);
      for (const specifier of specifiers) {
        if (specifier.includes('devnet-only')) expect(name === 'devnetOnlyLoader.ts' || name.startsWith('devnet-only/'), name).toBe(true);
        if (specifier === '@shardkeep/chain/devnet-skr-faucet-transfer') expect(name.startsWith('devnet-only/'), name).toBe(true);
        if (name.startsWith('devnet-only/')) expect(specifier, name).not.toBe('@solana/spl-token');
      }
    }
    expect(readFileSync(new URL('../../../packages/chain/src/index.ts', import.meta.url), 'utf8')).not.toContain('devnetSkrFaucetTransfer');
  });
  it('puts the mainnet absence gate before the first database connection', () => {
    const source = readFileSync(join(root, 'server.ts'), 'utf8');
    expect(source.indexOf('assertDevnetOnlyAbsentOnMainnet(')).toBeGreaterThan(0);
    expect(source.indexOf('assertDevnetOnlyAbsentOnMainnet(')).toBeLessThan(source.indexOf('createDb('));
    expect(source.indexOf('assertSkrMintPinsAgree(')).toBeLessThan(source.indexOf('createDb('));
  });
});

describe('faucet signing-key isolation', () => {
  it('keeps key loading out of API route and persistence modules', () => {
    for (const name of ['routes-skr-faucet.ts', 'skrFaucetStore.ts', 'skrFaucet.ts']) {
      const source = readFileSync(join(root, 'devnet-only', name), 'utf8');
      expect(source, name).not.toMatch(/\b(?:readFileSync|openSync|fromSecretKey|KEYPAIR_PATH)\b/);
      expect(source, name).not.toMatch(/\bfrom\s*['"]node:fs/);
    }
    const source = readFileSync(join(root, 'devnet-only/index.ts'), 'utf8');
    const apiRegistration = source.slice(source.indexOf('export async function registerDevnetOnly('), source.indexOf('export async function registerDevnetOnlyJobs('));
    expect(apiRegistration).not.toMatch(/workerKey\(|KEYPAIR_PATH|fromSecretKey/);
  });
});

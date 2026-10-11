/**
 * Repository publication invariants.
 *
 * A tidy README cannot protect a later `git add -A` from publishing a signing
 * key, and four copies of a program id can drift while each still looks valid.
 * Keep those mechanical checks in CI; prose review remains a human job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');

const PUBLIC_DOCS = [
  'README.md',
  'PROJECT_OVERVIEW.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'docs/GAMEPLAY.md',
  'docs/SOLANA.md',
  'docs/ECONOMY.md',
  'docs/DIAGRAMS.md',
  'docs/ASSET_PIPELINE.md',
  'docs/TESTING.md',
  'docs/KNOWN_LIMITATIONS.md',
] as const;

function trackedFiles(): string[] {
  // WHY maxBuffer: the tracked-file list outgrew Node's 1 MiB default (1,054,559 bytes
  // with the M47 site media on 2026-09-27), and an ENOBUFS here is a test-harness failure,
  // not a readiness finding. 64 MiB leaves decades of headroom.
  return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    // A cleanup working tree can contain an unstaged deletion. CI evaluates the
    // committed tree, while local verification should evaluate what will remain.
    .filter((rel) => rel !== '' && existsSync(path.join(ROOT, rel)));
}

function markdownTargets(markdown: string): string[] {
  return [...markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)]
    .map((match) => match[1]?.trim() ?? '')
    .filter(Boolean);
}

function isKeypairFilename(base: string): boolean {
  return /(?:^|[-_.])keypair\.json$/.test(base.toLowerCase());
}

function isTopLevelSolanaSecretArray(contents: string): boolean {
  try {
    const value: unknown = JSON.parse(contents);
    return Array.isArray(value)
      && (value.length === 32 || value.length === 64)
      && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255);
  } catch {
    return false;
  }
}

function resolveLocalMarkdownTarget(source: string, rawTarget: string): string | null {
  if (/^(?:https?:|mailto:|#)/i.test(rawTarget)) return null;
  const withoutTitle = rawTarget.startsWith('<') && rawTarget.endsWith('>')
    ? rawTarget.slice(1, -1)
    : rawTarget.split(/\s+["']/)[0]!;
  const filePart = withoutTitle.split('#')[0]!;
  return filePart
    ? path.resolve(path.dirname(source), decodeURIComponent(filePart))
    : null;
}

function isWithinRepository(target: string): boolean {
  const relative = path.relative(ROOT, target);
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

describe('repository publication readiness', () => {
  it('recognizes conventional keypair filenames regardless of separator', () => {
    expect([
      'keypair.json',
      'example-keypair.json',
      'example_keypair.json',
      'example.keypair.json',
    ].every(isKeypairFilename)).toBe(true);
    expect(isKeypairFilename('public-addresses.json')).toBe(false);
  });

  it('recognizes deterministic fake Solana secret-array fixtures by content', () => {
    const fakeSeed = Array.from({ length: 32 }, (_, i) => (i * 17 + 3) % 256);
    const fakeSecretKey = Array.from({ length: 64 }, (_, i) => (i * 29 + 7) % 256);

    expect(isTopLevelSolanaSecretArray(JSON.stringify(fakeSeed))).toBe(true);
    expect(isTopLevelSolanaSecretArray(JSON.stringify(fakeSecretKey))).toBe(true);
    expect(isTopLevelSolanaSecretArray(JSON.stringify({ secretKey: fakeSecretKey }))).toBe(false);
    expect(isTopLevelSolanaSecretArray(JSON.stringify(fakeSecretKey.slice(1)))).toBe(false);
    expect(isTopLevelSolanaSecretArray(JSON.stringify([...fakeSeed.slice(0, 31), 256]))).toBe(false);
  });

  it('never tracks signing, submission, environment, or key material', () => {
    const allowedEnvironmentTemplates = new Set(['.env.example', 'infra/.env.prod.example']);
    const forbidden: string[] = [];

    for (const rel of trackedFiles()) {
      const normalized = rel.replaceAll('\\', '/');
      const lower = normalized.toLowerCase();
      const base = path.posix.basename(lower);
      const privateMobile = /^mobile\/(?:keystore|build|dappstore)(?:\/|$)/.test(lower);
      const privateInfra = /^infra\/(?:keys|backups)(?:\/|$)/.test(lower);
      const signingExtension = /\.(?:apk|aab|keystore|jks|p12|pfx)$/.test(lower)
        || isKeypairFilename(base);
      const environmentFile = base === '.env' || base.startsWith('.env.');
      const conventionalSecretFile = /^(?:passwords?|credentials?|secrets?)(?:\.|$)/.test(base);
      const solanaSecretArray = lower.endsWith('.json')
        && isTopLevelSolanaSecretArray(readFileSync(path.join(ROOT, rel), 'utf8'));
      if (privateMobile || privateInfra || signingExtension || conventionalSecretFile
        || solanaSecretArray || (environmentFile && !allowedEnvironmentTemplates.has(normalized))) {
        forbidden.push(normalized);
      }
    }

    expect(forbidden, `private artifacts are tracked:\n${forbidden.join('\n')}`).toEqual([]);
  });

  it('keeps every deployed program id aligned', () => {
    const coreIdl = JSON.parse(readFileSync(
      path.join(ROOT, 'packages/chain/src/idl/shardkeep_core.json'), 'utf8',
    )) as { address: string };
    const distributorIdl = JSON.parse(readFileSync(
      path.join(ROOT, 'packages/chain/src/idl/shardkeep_distributor.json'), 'utf8',
    )) as { address: string };
    const addresses = JSON.parse(readFileSync(
      path.join(ROOT, 'infra/devnet.addresses.json'), 'utf8',
    )) as {
      coreProgram: string;
      distributorProgram: string;
      keepMint: string;
      keepMintBranded: string;
      buckets?: unknown;
    };
    const anchor = readFileSync(path.join(ROOT, 'programs/Anchor.toml'), 'utf8');
    const coreRust = readFileSync(path.join(ROOT, 'programs/shardkeep-core/src/lib.rs'), 'utf8');
    const distributorRust = readFileSync(
      path.join(ROOT, 'programs/shardkeep-distributor/src/lib.rs'), 'utf8',
    );

    expect(addresses.coreProgram).toBe(coreIdl.address);
    expect(addresses.distributorProgram).toBe(distributorIdl.address);
    expect(anchor.match(new RegExp(`shardkeep_core = "${coreIdl.address}"`, 'g'))).toHaveLength(2);
    expect(anchor.match(new RegExp(`shardkeep_distributor = "${distributorIdl.address}"`, 'g')))
      .toHaveLength(2);
    expect(coreRust).toContain(`declare_id!("${coreIdl.address}")`);
    expect(distributorRust).toContain(`declare_id!("${distributorIdl.address}")`);
    // WHY: this duplicate is the fail-closed marker that prevents the retired
    // allocation bootstrap from repointing custody to its legacy mint.
    expect(addresses.keepMintBranded).toBe(addresses.keepMint);
    // Legacy allocation ATAs belong to an older mint and must not look current.
    expect(addresses.buckets).toBeUndefined();
  });

  it('keeps the public documentation path present with resolvable local links', () => {
    for (const rel of PUBLIC_DOCS) {
      const source = path.join(ROOT, rel);
      expect(existsSync(source), `missing public document: ${rel}`).toBe(true);
      const markdown = readFileSync(source, 'utf8');
      for (const rawTarget of markdownTargets(markdown)) {
        const target = resolveLocalMarkdownTarget(source, rawTarget);
        if (!target) continue;
        expect(isWithinRepository(target), `${rel} links outside the repository: ${rawTarget}`).toBe(true);
        expect(existsSync(target), `${rel} has a broken local link: ${rawTarget}`).toBe(true);
      }
    }
  });

  it('rejects Markdown traversal and absolute-path fixtures outside the repository', () => {
    const source = path.join(ROOT, 'docs', 'fixture.md');
    const inside = resolveLocalMarkdownTarget(source, '../README.md');
    const traversal = resolveLocalMarkdownTarget(source, '../../outside.md');
    const encodedTraversal = resolveLocalMarkdownTarget(source, '%2e%2e/%2e%2e/outside.md');
    const absolute = resolveLocalMarkdownTarget(source, path.resolve(ROOT, '..', 'outside.md'));

    expect(inside && isWithinRepository(inside)).toBe(true);
    expect(traversal && isWithinRepository(traversal)).toBe(false);
    expect(encodedTraversal && isWithinRepository(encodedTraversal)).toBe(false);
    expect(absolute && isWithinRepository(absolute)).toBe(false);
  });

  it('keeps local mobile and unpublished website artifacts ignored', () => {
    const gitIgnore = readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    const dockerIgnore = readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
    expect(gitIgnore).toContain('/website rework v2/');
    for (const suffix of ['*.apk', '*.aab', '*.keystore', '*.jks', '*.p12', '*.pfx']) {
      expect(gitIgnore).toContain(suffix);
    }
    expect(dockerIgnore).toMatch(/^mobile$/m);
  });
});

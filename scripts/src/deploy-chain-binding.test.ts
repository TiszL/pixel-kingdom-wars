import { spawnSync } from 'node:child_process';
import {
  chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
const DEVNET = JSON.parse(
  readFileSync(path.join(ROOT, 'infra/devnet.addresses.json'), 'utf8'),
) as {
  coreProgram: string;
  distributorProgram: string;
  config: string;
  keepMint: string;
  treasuries: { liquidity: string; dev: string; ops: string };
};

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function embeddedNodeBlock(startMarker: string): string {
  const start = DEPLOY.indexOf(startMarker);
  if (start < 0) throw new Error(`deploy block marker not found: ${startMarker}`);
  const end = DEPLOY.indexOf('\nNODE', start);
  if (end < 0) throw new Error(`deploy block terminator not found after: ${startMarker}`);
  return DEPLOY.slice(start, end);
}

const CHAIN_BINDING_BLOCK = embeddedNodeBlock('const fs = require(\'node:fs\');\nconst path');
const CONFIG_PREFLIGHT_BLOCK = embeddedNodeBlock('const fs = require(\'node:fs\');\nconst file');
const SIGNER_STATE_PREFLIGHT_BLOCK = embeddedNodeBlock(
  'const fs = require(\'node:fs\');\nconst envFile',
);

function fixtureDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'shardkeep-deploy-binding-'));
  fixtures.push(root);
  mkdirSync(path.join(root, 'infra'));
  return root;
}

function mainnetRegistry(
  includeAuthorityPolicy = true,
  includeProgramDeploymentPolicy = true,
) {
  return {
    cluster: 'mainnet-beta',
    coreProgram: DEVNET.coreProgram,
    config: DEVNET.config,
    keepMint: DEVNET.treasuries.liquidity,
    treasuries: {
      liquidity: DEVNET.treasuries.dev,
      dev: DEVNET.treasuries.ops,
      ops: DEVNET.keepMint,
    },
    ...(includeAuthorityPolicy ? {
      keepMintAuthorities: {
        mintAuthority: DEVNET.treasuries.ops,
        freezeAuthority: null,
      },
    } : {}),
    ...(includeProgramDeploymentPolicy ? {
      programDeployments: {
        core: {
          programDataAddress: DEVNET.distributorProgram,
          programDataSha256: 'a'.repeat(64),
          upgradeAuthority: null,
        },
      },
    } : {}),
  };
}

function runChainBinding(opts: {
  cluster: 'devnet' | 'mainnet-beta';
  rpcUrl?: string;
  genesis?: string;
  includeAuthorityPolicy?: boolean;
  includeProgramDeploymentPolicy?: boolean;
  relayEnabled?: string;
  upstream?: string;
}) {
  const root = fixtureDir();
  const prodFile = path.join(root, 'prod.env');
  const webFile = path.join(root, 'web.env');
  const rpcUrl = opts.rpcUrl ?? `https://game.example/api/rpc/solana/${opts.cluster}`;
  const upstream = opts.upstream ?? `https://${opts.cluster === 'devnet' ? 'devnet' : 'mainnet'}.helius-rpc.com/?api-key=private-test-secret`;
  writeFileSync(prodFile, `SOLANA_CLUSTER=${opts.cluster}\nWEB_ORIGIN=https://game.example\nRPC_RELAY_ENABLED=${opts.relayEnabled ?? 'true'}\nSOLANA_RPC_URL=${upstream}\n`);
  writeFileSync(webFile, `VITE_SOLANA_RPC_URL=${rpcUrl}\n`);
  const registry = opts.cluster === 'devnet'
    ? { ...DEVNET, cluster: 'devnet' }
    : mainnetRegistry(
      opts.includeAuthorityPolicy,
      opts.includeProgramDeploymentPolicy,
    );
  writeFileSync(path.join(root, 'infra', opts.cluster === 'devnet'
    ? 'devnet.addresses.json' : 'mainnet.addresses.json'), JSON.stringify(registry));
  const genesis = opts.genesis ?? (opts.cluster === 'devnet'
    ? 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'
    : '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d52');
  const fakeFetch = `globalThis.fetch = async (url, options) => {\n`
    + `  if (url !== ${JSON.stringify(upstream)} || options.redirect !== 'error') throw Error('incorrect prebuild attestation');\n`
    + `  return ({\n`
    + `  ok: true, status: 200, json: async () => (${JSON.stringify({ result: genesis })})\n`
    + `}); };\n`;
  return spawnSync(process.execPath, ['-', prodFile, webFile], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, VITE_SOLANA_RPC_URL: '' },
    input: fakeFetch + CHAIN_BINDING_BLOCK,
  });
}

function preflightEnv(overrides: Record<string, string> = {}): string {
  const cluster = overrides['SOLANA_CLUSTER'] ?? 'devnet';
  const expectedMint = cluster === 'devnet' ? DEVNET.keepMint : mainnetRegistry().keepMint;
  const values = {
    HOT_WALLET_KEYPAIR_PATH: '/run/keys/hot-wallet.json',
    HOT_WALLET_PUBKEY: DEVNET.treasuries.liquidity,
    WITHDRAWAL_SIGNER_MODE: 'remote',
    WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'file',
    WITHDRAWAL_POLICY_SIGNER_URL: 'http://withdrawal-signer:3003',
    WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE: '/run/secrets/withdrawal-policy-signer.token',
    WITHDRAWAL_POLICY_KEEP_MINT: expectedMint,
    WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP: '250000',
    WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP: '250000',
    WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP: '1000000',
    TWOFA_ENCRYPTION_KEYS: `primary:${Buffer.alloc(32, 7).toString('base64')}`,
    RESEND_API_KEY: 'test-key',
    EMAIL_FROM: 'test@example.com',
    SOLANA_CLUSTER: cluster,
    MAIL_DELIVERY_ENABLED: 'true',
    // This fixture exercises the custody/chain preflight. Keep push explicitly
    // disabled so adding mandatory notification configuration cannot make an
    // otherwise-valid custody baseline fail before the assertions under test.
    PUSH_NOTIFICATIONS_ENABLED: 'false',
    MINE_FULL_NOTIFICATIONS_ENABLED: 'false',
    LIVE_RAID_V2_ENABLED: 'false',
    WITHDRAWALS_ENABLED: 'true',
    TOTP_RECOVERY_ENABLED: 'false',
    ...overrides,
  };
  return Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

function runConfigPreflight(overrides: Record<string, string> = {}) {
  const root = fixtureDir();
  const envFile = path.join(root, 'prod.env');
  writeFileSync(envFile, preflightEnv(overrides));
  const cluster = overrides['SOLANA_CLUSTER'] ?? 'devnet';
  const registry = cluster === 'devnet'
    ? { ...DEVNET, cluster: 'devnet' }
    : mainnetRegistry();
  writeFileSync(
    path.join(root, 'infra', cluster === 'devnet'
      ? 'devnet.addresses.json' : 'mainnet.addresses.json'),
    JSON.stringify(registry),
  );
  return spawnSync(process.execPath, ['-', envFile], {
    cwd: root, encoding: 'utf8', input: CONFIG_PREFLIGHT_BLOCK,
  });
}

function runSignerStatePreflight(options: {
  malformedState?: boolean;
  insecureToken?: boolean;
  partialTrailingEntry?: boolean;
  missingKey?: 'admin' | 'deed-ops';
  ownerMismatch?: boolean;
} = {}) {
  const root = fixtureDir();
  const keys = path.join(root, 'infra', 'keys');
  const signerState = path.join(root, 'infra', 'policy-signer-state');
  mkdirSync(keys, { mode: 0o700 });
  mkdirSync(signerState, { mode: 0o700 });
  if (options.missingKey !== 'admin') {
    writeFileSync(path.join(keys, 'admin.keypair.json'), '[1]\n', { mode: 0o600 });
  }
  if (options.missingKey !== 'deed-ops') {
    writeFileSync(path.join(keys, 'deed-ops.keypair.json'), '[1]\n', { mode: 0o600 });
  }
  writeFileSync(path.join(keys, 'hot-wallet.keypair.json'), '[1]\n', { mode: 0o600 });
  const token = path.join(keys, 'withdrawal-policy-signer.token');
  writeFileSync(token, `${'a'.repeat(32)}\n`, { mode: 0o600 });
  if (options.insecureToken) chmodSync(token, 0o644);
  const stateText = options.malformedState ? '{"version":1}' : '{"version":2}';
  writeFileSync(
    path.join(signerState, 'state.json'),
    `${stateText}${options.partialTrailingEntry ? '' : '\n'}`,
    { mode: 0o600 },
  );
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const envFile = path.join(root, 'prod.env');
  writeFileSync(envFile, [
    `WITHDRAWAL_POLICY_SIGNER_UID=${options.ownerMismatch ? uid + 1 : uid}`,
    `WITHDRAWAL_POLICY_SIGNER_GID=${gid}`,
  ].join('\n') + '\n');
  return spawnSync(process.execPath, ['-', envFile], {
    cwd: root, encoding: 'utf8', input: SIGNER_STATE_PREFLIGHT_BLOCK,
  });
}

describe('production web chain binding', () => {
  it('requires explicit M34 rollout flags and forbids mine delivery without push consent infrastructure', () => {
    for (const flag of ['MINE_FULL_NOTIFICATIONS_ENABLED', 'LIVE_RAID_V2_ENABLED']) {
      for (const value of ['', '1', 'TRUE']) {
        const result = runConfigPreflight({ [flag]: value });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(value === ''
          ? `${flag} is not set`
          : `${flag} must be the exact literal true or false`);
      }
    }
    const noPush = runConfigPreflight({ MINE_FULL_NOTIFICATIONS_ENABLED: 'true' });
    expect(noPush.status).not.toBe(0);
    expect(noPush.stderr).toContain('requires PUSH_NOTIFICATIONS_ENABLED=true');
  });
  it('resolves the exact devnet registry and emits the completion sentinel', () => {
    const result = runChainBinding({ cluster: 'devnet' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\t')).toEqual([
      'devnet', 'https://game.example/api/rpc/solana/devnet',
      DEVNET.coreProgram, DEVNET.config, DEVNET.keepMint,
      DEVNET.treasuries.liquidity, DEVNET.treasuries.dev, DEVNET.treasuries.ops,
      'chain-binding-ok',
    ]);
  });

  it('refuses credential-bearing, foreign or disabled browser relays and public upstreams', () => {
    for (const rpcUrl of ['https://api.devnet.solana.com',
      'https://devnet.helius-rpc.com/?api-key=private-test-secret',
      'https://game.example/api/rpc/solana/devnet?key=private-test-secret',
      'https://game.example/api/rpc/solana/mainnet-beta']) {
      const result = runChainBinding({ cluster: 'devnet', rpcUrl });
      expect(result.status).not.toBe(0);
      expect(result.stderr).not.toContain('private-test-secret');
      expect(result.stdout).toBe('');
    }
    expect(runChainBinding({ cluster: 'devnet', relayEnabled: 'false' }).status).not.toBe(0);
    expect(runChainBinding({ cluster: 'devnet', upstream: 'https://api.devnet.solana.com' }).status).not.toBe(0);
  });

  it('executes the serving probe with parsed origins and fails closed on disabled relays', () => {
    const start = DEPLOY.indexOf('const config = loadConfig();', DEPLOY.indexOf('say \"verifying the served browser RPC relay before traffic returns\"'));
    const end = DEPLOY.indexOf("\n}' || die ", start) + 2;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const probe = DEPLOY.slice(start, end);
    for (const enabled of ['true', 'false']) {
      const setup = `const loadConfig = () => (${JSON.stringify({
        RPC_RELAY_ENABLED: enabled, WEB_ORIGIN: ['https://game.example'], SOLANA_CLUSTER: 'devnet',
      })});
` + `globalThis.fetch = async (url, options) => {
        if (options.headers.origin !== 'https://game.example' || options.redirect !== 'error'
          || url !== 'http://127.0.0.1:3001/rpc/solana/devnet') throw Error('wrong serving contract');
        return {ok: true, json: async () => ({result: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'})};
      };
`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
        input: setup + probe, encoding: 'utf8',
      });
      expect(result.status, result.stderr).toBe(enabled === 'true' ? 0 : 1);
      expect(result.stdout + result.stderr).toContain(enabled === 'true'
        ? 'Served same-origin RPC relay genesis verified' : 'traffic remains stopped');
    }
  });

  it('verifies the live relay before publishing and returning traffic', () => {
    const serving = DEPLOY.indexOf('say "verifying the served browser RPC relay before traffic returns"');
    expect(serving).toBeGreaterThan(DEPLOY.indexOf('\nverify_serving_health\n'));
    expect(serving).toBeLessThan(DEPLOY.indexOf('say "publishing verified dist'));
    expect(DEPLOY).toContain('const reader = hotKeepReserveReader(config);');
    expect(DEPLOY).toContain('Served browser RPC relay verification failed; traffic remains stopped');
  });

  it('resolves every mainnet address from the selected mainnet manifest', () => {
    const expected = mainnetRegistry();
    const result = runChainBinding({ cluster: 'mainnet-beta' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().split('\t')).toEqual([
      'mainnet-beta', 'https://game.example/api/rpc/solana/mainnet-beta',
      expected.coreProgram, expected.config, expected.keepMint,
      expected.treasuries.liquidity, expected.treasuries.dev, expected.treasuries.ops,
      'chain-binding-ok',
    ]);
  });

  it('fails on wrong genesis, unsafe RPC, or an incomplete mainnet review manifest', () => {
    const wrongGenesis = runChainBinding({ cluster: 'mainnet-beta', genesis: 'wrong' });
    expect(wrongGenesis.status).not.toBe(0);
    expect(wrongGenesis.stderr).toContain('does not serve mainnet-beta');

    const unsafeRpc = runChainBinding({ cluster: 'devnet', rpcUrl: 'http://rpc.example' });
    expect(unsafeRpc.status).not.toBe(0);
    expect(unsafeRpc.stderr).toContain('must use https');

    const noPolicy = runChainBinding({
      cluster: 'mainnet-beta', includeAuthorityPolicy: false,
    });
    expect(noPolicy.status).not.toBe(0);
    expect(noPolicy.stderr).toContain('missing the reviewed KEEP authority policy');

    const noProgramPolicy = runChainBinding({
      cluster: 'mainnet-beta', includeProgramDeploymentPolicy: false,
    });
    expect(noProgramPolicy.status).not.toBe(0);
    expect(noProgramPolicy.stderr).toContain('missing reviewed Anchor ProgramData policies');
  });

  it('requires one reviewed ProgramData policy for every listed Anchor program', () => {
    const root = fixtureDir();
    const prodFile = path.join(root, 'prod.env');
    const webFile = path.join(root, 'web.env');
    writeFileSync(prodFile, 'SOLANA_CLUSTER=mainnet-beta\nWEB_ORIGIN=https://game.example\nRPC_RELAY_ENABLED=true\nSOLANA_RPC_URL=https://private.example\n');
    writeFileSync(webFile, 'VITE_SOLANA_RPC_URL=https://game.example/api/rpc/solana/mainnet-beta\n');
    const incomplete = {
      ...mainnetRegistry(),
      distributorProgram: DEVNET.distributorProgram,
    };
    writeFileSync(
      path.join(root, 'infra/mainnet.addresses.json'), JSON.stringify(incomplete),
    );
    const fakeFetch = `globalThis.fetch = async () => ({\n`
      + `  ok: true, status: 200, json: async () => (${JSON.stringify({
        result: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2d52',
      })})\n`
      + `});\n`;
    const result = spawnSync(process.execPath, ['-', prodFile, webFile], {
      cwd: root, encoding: 'utf8', env: { ...process.env, VITE_SOLANA_RPC_URL: '' },
      input: fakeFetch + CHAIN_BINDING_BLOCK,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('invalid reviewed distributor ProgramData policy');
  });

  it('keeps devnet withdrawals enabled and rejects every mainnet coverage bypass', () => {
    expect(runConfigPreflight().status).toBe(0);
    const bypass = runConfigPreflight({
      SOLANA_CLUSTER: 'mainnet-beta', WITHDRAWALS_ENABLED: 'false',
      PAYOUT_COVERAGE_OVERRIDE: 'true',
    });
    expect(bypass.status).not.toBe(0);
    expect(bypass.stderr).toContain('forbidden on mainnet-beta');
    const devnetHalt = runConfigPreflight({
      SOLANA_CLUSTER: 'devnet', WITHDRAWALS_ENABLED: 'false',
    });
    expect(devnetHalt.status).not.toBe(0);
    expect(devnetHalt.stderr).toContain('must remain true for the current devnet rollout');
  });

  it('requires the reviewed remote signer policy and an existing secure journal', () => {
    expect(runConfigPreflight().status).toBe(0);

    const mainnetFile = runConfigPreflight({
      SOLANA_CLUSTER: 'mainnet-beta', WITHDRAWALS_ENABLED: 'false',
    });
    expect(mainnetFile.status).not.toBe(0);
    expect(mainnetFile.stderr).toContain('mainnet-beta forbids file-backed withdrawal custody');

    const fakeHsm = runConfigPreflight({ WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'hsm' });
    expect(fakeHsm.status).not.toBe(0);
    expect(fakeHsm.stderr).toContain('supports only file');

    const localSigner = runConfigPreflight({ WITHDRAWAL_SIGNER_MODE: 'local' });
    expect(localSigner.status).not.toBe(0);
    expect(localSigner.stderr).toContain('requires WITHDRAWAL_SIGNER_MODE=remote');

    const mismatchedMint = runConfigPreflight({
      WITHDRAWAL_POLICY_KEEP_MINT: DEVNET.treasuries.dev,
    });
    expect(mismatchedMint.status).not.toBe(0);
    expect(mismatchedMint.stderr).toContain('does not match infra/devnet.addresses.json');

    const reversedLimits = runConfigPreflight({
      WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP: '1000001',
    });
    expect(reversedLimits.status).not.toBe(0);
    expect(reversedLimits.stderr).toContain('transfer <= wallet <= aggregate');

    expect(runSignerStatePreflight().status).toBe(0);
    const malformed = runSignerStatePreflight({ malformedState: true });
    expect(malformed.status).not.toBe(0);
    expect(malformed.stderr).toContain('policy signer journal header is invalid');
    const insecure = runSignerStatePreflight({ insecureToken: true });
    expect(insecure.status).not.toBe(0);
    expect(insecure.stderr).toContain('policy signer token permissions must be 0600');

    const partial = runSignerStatePreflight({ partialTrailingEntry: true });
    expect(partial.status).not.toBe(0);
    expect(partial.stderr).toContain('partial trailing entry');

    for (const missingKey of ['admin', 'deed-ops'] as const) {
      const missing = runSignerStatePreflight({ missingKey });
      expect(missing.status).not.toBe(0);
      expect(missing.stderr).toContain('ENOENT');
    }

    const mismatchedOwner = runSignerStatePreflight({ ownerMismatch: true });
    expect(mismatchedOwner.status).not.toBe(0);
    expect(mismatchedOwner.stderr).toContain('must be owned by');
  });

  it('wires verified values into Vite and checks the compiled client', () => {
    expect(DEPLOY).toContain('WEB_CHAIN_BINDING_SENTINEL');
    expect(DEPLOY).toContain("[ \"$WEB_CHAIN_BINDING_SENTINEL\" = 'chain-binding-ok' ]");
    // The repo-root .env is also Vite's envDir and may legitimately describe a
    // developer shell. A production deploy must override it or Vite compiles
    // out the service worker and mobile offline-pack gate.
    expect(DEPLOY).toContain('NODE_ENV=production \\\nVITE_API_URL=/api \\');
    expect(DEPLOY).toContain('VITE_SOLANA_CLUSTER="$WEB_SOLANA_CLUSTER"');
    expect(DEPLOY).toContain('VITE_CORE_PROGRAM_ID="$WEB_CORE_PROGRAM"');
    expect(DEPLOY).toContain('VITE_CORE_CONFIG_PDA="$WEB_CORE_CONFIG"');
    expect(DEPLOY).toContain('VITE_KEEP_MINT="$WEB_KEEP_MINT"');
    expect(DEPLOY).toContain('VITE_TREASURY_LIQUIDITY="$WEB_TREASURY_LIQUIDITY"');
    expect(DEPLOY).toContain('VITE_TREASURY_DEV="$WEB_TREASURY_DEV"');
    expect(DEPLOY).toContain('VITE_TREASURY_OPS="$WEB_TREASURY_OPS"');
    expect(DEPLOY).not.toContain('VITE_SOLANA_RPC_URL="$SOLANA_RPC_URL"');
    expect(DEPLOY).toContain('grep -rFql -- "$expected" apps/web/dist/assets');
  });
});

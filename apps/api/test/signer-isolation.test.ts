/** Release-blocker wiring: public HTTP process has public custody identity but
 * no signer mount; the worker alone mounts keys and rejects a mismatched hot key. */
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { hotWalletInfo, hotWalletSender } from '../src/jobs';

const repoRoot = path.resolve(process.cwd(), '..', '..');
const original = { ...process.env };

afterEach(() => {
  for (const key of [
    'HOT_WALLET_PUBKEY', 'HOT_WALLET_KEYPAIR_PATH', 'REPO_ROOT',
    'SOLANA_CLUSTER', 'WITHDRAWAL_SIGNER_MODE', 'WITHDRAWAL_POLICY_CUSTODY_BACKEND',
    'WITHDRAWAL_POLICY_SIGNER_URL',
    'WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP',
    'WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE', 'WITHDRAWAL_POLICY_KEEP_MINT',
  ]) {
    if (original[key] === undefined) delete process.env[key];
    else process.env[key] = original[key];
  }
});

describe('production signer isolation', () => {
  it('only the database-blind private signer sees the hot key and durable state', () => {
    const compose = readFileSync(path.join(repoRoot, 'infra/docker-compose.prod.yml'), 'utf8');
    const api = compose.slice(compose.indexOf('\n  api:'), compose.indexOf('\n  withdrawal-signer:'));
    const signer = compose.slice(compose.indexOf('\n  withdrawal-signer:'), compose.indexOf('\n  worker:'));
    const worker = compose.slice(compose.indexOf('\n  worker:'), compose.indexOf('\n  migrate:'));
    const migrate = compose.slice(compose.indexOf('\n  migrate:'), compose.indexOf('\n  caddy:'));
    expect(api).not.toContain('withdrawal-policy-signer.token:ro');
    expect(api).not.toContain('networks: [withdrawal-signer]');
    expect(api).toContain("HOT_WALLET_KEYPAIR_PATH: ''");
    expect(api).toContain('HOT_WALLET_PUBKEY: ${HOT_WALLET_PUBKEY:?');
    expect(api).toContain("WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'true'");
    expect(signer).toContain('./keys/hot-wallet.keypair.json:/run/secrets/hot-wallet.keypair.json:ro');
    expect(signer).toContain('./policy-signer-state:/var/lib/shardkeep-policy');
    expect(signer).toContain('networks: [withdrawal-signer]');
    expect(signer).toContain('stop_grace_period: 60s');
    expect(signer).toContain("user: '${WITHDRAWAL_POLICY_SIGNER_UID:-1000}:${WITHDRAWAL_POLICY_SIGNER_GID:-1000}'");
    expect(signer).toContain('read_only: true');
    expect(signer).toContain('cap_drop: [ALL]');
    expect(signer).toContain('security_opt: [no-new-privileges:true]');
    expect(signer).toContain('/tmp:rw,noexec,nosuid,nodev,size=64m');
    expect(signer).toContain("WITHDRAWAL_POLICY_SIGNER_ALLOW_NON_LOOPBACK_BIND: 'true'");
    expect(signer).toContain('WITHDRAWAL_POLICY_CUSTODY_BACKEND: ${WITHDRAWAL_POLICY_CUSTODY_BACKEND:-file}');
    expect(signer).not.toContain('DATABASE_URL:');
    expect(worker).toContain("HOT_WALLET_KEYPAIR_PATH: ''");
    expect(worker).toContain("user: '${WITHDRAWAL_POLICY_SIGNER_UID:-1000}:${WITHDRAWAL_POLICY_SIGNER_GID:-1000}'");
    expect(worker).not.toContain('hot-wallet.keypair.json:');
    expect(worker).toContain('./keys/admin.keypair.json:/app/infra/keys/admin.keypair.json:ro');
    expect(worker).toContain('./keys/deed-ops.keypair.json:/app/infra/keys/deed-ops.keypair.json:ro');
    expect(worker).toContain('./keys/withdrawal-policy-signer.token:/run/secrets/withdrawal-policy-signer.token:ro');
    expect(worker).toContain('networks: [default, withdrawal-signer]');
    expect(worker).toContain('HOT_WALLET_PUBKEY: ${HOT_WALLET_PUBKEY:?');
    expect(worker).toContain("WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'true'");
    expect(worker).toContain('WITHDRAWAL_POLICY_CUSTODY_BACKEND: ${WITHDRAWAL_POLICY_CUSTODY_BACKEND:-file}');
    expect(migrate).toContain("WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP: 'true'");
    expect(migrate).not.toContain('withdrawal-policy-signer.token:ro');
    expect(migrate).not.toContain('networks: [withdrawal-signer]');
  });

  it('keeps rollback paths signerless-safe and pairs DB backups with newer signer state', () => {
    const envExample = readFileSync(path.join(repoRoot, 'infra/.env.prod.example'), 'utf8');
    const deploy = readFileSync(path.join(repoRoot, 'infra/deploy.sh'), 'utf8');
    const backup = readFileSync(path.join(repoRoot, 'infra/backup/backup.sh'), 'utf8');
    const verify = readFileSync(path.join(repoRoot, 'infra/backup/verify-restore.sh'), 'utf8');
    const deployment = readFileSync(path.join(repoRoot, 'docs/DEPLOYMENT.md'), 'utf8');
    const dockerignore = readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8');
    const dockerfile = readFileSync(path.join(repoRoot, 'apps/api/Dockerfile'), 'utf8');
    const initializer = readFileSync(path.join(repoRoot, 'infra/init-policy-signer-state.sh'), 'utf8');
    expect(envExample).toContain('HOT_WALLET_KEYPAIR_PATH=/app/infra/keys/hot-wallet.keypair.json');
    expect(envExample).toContain('./infra/init-policy-signer-state.sh --confirm-empty-state');
    expect(envExample).toContain('WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP=false');
    expect(envExample).toContain('WITHDRAWAL_POLICY_SIGNER_UID=1000');
    expect(envExample).toContain('WITHDRAWAL_POLICY_SIGNER_GID=1000');
    expect(backup).toContain('node is required for policy signer backup verification');
    expect(verify).toContain('node is required for policy signer restore verification');
    expect(backup).toContain('$POLICY_VERIFY_DIR:/var/lib/policy-verify:ro');
    expect(verify).toContain('$POLICY_VERIFY_DIR:/var/lib/policy-verify:ro');
    expect(dockerfile).toContain('command -v flock >/dev/null');
    expect(initializer).toContain('run policy-signer:init --confirm-empty-state');
    expect(deploy.indexOf('$COMPOSE stop worker')).toBeLessThan(
      deploy.indexOf('$COMPOSE stop withdrawal-signer'),
    );
    expect(backup.indexOf('pg_dump')).toBeLessThan(backup.indexOf('cp -- "$SIGNER_STATE"'));
    expect(backup).toContain('"${COMPOSE[@]}" stop worker');
    expect(backup).toContain("'{{.State.Running}} {{.State.Restarting}}'");
    expect(backup.indexOf('"${COMPOSE[@]}" stop worker')).toBeLessThan(
      backup.indexOf('"${COMPOSE[@]}" stop withdrawal-signer'),
    );
    expect(backup).toContain('shardkeep-$STAMP.signer-state.json');
    expect(backup).toContain('BACKUP_OFFSITE_ENCRYPTED');
    expect(verify).toContain('missing same-backup-id policy signer state');
    expect(verify).toContain('keep WITHDRAWALS_ENABLED=false');
    expect(deployment).toContain('ordinary rollback is API-only');
    expect(deployment).toContain('policy-signer introduction');
    expect(deployment).toContain('A pre-signer worker can');
    expect(dockerignore).toContain('infra/policy-signer-state');
  });

  it('read-only hot wallet info needs only the public address', () => {
    const keypair = Keypair.generate();
    process.env.REPO_ROOT = repoRoot;
    process.env.HOT_WALLET_PUBKEY = keypair.publicKey.toBase58();
    delete process.env.HOT_WALLET_KEYPAIR_PATH;
    expect(hotWalletInfo()?.pubkey.toBase58()).toBe(keypair.publicKey.toBase58());
    expect(hotWalletSender()).toBeNull();
  });

  it('worker invocation cannot bypass the devnet-only file custody policy', () => {
    process.env.REPO_ROOT = repoRoot;
    process.env.SOLANA_CLUSTER = 'mainnet-beta';
    process.env.WITHDRAWAL_POLICY_CUSTODY_BACKEND = 'file';
    expect(() => hotWalletSender()).toThrow(/mainnet-beta forbids file-backed withdrawal custody/);

    process.env.SOLANA_CLUSTER = 'devnet';
    process.env.WITHDRAWAL_POLICY_CUSTODY_BACKEND = 'hsm';
    expect(() => hotWalletSender()).toThrow(/supports only file/);
  });

  it('worker refuses to sign when mounted key does not match public config', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shardkeep-signer-'));
    try {
      const mounted = Keypair.generate();
      const keyPath = path.join(dir, 'hot.json');
      writeFileSync(keyPath, JSON.stringify([...mounted.secretKey]), { mode: 0o600 });
      process.env.REPO_ROOT = repoRoot;
      process.env.WITHDRAWAL_SIGNER_MODE = 'legacy';
      process.env.HOT_WALLET_KEYPAIR_PATH = keyPath;
      process.env.HOT_WALLET_PUBKEY = Keypair.generate().publicKey.toBase58();
      expect(() => hotWalletSender()).toThrow(/does not match HOT_WALLET_PUBKEY/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remote worker constructs a sender from public identity + token without the hot key', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shardkeep-remote-signer-'));
    try {
      const addresses = JSON.parse(readFileSync(path.join(repoRoot, 'infra/devnet.addresses.json'), 'utf8')) as {
        keepMint: string;
      };
      const tokenPath = path.join(dir, 'token');
      writeFileSync(tokenPath, 't'.repeat(32), { mode: 0o600 });
      process.env.REPO_ROOT = repoRoot;
      process.env.WITHDRAWAL_SIGNER_MODE = 'remote';
      process.env.WITHDRAWAL_POLICY_SIGNER_URL = 'http://withdrawal-signer:3003';
      process.env.WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP = 'true';
      process.env.WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE = tokenPath;
      process.env.WITHDRAWAL_POLICY_KEEP_MINT = addresses.keepMint;
      process.env.HOT_WALLET_PUBKEY = Keypair.generate().publicKey.toBase58();
      delete process.env.HOT_WALLET_KEYPAIR_PATH;
      expect(hotWalletSender()).not.toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remote worker refuses a token file readable by other host users', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shardkeep-remote-signer-'));
    try {
      const addresses = JSON.parse(readFileSync(path.join(repoRoot, 'infra/devnet.addresses.json'), 'utf8')) as {
        keepMint: string;
      };
      const tokenPath = path.join(dir, 'token');
      writeFileSync(tokenPath, 't'.repeat(32), { mode: 0o644 });
      chmodSync(tokenPath, 0o644);
      process.env.REPO_ROOT = repoRoot;
      process.env.WITHDRAWAL_SIGNER_MODE = 'remote';
      process.env.WITHDRAWAL_POLICY_SIGNER_URL = 'http://withdrawal-signer:3003';
      process.env.WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP = 'true';
      process.env.WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE = tokenPath;
      process.env.WITHDRAWAL_POLICY_KEEP_MINT = addresses.keepMint;
      process.env.HOT_WALLET_PUBKEY = Keypair.generate().publicKey.toBase58();
      delete process.env.HOT_WALLET_KEYPAIR_PATH;
      expect(() => hotWalletSender()).toThrow(/0600 regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remote worker never sends its bearer token to an arbitrary plain-HTTP origin', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'shardkeep-remote-signer-'));
    try {
      const addresses = JSON.parse(readFileSync(path.join(repoRoot, 'infra/devnet.addresses.json'), 'utf8')) as {
        keepMint: string;
      };
      const tokenPath = path.join(dir, 'token');
      writeFileSync(tokenPath, 't'.repeat(32), { mode: 0o600 });
      process.env.REPO_ROOT = repoRoot;
      process.env.WITHDRAWAL_SIGNER_MODE = 'remote';
      process.env.WITHDRAWAL_POLICY_SIGNER_URL = 'http://attacker.example:3003';
      process.env.WITHDRAWAL_POLICY_SIGNER_ALLOW_PRIVATE_HTTP = 'true';
      process.env.WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE = tokenPath;
      process.env.WITHDRAWAL_POLICY_KEEP_MINT = addresses.keepMint;
      process.env.HOT_WALLET_PUBKEY = Keypair.generate().publicKey.toBase58();
      delete process.env.HOT_WALLET_KEYPAIR_PATH;
      expect(() => hotWalletSender()).toThrow(/exactly http:\/\/withdrawal-signer:3003/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

import {
  chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deserializePreparedKeepWithdrawal, type PolicySignerPrepareRequest } from '@shardkeep/chain';
import { ECONOMY } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  initializeWithdrawalPolicyState,
  WithdrawalPolicySigner,
  type WithdrawalPolicySignerConfig,
} from '../src/money/policySigner';
import { loadPolicySignerRuntimeConfig, startPolicySignerServer } from '../src/policySignerServer';

let directory: string;
let stateFile: string;
let hotWallet: Keypair;
let keepMint: Keypair;
let now: Date;
let config: WithdrawalPolicySignerConfig;

function wire(
  id: number,
  options: Partial<PolicySignerPrepareRequest> = {},
): PolicySignerPrepareRequest {
  const gross = options.grossAmountKeep ?? '1000';
  const fee = (BigInt(gross) * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
  return {
    version: 1,
    withdrawalId: `a0000000-0000-4000-8000-${id.toString().padStart(12, '0')}`,
    playerWallet: Keypair.generate().publicKey.toBase58(),
    destination: Keypair.generate().publicKey.toBase58(),
    grossAmountKeep: gross,
    netAmountKeep: (BigInt(gross) - fee).toString(),
    authorizationDigest: id.toString(16).padStart(64, '0'),
    walletRolling24hCapKeep: gross,
    cluster: 'devnet',
    mint: keepMint.publicKey.toBase58(),
    sourceOwner: hotWallet.publicKey.toBase58(),
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 100 + id,
    ...options,
  };
}

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'shardkeep-policy-signer-'));
  stateFile = path.join(directory, 'state.json');
  hotWallet = Keypair.generate();
  keepMint = Keypair.generate();
  now = new Date('2026-08-20T12:00:00.000Z');
  config = {
    stateFile,
    cluster: 'devnet',
    keepMint: keepMint.publicKey,
    sourceOwner: hotWallet.publicKey,
    maxPerTransferKeep: 4_000n,
    maxPerWallet24hKeep: 5_000n,
    maxAggregate24hKeep: 8_000n,
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function signer(override: Partial<WithdrawalPolicySignerConfig> = {}) {
  return new WithdrawalPolicySigner({ ...config, ...override }, hotWallet, () => new Date(now));
}

async function journalEntries(): Promise<Array<Record<string, unknown>>> {
  const lines = (await readFile(stateFile, 'utf8')).trimEnd().split('\n');
  expect(JSON.parse(lines.shift()!)).toEqual({ version: 2 });
  return lines.filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function writeJournal(entries: Array<Record<string, unknown>>): Promise<void> {
  await writeFile(stateFile, `${[
    JSON.stringify({ version: 2 }), ...entries.map((entry) => JSON.stringify(entry)),
  ].join('\n')}\n`, { mode: 0o600 });
}

async function holdAdvisoryLock(file: string): Promise<ChildProcessWithoutNullStreams> {
  await writeFile(file, '', { mode: 0o600 });
  const command = process.platform === 'darwin' ? '/usr/bin/lockf' : 'flock';
  const args = process.platform === 'darwin'
    ? ['-t', '0', file, 'sh', '-c', 'printf LOCKED; cat >/dev/null']
    : ['-n', file, 'sh', '-c', 'printf LOCKED; cat >/dev/null'];
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`lock helper exited ${String(code)}`)));
    child.stdout.once('data', (chunk) => (
      chunk.toString() === 'LOCKED' ? resolve() : reject(new Error('lock helper handshake failed'))
    ));
  });
  return child;
}

describe('independent withdrawal policy signer', () => {
  it('loads the key and worker token only from matching 0600 regular files', async () => {
    const keyFile = path.join(directory, 'hot.json');
    const tokenFile = path.join(directory, 'token');
    await writeFile(keyFile, JSON.stringify([...hotWallet.secretKey]), { mode: 0o600 });
    await writeFile(tokenFile, `${'t'.repeat(32)}\n`, { mode: 0o600 });
    const env = {
      SOLANA_CLUSTER: 'devnet',
      WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'file',
      HOT_WALLET_PUBKEY: hotWallet.publicKey.toBase58(),
      HOT_WALLET_KEYPAIR_PATH: keyFile,
      WITHDRAWAL_POLICY_KEEP_MINT: keepMint.publicKey.toBase58(),
      WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE: tokenFile,
      WITHDRAWAL_POLICY_SIGNER_STATE_FILE: stateFile,
      WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP: '4000',
      WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP: '5000',
      WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP: '8000',
    };
    expect(loadPolicySignerRuntimeConfig(env)).toMatchObject({
      authToken: 't'.repeat(32), custodyBackend: 'file',
      host: '127.0.0.1', allowNonLoopbackBind: false,
    });
    expect(() => loadPolicySignerRuntimeConfig({
      ...env, SOLANA_CLUSTER: 'mainnet-beta',
    })).toThrow(/mainnet-beta forbids file-backed withdrawal custody/);
    expect(() => loadPolicySignerRuntimeConfig({
      ...env, WITHDRAWAL_POLICY_CUSTODY_BACKEND: 'hsm',
    })).toThrow(/supports only file/);
    expect(() => loadPolicySignerRuntimeConfig({
      ...env, WITHDRAWAL_POLICY_SIGNER_HOST: '0.0.0.0',
    })).toThrow(/non-loopback policy signer bind requires/);
    expect(() => loadPolicySignerRuntimeConfig({
      ...env,
      WITHDRAWAL_POLICY_SIGNER_HOST: '0.0.0.0',
      WITHDRAWAL_POLICY_SIGNER_ALLOW_NON_LOOPBACK_BIND: 'TRUE',
    })).toThrow(/must be true or false/);
    expect(loadPolicySignerRuntimeConfig({
      ...env,
      WITHDRAWAL_POLICY_SIGNER_HOST: '0.0.0.0',
      WITHDRAWAL_POLICY_SIGNER_ALLOW_NON_LOOPBACK_BIND: 'true',
    })).toMatchObject({ host: '0.0.0.0', allowNonLoopbackBind: true });
    await chmod(tokenFile, 0o644);
    expect(() => loadPolicySignerRuntimeConfig(env)).toThrow(/permissions must be 0600/);
  });

  it('reports CLI startup failures and exits without an unhandled rejection', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/policySignerServer.ts'], {
      cwd: path.resolve(process.cwd()),
      env: { PATH: process.env['PATH'] ?? '', NODE_ENV: 'test' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(code).toBe(1);
    expect(stderr).toContain('[withdrawal-policy-signer] startup failed:');
    expect(stderr).not.toContain('UnhandledPromiseRejection');
  });

  it('fails closed when state is missing, corrupt, insecure, or has a tampered artifact', async () => {
    await expect(signer().assertReady()).rejects.toThrow(/ENOENT/);

    await writeFile(stateFile, 'not json', { mode: 0o600 });
    await expect(signer().assertReady()).rejects.toThrow(/unreadable/);

    await writeFile(stateFile, `${JSON.stringify({ version: 2 })}\n`);
    await chmod(stateFile, 0o644);
    await expect(signer().assertReady()).rejects.toThrow(/permissions must be 0600/);

    await chmod(stateFile, 0o600);
    const service = signer();
    const prepared = await service.prepare(wire(1));
    const entries = await journalEntries();
    const first = entries[0]!;
    first['prepared'] = { ...prepared, signature: Keypair.generate().publicKey.toBase58() };
    await writeJournal(entries);
    await expect(service.assertReady()).rejects.toThrow(/signature/);
  });

  it('persists before returning and retries the same logical input byte-for-byte', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    await expect(initializeWithdrawalPolicyState(stateFile)).rejects.toThrow(/EEXIST/);
    const service = signer();
    const request = wire(2, { walletRolling24hCapKeep: '5000' });
    const first = await service.prepare(request);
    const stateAfterFirst = await readFile(stateFile, 'utf8');
    const retried = await service.prepare({
      ...request,
      // A worker restart naturally fetches a fresh blockhash. The policy input
      // is still exact, so the already-counted artifact must be returned.
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 999,
      // This risk hint is dynamic and does not change the already-signed
      // transfer authorization; replay must still recover the first artifact.
      walletRolling24hCapKeep: '6000',
    });
    expect(retried).toEqual(first);
    expect(await readFile(stateFile, 'utf8')).toBe(stateAfterFirst);
    expect(deserializePreparedKeepWithdrawal(first).transfer).toMatchObject({
      withdrawalId: request.withdrawalId,
      destinationOwner: request.destination,
      amountKeep: request.netAmountKeep,
      mint: request.mint,
      feePayer: request.sourceOwner,
    });
    expect((await readdir(directory)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('returns an existing counted artifact after signer limits are lowered', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const request = wire(22, {
      grossAmountKeep: '3000', walletRolling24hCapKeep: '5000',
    });
    const first = await signer().prepare(request);
    const tightened = signer({
      maxPerTransferKeep: 500n, maxPerWallet24hKeep: 500n, maxAggregate24hKeep: 500n,
    });
    await expect(tightened.prepare({
      ...request, recentBlockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 999,
    })).resolves.toEqual(first);
  });

  it('detects an externally replaced state despite the validated-state cache', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    await service.assertReady();
    await writeFile(stateFile, '{"version":2}\n{"tampered":true}\n', { mode: 0o600 });
    await expect(service.assertReady()).rejects.toThrow(/unexpected fields/);
  });

  it('refuses a symlinked lock file without changing its target', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const target = path.join(directory, 'outside-lock-target');
    await writeFile(target, 'operator-owned', { mode: 0o644 });
    await chmod(target, 0o644);
    await symlink(target, `${stateFile}.lock`);

    let refusal: NodeJS.ErrnoException | undefined;
    try {
      await signer().assertReady();
    } catch (error) {
      refusal = error as NodeJS.ErrnoException;
    }
    expect(refusal?.code).toBe('ELOOP');
    expect(await readFile(target, 'utf8')).toBe('operator-owned');
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await journalEntries()).toHaveLength(0);
  });

  it('uses a crash-released OS lock and refuses a concurrent signer', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const holder = await holdAdvisoryLock(`${stateFile}.lock`);
    try {
      await expect(signer().assertReady()).rejects.toThrow(/locked by another signer/);
      await expect(signer().prepare(wire(23))).rejects.toThrow(/locked by another signer/);
      expect(await journalEntries()).toHaveLength(0);
    } finally {
      holder.stdin.end();
      await new Promise<void>((resolve) => holder.once('close', () => resolve()));
    }
    await expect(signer().prepare(wire(23))).resolves.toBeDefined();
  });

  it('refuses withdrawal-id reuse when any logical authorization input changes', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    const request = wire(3);
    await service.prepare(request);
    await expect(service.prepare({
      ...request,
      authorizationDigest: 'f'.repeat(64),
    })).rejects.toThrow(/already signed for different input/);
  });

  it('never signs the same wallet authorization digest under a second withdrawal id', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    const first = wire(19);
    await service.prepare(first);
    await expect(service.prepare(wire(20, {
      authorizationDigest: first.authorizationDigest,
    }))).rejects.toThrow(/authorization digest was already signed/);
  });

  it('independently rejects fee, cluster, mint, source, and worker-cap tampering', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    await expect(service.prepare(wire(21, { grossAmountKeep: '499' })))
      .rejects.toThrow(/500 KEEP minimum/);
    await expect(service.prepare(wire(4, { netAmountKeep: '999' })))
      .rejects.toThrow(/fee formula/);
    await expect(service.prepare(wire(5, { cluster: 'mainnet-beta' })))
      .rejects.toThrow(/custody identity mismatch/);
    await expect(service.prepare(wire(6, { mint: Keypair.generate().publicKey.toBase58() })))
      .rejects.toThrow(/custody identity mismatch/);
    await expect(service.prepare(wire(7, { sourceOwner: Keypair.generate().publicKey.toBase58() })))
      .rejects.toThrow(/custody identity mismatch/);
    await expect(service.prepare(wire(8, { walletRolling24hCapKeep: '5001' })))
      .rejects.toThrow(/worker wallet cap exceeds/);
  });

  it('enforces max-per-transfer and the rolling per-wallet limit from durable signed gross', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    await expect(service.prepare(wire(9, {
      grossAmountKeep: '4001',
      walletRolling24hCapKeep: '5000',
    }))).rejects.toThrow(/max-per-transfer/);

    const playerWallet = Keypair.generate().publicKey.toBase58();
    await service.prepare(wire(10, {
      playerWallet, grossAmountKeep: '3000', walletRolling24hCapKeep: '5000',
    }));
    await expect(service.prepare(wire(11, {
      playerWallet, grossAmountKeep: '2500', walletRolling24hCapKeep: '5000',
    }))).rejects.toThrow(/rolling wallet limit/);
  });

  it('serializes concurrent requests so the aggregate circuit breaker cannot race', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer({ maxAggregate24hKeep: 5_000n });
    const results = await Promise.allSettled([
      service.prepare(wire(12, {
        grossAmountKeep: '3000', walletRolling24hCapKeep: '5000',
      })),
      service.prepare(wire(13, {
        grossAmountKeep: '3000', walletRolling24hCapKeep: '5000',
      })),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await journalEntries()).toHaveLength(1);
  });

  it('keeps signed artifacts forever for idempotency but ages their gross out after 24 hours', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    const playerWallet = Keypair.generate().publicKey.toBase58();
    await service.prepare(wire(14, {
      playerWallet, grossAmountKeep: '4000', walletRolling24hCapKeep: '5000',
    }));
    const firstDurablePrefix = await readFile(stateFile, 'utf8');
    now = new Date(now.getTime() + 86_400_001);
    await expect(service.prepare(wire(15, {
      playerWallet, grossAmountKeep: '4000', walletRolling24hCapKeep: '5000',
    }))).resolves.toBeDefined();
    expect((await readFile(stateFile, 'utf8')).startsWith(firstDurablePrefix)).toBe(true);
    expect(await journalEntries()).toHaveLength(2);
  });

  it('fails closed if the wall clock moves behind the last durable signature', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const service = signer();
    await service.prepare(wire(16));
    now = new Date(now.getTime() - 1);
    await expect(service.prepare(wire(17))).rejects.toThrow(/clock moved backwards/);
  });

  it('refuses unsupported custody even when the exported server factory is called directly', async () => {
    const direct = {
      ...config,
      custodyBackend: 'file' as const,
      host: '127.0.0.1',
      port: 0,
      allowNonLoopbackBind: false,
      authToken: 't'.repeat(32),
      keypair: hotWallet,
    };
    await expect(startPolicySignerServer({
      ...direct, cluster: 'mainnet-beta',
    })).rejects.toThrow(/mainnet-beta forbids file-backed withdrawal custody/);
    await expect(startPolicySignerServer({
      ...direct, custodyBackend: 'hsm' as never,
    })).rejects.toThrow(/supports only file/);
  });

  it('exposes signing only through the worker token and never counts an unauthorized request', async () => {
    await initializeWithdrawalPolicyState(stateFile);
    const runtime = await startPolicySignerServer({
      ...config,
      custodyBackend: 'file',
      host: '127.0.0.1',
      port: 0,
      allowNonLoopbackBind: false,
      authToken: 't'.repeat(32),
      keypair: hotWallet,
    });
    try {
      const url = `http://127.0.0.1:${runtime.port}/v1/withdrawals/prepare`;
      const request = wire(18);
      expect((await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
      })).status).toBe(401);
      expect((await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(32)}`, 'content-type': 'text/plain' },
        body: JSON.stringify(request),
      })).status).toBe(415);
      expect((await fetch(`${url}/unsupported`, {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(32)}`, 'content-type': 'application/json' },
        body: JSON.stringify(request),
      })).status).toBe(404);
      expect(await journalEntries()).toHaveLength(0);
      expect((await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(32)}`, 'content-type': 'application/json' },
        body: '{',
      })).status).toBe(422);
      expect(await journalEntries()).toHaveLength(0);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${'t'.repeat(32)}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request),
      });
      expect(response.status).toBe(200);
      expect(deserializePreparedKeepWithdrawal(await response.json())).toBeDefined();
      expect(await journalEntries()).toHaveLength(1);
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const malformed = vi.spyOn(runtime.signer, 'prepare')
        .mockResolvedValue({ impossibleBigInt: 1n } as never);
      try {
        expect((await fetch(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${'t'.repeat(32)}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(wire(26)),
        })).status).toBe(503);
      } finally {
        malformed.mockRestore();
        log.mockRestore();
      }
      expect(await journalEntries()).toHaveLength(1);
      expect((await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(32)}`, 'content-type': 'application/json' },
        body: JSON.stringify(wire(24, { authorizationDigest: request.authorizationDigest })),
      })).status).toBe(422);
      await chmod(stateFile, 0o644);
      expect((await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${'t'.repeat(32)}`, 'content-type': 'application/json' },
        body: JSON.stringify(wire(25)),
      })).status).toBe(503);
      await chmod(stateFile, 0o600);
    } finally {
      await runtime.close();
    }
  });
});

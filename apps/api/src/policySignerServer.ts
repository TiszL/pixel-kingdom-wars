/** Private HTTP wrapper around the independent withdrawal policy signer. */
import { timingSafeEqual } from 'node:crypto';
import {
  closeSync, constants, fstatSync, openSync, readFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP, type AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { Keypair, PublicKey } from '@solana/web3.js';
import {
  PolicySignerPolicyRefusal,
  PolicySignerRequestError,
  WithdrawalPolicySigner,
  type WithdrawalPolicySignerConfig,
} from './money/policySigner';

const MAX_REQUEST_BYTES = 16_384;

export interface PolicySignerRuntimeConfig extends WithdrawalPolicySignerConfig {
  custodyBackend: 'file';
  host: string;
  port: number;
  allowNonLoopbackBind: boolean;
  authToken: string;
  keypair: Keypair;
}

function exactOptIn(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name]?.trim() || 'false';
  if (value !== 'true' && value !== 'false') throw new Error(`${name} must be true or false`);
  return value === 'true';
}

function isLoopbackBind(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '[::1]'
    || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

function assertSafeBind(config: Pick<PolicySignerRuntimeConfig, 'host' | 'allowNonLoopbackBind'>): void {
  if (!isLoopbackBind(config.host) && !config.allowNonLoopbackBind) {
    throw new Error(
      'non-loopback policy signer bind requires WITHDRAWAL_POLICY_SIGNER_ALLOW_NON_LOOPBACK_BIND=true',
    );
  }
}

function assertSupportedCustodyRuntime(
  custodyBackend: unknown,
  cluster: WithdrawalPolicySignerConfig['cluster'],
): asserts custodyBackend is 'file' {
  if (custodyBackend !== 'file') {
    throw new Error(
      'WITHDRAWAL_POLICY_CUSTODY_BACKEND supports only file; no HSM or enclave backend is implemented',
    );
  }
  if (cluster === 'mainnet-beta') {
    throw new Error(
      'mainnet-beta forbids file-backed withdrawal custody; no reviewed HSM or enclave backend is implemented',
    );
  }
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveKeep(env: NodeJS.ProcessEnv, name: string): bigint {
  const value = required(env, name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a positive decimal KEEP amount`);
  return BigInt(value);
}

function readRegularFile(file: string, label: string): string {
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    if ((stat.mode & 0o077) !== 0) throw new Error(`${label} permissions must be 0600`);
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

export function loadPolicySignerRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): PolicySignerRuntimeConfig {
  const cluster = required(env, 'SOLANA_CLUSTER');
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') {
    throw new Error('SOLANA_CLUSTER must be devnet or mainnet-beta');
  }
  const custodyBackend = env['WITHDRAWAL_POLICY_CUSTODY_BACKEND']?.trim() || 'file';
  assertSupportedCustodyRuntime(custodyBackend, cluster);
  const sourceOwner = new PublicKey(required(env, 'HOT_WALLET_PUBKEY'));
  const keepMint = new PublicKey(required(env, 'WITHDRAWAL_POLICY_KEEP_MINT'));
  const keypairPath = required(env, 'HOT_WALLET_KEYPAIR_PATH');
  let secret: unknown;
  try { secret = JSON.parse(readRegularFile(keypairPath, 'hot-wallet keypair')); } catch (error) {
    throw new Error(`hot-wallet keypair is unreadable: ${String(error)}`);
  }
  if (!Array.isArray(secret) || secret.length !== 64
      || secret.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new Error('hot-wallet keypair has invalid bytes');
  }
  const keypair = Keypair.fromSecretKey(Uint8Array.from(secret as number[]));
  if (keypair.publicKey.toBase58() !== sourceOwner.toBase58()) {
    throw new Error('hot-wallet keypair does not match HOT_WALLET_PUBKEY');
  }
  const tokenPath = required(env, 'WITHDRAWAL_POLICY_SIGNER_AUTH_TOKEN_FILE');
  const rawToken = readRegularFile(tokenPath, 'policy signer auth token');
  const authToken = rawToken.trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(authToken)
      || rawToken.replace(/\r?\n$/, '') !== authToken) {
    throw new Error('policy signer auth token must be one 32-256 character base64url token');
  }
  const port = Number(env['WITHDRAWAL_POLICY_SIGNER_PORT'] ?? '3003');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('WITHDRAWAL_POLICY_SIGNER_PORT must be a valid port');
  }
  const runtime: PolicySignerRuntimeConfig = {
    custodyBackend,
    host: env['WITHDRAWAL_POLICY_SIGNER_HOST']?.trim() || '127.0.0.1',
    port,
    allowNonLoopbackBind: exactOptIn(env, 'WITHDRAWAL_POLICY_SIGNER_ALLOW_NON_LOOPBACK_BIND'),
    authToken,
    keypair,
    stateFile: required(env, 'WITHDRAWAL_POLICY_SIGNER_STATE_FILE'),
    cluster,
    keepMint,
    sourceOwner,
    maxPerTransferKeep: positiveKeep(env, 'WITHDRAWAL_POLICY_MAX_PER_TRANSFER_KEEP'),
    maxPerWallet24hKeep: positiveKeep(env, 'WITHDRAWAL_POLICY_MAX_PER_WALLET_24H_KEEP'),
    maxAggregate24hKeep: positiveKeep(env, 'WITHDRAWAL_POLICY_MAX_AGGREGATE_24H_KEEP'),
  };
  assertSafeBind(runtime);
  return runtime;
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice('Bearer '.length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(encoded);
}

function refuse(response: ServerResponse, status: number): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  try {
    json(response, status, { error: 'withdrawal signing refused' });
  } catch {
    response.destroy();
  }
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new Error('request is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function startPolicySignerServer(config = loadPolicySignerRuntimeConfig()) {
  assertSupportedCustodyRuntime(config.custodyBackend, config.cluster);
  assertSafeBind(config);
  const signer = new WithdrawalPolicySigner(config, config.keypair);
  await signer.assertReady();
  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') {
        await signer.assertReady();
        json(response, 200, { ok: true });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/v1/withdrawals/prepare') {
        json(response, 404, { error: 'not found' });
        return;
      }
      if (!authorized(request, config.authToken)) {
        json(response, 401, { error: 'unauthorized' });
        return;
      }
      if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        json(response, 415, { error: 'application/json required' });
        return;
      }
      let body: unknown;
      try { body = await requestBody(request); } catch (error) {
        throw new PolicySignerRequestError(
          error instanceof Error ? error.message : 'invalid request body',
        );
      }
      const prepared = await signer.prepare(body);
      json(response, 200, prepared);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[withdrawal-policy-signer] request refused: ${message}`);
      const terminal = error instanceof PolicySignerRequestError
        || error instanceof PolicySignerPolicyRefusal;
      refuse(response, terminal ? 422 : 503);
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  return {
    signer,
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    ))),
  };
}

async function runPolicySignerCli(): Promise<void> {
  const runtime = await startPolicySignerServer();
  console.log('[withdrawal-policy-signer] ready');
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runtime.close().then(
      () => process.exit(0),
      (error) => {
        console.error(`[withdrawal-policy-signer] shutdown failed: ${String(error)}`);
        process.exit(1);
      },
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void runPolicySignerCli().catch((error) => {
    console.error(`[withdrawal-policy-signer] startup failed: ${String(error)}`);
    process.exitCode = 1;
  });
}

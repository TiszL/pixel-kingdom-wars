import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout as pause } from 'node:timers/promises';
import cookie from '@fastify/cookie';
import { Connection, Keypair, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { registerSolanaRpcRoutes, type SolanaRpcRelayDeps } from '../src/routes-solana-rpc';
import { parseRpcCall, RPC_RELAY_LIMITS, rpcFailure, sanitizeRpcResponse, verifyRelayTransaction, type RpcCall } from '../src/lib/solanaRpcRelay';
import { RedisRelayAdmission, type RelayAdmission } from '../src/lib/solanaRpcRelayAdmission';
import { TEST_CONFIG } from './helpers';

const origin = 'http://localhost:5173';
const payer = Keypair.generate(); const other = Keypair.generate();
const signature = bs58.encode(Buffer.alloc(64, 1));
const blockhash = Keypair.generate().publicKey.toBase58();
const call = (method = 'getBalance', params: unknown[] = [payer.publicKey.toBase58()], id: number | string = 1) => ({ jsonrpc: '2.0' as const, id, method, params });
const apps: FastifyInstance[] = []; const servers: Server[] = []; const socketServers: WebSocketServer[] = []; const clients: WebSocket[] = [];
const admissions: RedisRelayAdmission[] = [];
const cleanups: Array<() => Promise<void>> = [];
const fakeAdmission = (): RelayAdmission => ({
  charge: vi.fn(async () => undefined),
  acquire: vi.fn(async () => ({ release: vi.fn(async () => undefined), renew: vi.fn(async () => undefined) })),
  close: vi.fn(async () => undefined),
});
async function relay(upstream = 'https://provider.invalid/?api-key=PRIVATE-DO-NOT-ECHO', deps: SolanaRpcRelayDeps = {}) {
  const app = Fastify(); apps.push(app); await app.register(cookie);
  await registerSolanaRpcRoutes(app, { ...TEST_CONFIG, RPC_RELAY_ENABLED: 'true', SOLANA_RPC_URL: upstream }, {} as Db, {
    admission: fakeAdmission(), authenticate: async (token) => {
      if (token !== 'active') throw Error('DATABASE-PRIVATE');
      return { sessionId: 'session-one', wallet: payer.publicKey.toBase58() };
    }, ...deps,
  });
  await app.ready(); return app;
}
function request(app: FastifyInstance, payload: unknown = call(), token?: string) {
  return app.inject({ method: 'POST', url: '/rpc/solana/devnet', headers: { 'content-type': 'application/json', origin, ...(token ? { cookie: `shardkeep_session=${token}` } : {}) }, payload: JSON.stringify(payload) });
}
function signed(versioned = true, signer = payer) {
  const instruction = SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: other.publicKey, lamports: 1 });
  if (!versioned) { const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(instruction); tx.sign(signer); return tx.serialize().toString('base64'); }
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions: [instruction] }).compileToV0Message());
  tx.sign([signer]); return Buffer.from(tx.serialize()).toString('base64');
}
async function provider() {
  const calls: RpcCall[] = []; let result: (rpc: RpcCall) => unknown = (rpc) => rpc.method === 'getBalance'
    ? { context: { slot: 12 }, value: 123 } : rpc.method === 'getLatestBlockhash'
      ? { context: { slot: 12 }, value: { blockhash, lastValidBlockHeight: 123 } } : null;
  const server = createServer((req, res) => {
    // ws removes its Upgrade listener during teardown. An accepted socket can
    // still deliver a late GET; only POST carries an HTTP JSON-RPC body.
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
    let body = ''; req.on('data', (part) => { body += String(part); }); req.on('end', () => {
      const rpc = JSON.parse(body) as RpcCall; calls.push(rpc);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: result(rpc) }));
    });
  }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw Error('address');
  const wss = new WebSocketServer({ server }); socketServers.push(wss); const peers: WebSocket[] = [];
  let next = 1;
  wss.on('connection', (socket) => {
    peers.push(socket); socket.on('error', () => undefined);
    socket.on('message', (bytes) => { const rpc = JSON.parse(String(bytes)) as RpcCall; calls.push(rpc);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: rpc.method.endsWith('Subscribe') ? next++ : true }));
    });
  });
  return { url: `http://127.0.0.1:${address.port}`, calls, peers, result: (next: typeof result) => { result = next; } };
}
async function connect(app: FastifyInstance, token?: string) {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  const ws = new WebSocket(address.replace('http:', 'ws:') + '/rpc/solana/devnet', { origin,
    ...(token ? { headers: { cookie: `shardkeep_session=${token}` } } : {}) });
  clients.push(ws); ws.on('error', () => undefined); await once(ws, 'open'); return ws;
}
async function rpcSocket(ws: WebSocket, payload: unknown) {
  const received = once(ws, 'message'); ws.send(JSON.stringify(payload));
  return JSON.parse(String((await received)[0])) as Record<string, unknown>;
}
afterEach(async () => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  clients.splice(0).forEach((ws) => ws.terminate());
  await Promise.all(apps.splice(0).map((app) => app.close()));
  socketServers.splice(0).forEach((server) => { server.clients.forEach((socket) => socket.terminate()); server.close(); });
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(admissions.splice(0).map((admission) => admission.close()));
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

describe('loopback provider lifecycle', () => {
  it('rejects a late WebSocket handshake after socket teardown without parsing it as an HTTP RPC body', async () => {
    const upstream = await provider();
    const port = Number(new URL(upstream.url).port);
    const socket = createConnection({ host: '127.0.0.1', port });
    try {
      await once(socket, 'connect');
      // Invalid unsubscribe is rejected locally before the upstream upgrade
      // has to finish. ws.close() removes its Upgrade listener while an already
      // accepted TCP socket may still deliver that empty-body GET.
      await new Promise<void>(resolve => socketServers.at(-1)!.close(() => resolve()));
      const response = once(socket, 'data', { signal: AbortSignal.timeout(RPC_RELAY_LIMITS.deadlineMs) });
      socket.end('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
      expect(String((await response)[0])).toMatch(/^HTTP\/1\.1 405 /);
      expect(upstream.calls).toEqual([]);
    } finally { socket.destroy(); }
  });
});

describe('protected browser RPC request boundary', () => {
  it.each(['getProgramAccounts', 'getAssetsByOwner', 'requestAirdrop', 'logsSubscribe', 'sendBundle', 'getTransaction'])('denies unneeded paid method %s', (method) => {
    expect(() => parseRpcCall(call(method))).toThrow('not available');
  });
  it.each([
    call('getBalance', ['bad']), call('getMultipleAccounts', [Array(101).fill(payer.publicKey.toBase58())]),
    call('sendTransaction', [signed(), { encoding: 'base64', maxRetries: 999 }]),
    call('getAccountInfo', [payer.publicKey.toBase58(), { url: 'https://attacker.invalid' }]),
    call('getLatestBlockhash', [{ minContextSlot: -1 }]), call('getTokenAccountsByOwner', [payer.publicKey.toBase58(), { mint: blockhash, programId: blockhash }]),
    { ...call(), id: null }, { ...call(), params: {} },
  ])('rejects malformed/cardinality-expanding input %#', (payload) => { expect(() => parseRpcCall(payload)).toThrow(); });
  it.each([true, false])('accepts canonical fully signed transaction, versioned=%s', async (versioned) => {
    await expect(verifyRelayTransaction(parseRpcCall(call('sendTransaction', [signed(versioned), { encoding: 'base64' }])), payer.publicKey.toBase58())).resolves.toBeUndefined();
  });
  it('checks every required signer as well as the payer', async () => {
    const tx = new Transaction({ feePayer: payer.publicKey, recentBlockhash: blockhash }).add(SystemProgram.transfer({ fromPubkey: other.publicKey, toPubkey: payer.publicKey, lamports: 1 }));
    tx.partialSign(payer);
    const wire = tx.serialize({ requireAllSignatures: false }).toString('base64');
    await expect(verifyRelayTransaction(parseRpcCall(call('sendTransaction', [wire, { encoding: 'base64' }])), payer.publicKey.toBase58())).rejects.toThrow('fully signed');
  });
  it('rejects a valid signature from a different session wallet', async () => {
    await expect(verifyRelayTransaction(parseRpcCall(call('sendTransaction', [signed(true, other), { encoding: 'base64' }])), payer.publicKey.toBase58())).rejects.toThrow('active wallet');
  });
  it('redacts arbitrary provider messages, nested data and thrown endpoint errors', () => {
    const raw = { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'PRIVATE-KEY', data: { endpoint: 'PRIVATE-KEY' } } };
    expect(sanitizeRpcResponse(raw, 1)).toEqual({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'RPC request was rejected' } });
    expect(JSON.stringify(rpcFailure(1, Error('PRIVATE-KEY')))).not.toContain('PRIVATE-KEY');
  });
});

describe('protected HTTP relay', () => {
  it('rejects empty or malformed browser POST JSON before it can reach the provider fixture', async () => {
    const upstream = await provider(); const app = await relay(upstream.url);
    for (const payload of ['', '{']) {
      const response = await app.inject({ method: 'POST', url: '/rpc/solana/devnet',
        headers: { 'content-type': 'application/json', origin }, payload });
      expect(response.statusCode).toBe(400);
    }
    // Do not turn a malformed forwarded POST into a tolerated teardown GET.
    // provider() still parses every POST strictly, so forwarding would fail loud.
    expect(upstream.calls).toEqual([]);
  });
  it('requires exact game Origin even without authentication, and no landing grant', async () => {
    const upstream = vi.fn<typeof fetch>(); const app = await relay(undefined, { fetch: upstream });
    for (const rejected of [undefined, 'https://pixelkingdomwars.com', origin + '.attacker.invalid']) {
      const response = await app.inject({ method: 'POST', url: '/rpc/solana/devnet', payload: call(), headers: rejected ? { origin: rejected } : {} });
      expect(response.statusCode).toBe(403);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
  it('is dark when disabled and cannot expose a second cluster path', async () => {
    const app = Fastify(); apps.push(app);
    await registerSolanaRpcRoutes(app, TEST_CONFIG, {} as Db);
    expect((await request(app)).statusCode).toBe(404);
    const enabled = await relay();
    expect((await enabled.inject({ method: 'POST', url: '/rpc/solana/mainnet-beta', payload: call(), headers: { origin } })).statusCode).toBe(404);
  });
  it('supports pre-auth wallet reads and simulation without a deed check', async () => {
    const upstream = await provider(); const app = await relay(upstream.url);
    upstream.result((rpc) => rpc.method === 'simulateTransaction' ? { context: { slot: 12 }, value: { err: null, logs: [], unitsConsumed: 1000 } } : { context: { slot: 12 }, value: 123 });
    expect((await request(app)).json().result.value).toBe(123);
    expect((await request(app, call('simulateTransaction', [signed(), { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }]))).statusCode).toBe(200);
    expect(upstream.calls).toHaveLength(2);
  });
  it('requires an active full session and matching signed payer before broadcasting', async () => {
    const upstream = await provider(); const app = await relay(upstream.url); const payload = call('sendTransaction', [signed(), { encoding: 'base64' }]);
    expect((await request(app, payload)).statusCode).toBe(401);
    expect((await request(app, payload, 'revoked')).statusCode).toBe(401);
    expect((await request(app, call('sendTransaction', [signed(true, other), { encoding: 'base64' }]), 'active')).statusCode).toBe(403);
    expect(upstream.calls).toHaveLength(0);
    expect((await request(app, payload, 'active')).statusCode).toBe(200); expect(upstream.calls).toHaveLength(1);
  });
  it('charges each batch item and prevents invalid later items sending earlier transactions', async () => {
    const upstream = await provider(); const admission = fakeAdmission(); const app = await relay(upstream.url, { admission });
    const batch = [call('sendTransaction', [signed(), { encoding: 'base64' }], 1), call('getProgramAccounts', [], 2)];
    expect((await request(app, batch, 'active')).statusCode).toBe(400); expect(upstream.calls).toHaveLength(0);
    expect((await request(app, [call('getBalance', [blockhash], 2), call('getBalance', [blockhash], 3)])).json()).toHaveLength(2);
    expect(vi.mocked(admission.charge).mock.calls.filter(([, cost]) => cost === 'read')).toHaveLength(2);
  });
  it('does not retry lost sends or forward browser headers; failures are sanitized', async () => {
    const upstream = vi.fn<typeof fetch>(async (_url, options) => {
      expect(options?.redirect).toBe('error'); expect(options?.headers).toEqual({ 'content-type': 'application/json' });
      throw Error('PRIVATE-DO-NOT-ECHO');
    });
    const app = await relay(undefined, { fetch: upstream });
    const response = await request(app, call('sendTransaction', [signed(), { encoding: 'base64' }]), 'active');
    expect(upstream).toHaveBeenCalledTimes(1); expect(response.body).not.toContain('PRIVATE'); expect(response.json().error.code).toBe(-32005);
  });
  it('bounds total response bytes even without a Content-Length header', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response('x'.repeat(RPC_RELAY_LIMITS.responseBytes + 1)));
    const response = await request(await relay(undefined, { fetch: upstream }));
    expect(response.json().error.code).toBe(-32005);
  });
  it('fails closed on quota-store outage before contacting the provider', async () => {
    const admission = fakeAdmission(); vi.mocked(admission.charge).mockRejectedValue(Error('REDIS-SECRET'));
    const upstream = vi.fn<typeof fetch>(); const response = await request(await relay(undefined, { admission, fetch: upstream }));
    expect(response.statusCode).toBe(503); expect(response.body).not.toContain('SECRET'); expect(upstream).not.toHaveBeenCalled();
  });
  it('cancels in-flight provider reads when the API shuts down', async () => {
    let upstreamSignal: AbortSignal | undefined;
    const upstream = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      upstreamSignal = options!.signal as AbortSignal;
      upstreamSignal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
    }));
    const admission = fakeAdmission(); const app = await relay(undefined, { admission, fetch: upstream });
    const pending = request(app); await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce());
    await app.close(); const response = await pending;
    expect(upstreamSignal?.aborted).toBe(true); expect(response.json().error.code).toBe(-32005);
    const lease = await vi.mocked(admission.acquire).mock.results[0]!.value; expect(lease.release).toHaveBeenCalledOnce();
  });
  it('rejects redirected providers without contacting the redirect destination', async () => {
    let redirected = 0; const destination = createServer((_req, res) => { redirected++; res.end('{}'); }); servers.push(destination);
    destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
    const destinationAddress = destination.address(); if (!destinationAddress || typeof destinationAddress === 'string') throw Error('address');
    const upstream = createServer((_req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${destinationAddress.port}/secret` }); res.end(); }); servers.push(upstream);
    upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
    const address = upstream.address(); if (!address || typeof address === 'string') throw Error('address');
    const response = await request(await relay(`http://127.0.0.1:${address.port}`));
    expect(response.json().error.code).toBe(-32005); expect(redirected).toBe(0);
  });
  it('bounds request, batch cardinality and aggregate batch responses', async () => {
    const upstream = await provider(); const app = await relay(upstream.url);
    expect((await request(app, Array.from({ length: 11 }, (_, i) => call('getBalance', [blockhash], i)))).statusCode).toBe(400);
    expect((await request(app, { ...call(), extra: 'x'.repeat(RPC_RELAY_LIMITS.requestBytes) })).statusCode).toBe(413);
    upstream.result(() => 'x'.repeat(300_000));
    const response = await request(app, [call('getBalance', [blockhash], 1), call('getBalance', [blockhash], 2)]);
    expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(RPC_RELAY_LIMITS.responseBytes);
    expect(response.json()[1].error.code).toBe(-32005);
  });
  it('bounds an unavailable provider by the ten-second deadline and releases admission', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const upstream = vi.fn<typeof fetch>(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true });
    }));
    const app = await relay(undefined, { fetch: upstream }); const response = request(app);
    await vi.waitFor(() => expect(upstream).toHaveBeenCalledOnce()); await vi.advanceTimersByTimeAsync(10_000);
    expect((await response).json().error.code).toBe(-32005); expect(upstream).toHaveBeenCalledOnce();
  });
  it('serves real web3 Connection balance/blockhash methods through its fetch transport', async () => {
    const upstream = await provider(); const app = await relay(upstream.url); const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const connection = new Connection(`${address}/rpc/solana/devnet`, { httpHeaders: { origin } });
    expect(await connection.getBalance(payer.publicKey)).toBe(123);
    expect(await connection.getLatestBlockhash()).toEqual({ blockhash, lastValidBlockHeight: 123 });
  });
});

describe('protected WebSocket relay', () => {
  it('real Kit wallet transport preserves u64 balances and completes simulation, send and signature subscription', async () => {
    const upstream = await provider(); upstream.result((rpc) => {
      if (rpc.method === 'getBalance') return { context: { slot: 12 }, value: (JSON as typeof JSON & { rawJSON(value: string): unknown }).rawJSON('9007199254740993') };
      if (rpc.method === 'getLatestBlockhash') return { context: { slot: 12 }, value: { blockhash, lastValidBlockHeight: 123 } };
      if (rpc.method === 'simulateTransaction') return { context: { slot: 12 }, value: { err: null, logs: [], unitsConsumed: 1000, returnData: null } };
      if (rpc.method === 'sendTransaction') return signature;
      return null;
    });
    const app = await relay(upstream.url); const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const originalFetch = globalThis.fetch;
    vi.stubGlobal('fetch', ((url, options) => {
      const headers = new Headers(options?.headers); headers.set('origin', origin); headers.set('cookie', 'shardkeep_session=active');
      return originalFetch(url, { ...options, headers });
    }) satisfies typeof fetch);
    // These headers model the browser's automatic Origin and same-origin cookie.
    // Keep Kit's actual protocol, bigint parser, subscription channel and abort.
    vi.stubGlobal('WebSocket', class BrowserSocket extends WebSocket {
      constructor(url: string | URL, protocols?: string | string[]) { super(url, protocols, { origin, headers: { cookie: 'shardkeep_session=active' } }); clients.push(this); }
    });
    const kit = await import('@solana/kit');
    const rpc = kit.createSolanaRpc(kit.devnet(`${address}/rpc/solana/devnet`));
    expect((await rpc.getBalance(kit.address(payer.publicKey.toBase58())).send()).value).toBe(9007199254740993n);
    expect((await rpc.getLatestBlockhash().send()).value.blockhash).toBe(blockhash);
    const wire = signed() as import('@solana/kit').Base64EncodedWireTransaction;
    expect((await rpc.simulateTransaction(wire, { encoding: 'base64', sigVerify: false, replaceRecentBlockhash: true }).send()).value.err).toBeNull();
    expect(await rpc.sendTransaction(wire, { encoding: 'base64', maxRetries: 0n }).send()).toBe(signature);
    const subscriptions = kit.createSolanaRpcSubscriptions(kit.devnet(`${address.replace('http:', 'ws:')}/rpc/solana/devnet`), { maxSubscriptionsPerChannel: 8, minChannels: 1 });
    const controller = new AbortController();
    const notifications = await subscriptions.signatureNotifications(kit.signature(signature), { commitment: 'confirmed' }).subscribe({ abortSignal: controller.signal });
    const received = notifications[Symbol.asyncIterator]().next();
    upstream.peers[0]!.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { subscription: 1, result: { context: { slot: 12 }, value: { err: null } } } }));
    expect((await received).value.value.err).toBeNull(); controller.abort();
    expect(upstream.calls.map((rpc) => rpc.method)).toContain('sendTransaction');
  });
  it('requires an upgrade and rejects bad origins before opening upstream sockets', async () => {
    const upstream = await provider(); const app = await relay(upstream.url);
    expect((await app.inject({ url: '/rpc/solana/devnet', headers: { origin } })).statusCode).toBe(426);
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const ws = new WebSocket(address.replace('http:', 'ws:') + '/rpc/solana/devnet', { origin: 'https://attacker.invalid' }); clients.push(ws);
    const [error] = await once(ws, 'error'); expect(String(error)).toContain('403'); expect(upstream.peers).toHaveLength(0);
  });
  it('subscribes immediately after upgrade, retains notification shape and keeps web3 ping local', async () => {
    const upstream = await provider(); const ws = await connect(await relay(upstream.url));
    const result = await rpcSocket(ws, call('signatureSubscribe', [signature, { commitment: 'confirmed' }])); expect(result.result).toBe(1);
    ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }));
    const received = once(ws, 'message');
    upstream.peers[0]!.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { subscription: 1, result: { context: { slot: 12 }, value: { err: null } } } }));
    expect(JSON.parse(String((await received)[0])).params.result.value.err).toBeNull();
    expect(upstream.calls.map((rpc) => rpc.method)).toEqual(['signatureSubscribe']);
  });
  it('cannot unsubscribe another connection’s subscription', async () => {
    const upstream = await provider(); const app = await relay(upstream.url); const ws = await connect(app);
    const result = await rpcSocket(ws, call('accountUnsubscribe', [77])); expect(result.error).toBeDefined(); expect(upstream.calls).toHaveLength(0);
  });
  it('caps subscriptions and clears upstream sockets / leases on disconnect', async () => {
    const upstream = await provider(); const admission = fakeAdmission(); const ws = await connect(await relay(upstream.url, { admission }));
    for (let i = 0; i < 8; i++) expect((await rpcSocket(ws, call('accountSubscribe', [blockhash], i))).result).toBe(i + 1);
    expect((await rpcSocket(ws, call('accountSubscribe', [blockhash], 8))).error).toBeDefined();
    const closed = once(upstream.peers[0]!, 'close'); ws.close(); await closed;
    const lease = await vi.mocked(admission.acquire).mock.results[0]!.value;
    expect(lease.release).toHaveBeenCalledOnce();
  });
  it('closes malformed upstream frames without exposing raw errors', async () => {
    const upstream = await provider(); const ws = await connect(await relay(upstream.url));
    await rpcSocket(ws, call('accountSubscribe', [blockhash]));
    const closed = once(ws, 'close'); upstream.peers[0]!.send('PRIVATE-CREDENTIAL-NOT-JSON'); await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('rechecks live session revocation while connected', async () => {
    const upstream = await provider(); let active = true;
    const app = await relay(upstream.url, { authenticate: async () => {
      if (!active) throw Error('revoked'); return { sessionId: 'session-one', wallet: payer.publicKey.toBase58() };
    } });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ws = await connect(app, 'active'); await rpcSocket(ws, call('accountSubscribe', [blockhash])); active = false;
    const closed = once(ws, 'close'); await vi.advanceTimersByTimeAsync(15_000); await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('closes a slow client when its outgoing buffer reaches the fixed bound', async () => {
    const upstream = await provider(); const app = await relay(upstream.url); const ws = await connect(app);
    await rpcSocket(ws, call('accountSubscribe', [blockhash]));
    const serverClient = [...app.websocketServer.clients][0]!;
    Object.defineProperty(serverClient, 'bufferedAmount', { value: RPC_RELAY_LIMITS.socketBufferBytes + 1 });
    const closed = once(ws, 'close');
    upstream.peers[0]!.send(JSON.stringify({ jsonrpc: '2.0', method: 'accountNotification', params: { subscription: 1, result: { context: { slot: 12 }, value: null } } }));
    await closed; expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('closes an existing connection if its shared lease cannot be renewed', async () => {
    const upstream = await provider(); const admission = fakeAdmission();
    vi.mocked(admission.acquire).mockResolvedValue({ release: async () => {}, renew: async () => { throw Error('Redis unavailable'); } });
    const app = await relay(upstream.url, { admission }); vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const ws = await connect(app); await rpcSocket(ws, call('accountSubscribe', [blockhash]));
    const closed = once(ws, 'close'); await vi.advanceTimersByTimeAsync(15_000); await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
  it('sanitizes WebSocket provider errors while retaining the numeric code', async () => {
    const upstream = await provider(); const ws = await connect(await relay(upstream.url));
    await rpcSocket(ws, call('accountSubscribe', [blockhash]));
    upstream.peers[0]!.removeAllListeners('message');
    upstream.peers[0]!.on('message', (bytes) => { const rpc = JSON.parse(String(bytes)) as RpcCall;
      upstream.peers[0]!.send(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'SECRET', data: { url: 'SECRET' } } }));
    });
    const result = await rpcSocket(ws, call('accountSubscribe', [blockhash], 2));
    expect(result.error).toEqual({ code: -32000, message: 'RPC request was rejected' });
  });
  it('real web3 signature confirmation completes without waiting for the HTTP poll', async () => {
    const upstream = await provider(); const app = await relay(upstream.url); const address = await app.listen({ port: 0, host: '127.0.0.1' });
    // web3's Node websocket constructor accepts headers; the real browser sends
    // Origin automatically. Its SDK remains responsible for resubscription.
    const connection = new Connection(`${address}/rpc/solana/devnet`, { httpHeaders: { origin }, wsEndpoint: `${address.replace('http:', 'ws:')}/rpc/solana/devnet`,
      // Node rpc-websockets does not propagate httpHeaders; inject the browser
      // Origin at the socket factory seam without replacing its RPC protocol.
    });
    const internal = connection as unknown as { _rpcWebSocket: { webSocketFactory: (url: string, options: object) => WebSocket; underlyingSocket?: WebSocket; close: () => void } };
    internal._rpcWebSocket.webSocketFactory = (url, options) => { const socket = new WebSocket(url, { ...options, origin }); clients.push(socket); internal._rpcWebSocket.underlyingSocket = socket; return socket; };
    const done = new Promise<void>((resolve) => { connection.onSignature(signature, (result) => { expect(result.err).toBeNull(); resolve(); }, 'confirmed'); });
    await vi.waitFor(() => expect(upstream.calls.some((rpc) => rpc.method === 'signatureSubscribe')).toBe(true));
    upstream.peers[0]!.send(JSON.stringify({ jsonrpc: '2.0', method: 'signatureNotification', params: { subscription: 1, result: { context: { slot: 12 }, value: { err: null } } } }));
    await done; internal._rpcWebSocket.close();
  });
});

describe('Redis admission shared by API instances', () => {
  async function shared() {
    const url = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380'; const redis = new Redis(url);
    await new Promise<void>((resolve, reject) => { if (redis.status === 'ready') resolve(); else { redis.once('ready', resolve); redis.once('error', reject); } });
    const cleanup = async () => { const keys = await redis.keys('pkw:{rpc-relay}:*'); if (keys.length) await redis.del(...keys); redis.disconnect(); };
    cleanups.push(cleanup); const keys = await redis.keys('pkw:{rpc-relay}:*'); if (keys.length) await redis.del(...keys);
    const first = new RedisRelayAdmission(url); const second = new RedisRelayAdmission(url); admissions.push(first, second);
    await pause(30); return { first, second, redis };
  }
  it('shares IP/socket leases across two instances, releases and expires crashed owners', async () => {
    const { first, second, redis } = await shared(); const identity = { ip: '127.1.1.1', sessionId: 'shared-session' };
    const one = await first.acquire(identity, 'ws'); await second.acquire(identity, 'ws');
    await expect(first.acquire(identity, 'ws')).rejects.toThrow('limit');
    await one.release(); const expired = await second.acquire(identity, 'ws');
    for (const key of await redis.keys('pkw:{rpc-relay}:lease:*')) {
      for (const id of await redis.zrange(key, 0, -1)) await redis.zadd(key, 0, id);
    }
    await expect(first.acquire(identity, 'ws')).resolves.toBeDefined();
    await expect(expired.renew()).rejects.toThrow('limit');
  });
  it('enforces a global upstream budget even when every request rotates IP', async () => {
    const { first, second, redis } = await shared();
    await redis.set('pkw:{rpc-relay}:rate:all', '5999', 'PX', 60000);
    await first.charge({ ip: '198.51.100.1' }, 'read');
    await expect(second.charge({ ip: '198.51.100.2' }, 'read')).rejects.toThrow('limit');
  });
  it('fails closed when Redis cannot be reached', async () => {
    const admission = new RedisRelayAdmission('redis://127.0.0.1:1'); admissions.push(admission);
    await expect(admission.acquire({ ip: '127.0.0.1' }, 'http')).rejects.toThrow('unavailable');
  });
});

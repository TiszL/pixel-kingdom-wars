import websocket from '@fastify/websocket';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import WebSocket, { type RawData } from 'ws';
import { SESSION_COOKIE, verifyActiveSession, type SessionIdentity } from './auth/session';
import type { Config } from './config';
import type { Db } from './db/client';
import {
  boundedRpcResponse, parseRpcCall, parseRpcJson, record, relayLimited, relayUnavailable, rpcCost, rpcFailure,
  RPC_RELAY_LIMITS as LIMITS, RpcRelayError, sanitizeRpcResponse, verifyRelayTransaction,
  type RpcCall, type RpcId,
} from './lib/solanaRpcRelay';
import { RedisRelayAdmission, type RelayAdmission, type RelayIdentity, type RelayLease } from './lib/solanaRpcRelayAdmission';

/** No production caller overrides these; transport tests use loopback providers
 * and a fake session authority instead of borrowing live credentials. */
export interface SolanaRpcRelayDeps {
  admission?: RelayAdmission;
  fetch?: typeof fetch;
  authenticate?: (token: string) => Promise<SessionIdentity>;
}
export async function registerSolanaRpcRoutes(app: FastifyInstance, config: Config, db: Db, deps: SolanaRpcRelayDeps = {}): Promise<void> {
  if (config.RPC_RELAY_ENABLED !== 'true') return;
  const admission = deps.admission ?? new RedisRelayAdmission(config.REDIS_URL);
  const upstreamFetch = deps.fetch ?? fetch;
  const authenticate = deps.authenticate ?? ((token: string) => verifyActiveSession(config, db, token));
  const upstream = new URL(config.SOLANA_RPC_URL);
  const upstreamWs = new URL(upstream); upstreamWs.protocol = upstream.protocol === 'https:' ? 'wss:' : 'ws:';
  // Explicit cluster component is required by wallet-standard / MWA discovery.
  const path = `/rpc/solana/${config.SOLANA_CLUSTER}`;
  const controllers = new Set<AbortController>(); const sockets = new Set<() => void>();
  let activeHttp = 0; let activeSockets = 0;
  const checkOrigin = (req: FastifyRequest) => {
    if (typeof req.headers.origin !== 'string' || !config.WEB_ORIGIN.includes(req.headers.origin)) {
      throw new RpcRelayError(403, -32600, 'RPC origin is not allowed');
    }
  };
  const identityFor = async (req: FastifyRequest): Promise<RelayIdentity> => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (!token) return { ip: req.ip };
    try { return { ip: req.ip, ...await authenticate(token) }; }
    catch { throw new RpcRelayError(401, -32001, 'RPC session expired; sign in again'); }
  };
  const rawSafeError = (req: FastifyRequest, error: unknown) => {
    // Only our own fixed fields reach structured logs. Never include err,
    // request.body, cookie, endpoint URL, transaction or provider response.
    if (!(error instanceof RpcRelayError) || error.status >= 500) {
      app.log.warn({ category: 'upstream_unavailable', transport: req.method === 'GET' ? 'ws' : 'http' }, 'RPC relay unavailable');
    }
  };
  app.addHook('preClose', async () => {
    for (const controller of controllers) controller.abort();
    for (const close of sockets) close();
  });
  app.addHook('onClose', async () => { await admission.close(); });
  await app.register(websocket, { options: { maxPayload: LIMITS.socketMessageBytes, perMessageDeflate: false } });

  app.post(path, { bodyLimit: LIMITS.requestBytes, config: { rateLimit: false }, onRequest: async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try { checkOrigin(req); }
    catch (error) { return reply.status(403).send(rpcFailure(null, error)); }
  } }, async (req, reply) => {
    if (activeHttp >= LIMITS.httpLocal) return reply.status(429).send(rpcFailure(null, relayLimited()));
    activeHttp++;
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), LIMITS.deadlineMs); timer.unref();
    const abort = () => { controller.abort(); };
    req.raw.on('aborted', abort); reply.raw.on('close', abort);
    let lease: RelayLease | undefined;
    try {
      // A cheap shared IP/global gate precedes database/signature work. Validated
      // sessions get their own additional budget, not exemption from this gate.
      await admission.charge({ ip: req.ip }, 'admission');
      const identity = await identityFor(req);
      const batch = Array.isArray(req.body);
      const values: unknown[] = batch ? req.body as unknown[] : [req.body];
      if (!values.length || values.length > LIMITS.batch) throw new RpcRelayError(400, -32600, 'Invalid RPC batch');
      const calls = values.map((value) => parseRpcCall(value));
      if (new Set(calls.map((call) => JSON.stringify(call.id))).size !== calls.length) throw new RpcRelayError(400, -32600, 'Duplicate RPC request id');
      lease = await admission.acquire(identity, 'http');
      for (const call of calls) {
        if (call.method === 'sendTransaction') {
          if (!identity.wallet) throw new RpcRelayError(401, -32001, 'Sign in before sending a transaction');
          await verifyRelayTransaction(call, identity.wallet);
        }
        await admission.charge(identity, rpcCost(call));
      }
      const responses: Record<string, unknown>[] = [];
      let responseBytes = 2;
      for (const call of calls) {
        try {
          if (controller.signal.aborted) throw relayUnavailable();
          // The only destination is the attested, operator-owned primary.
          // Never retry sendTransaction here, even after a lost response.
          const response = await upstreamFetch(upstream, {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(call),
            redirect: 'error', signal: controller.signal,
          });
          const safe = sanitizeRpcResponse(await boundedRpcResponse(response), call.id);
          const bytes = Buffer.byteLength(JSON.stringify(safe)) + 1;
          // Reserve room for a fixed error receipt for every remaining item.
          if (responseBytes + bytes > LIMITS.responseBytes - calls.length * 256) throw relayUnavailable();
          responseBytes += bytes; responses.push(safe);
        } catch (error) { rawSafeError(req, error); responses.push(rpcFailure(call.id, error)); }
      }
      return reply.send(batch ? responses : responses[0]);
    } catch (error) {
      rawSafeError(req, error);
      return reply.status(error instanceof RpcRelayError ? error.status : 503).send(rpcFailure(null, error));
    } finally {
      clearTimeout(timer); controllers.delete(controller); req.raw.off('aborted', abort); reply.raw.off('close', abort);
      await lease?.release(); activeHttp--;
    }
  });

  const admitted = new WeakMap<FastifyRequest, { identity: RelayIdentity; lease: RelayLease }>();
  app.get(path, { websocket: true, config: { rateLimit: false }, preValidation: async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    try {
      checkOrigin(req);
      if (req.headers.upgrade?.toLowerCase() !== 'websocket') throw new RpcRelayError(426, -32600, 'WebSocket upgrade required');
      if (activeSockets >= LIMITS.socketsLocal) throw relayLimited();
      activeSockets++;
      let lease: RelayLease | undefined;
      try {
        await admission.charge({ ip: req.ip }, 'connect');
        const identity = await identityFor(req);
        lease = await admission.acquire(identity, 'ws');
        if (req.raw.socket.destroyed) throw relayUnavailable();
        admitted.set(req, { identity, lease });
        req.raw.socket.once('close', () => {
          const abandoned = admitted.get(req);
          if (abandoned) { admitted.delete(req); activeSockets--; void abandoned.lease.release(); }
        });
      } catch (error) { activeSockets--; await lease?.release(); throw error; }
    } catch (error) {
      rawSafeError(req, error);
      return reply.status(error instanceof RpcRelayError ? error.status : 503).send(rpcFailure(null, error));
    }
  } }, (client, req) => {
    const entry = admitted.get(req); admitted.delete(req);
    if (!entry) { client.terminate(); return; }
    const { identity, lease } = entry;
    let closed = false; let queued = 0; let sequence = Promise.resolve(); let refreshing = false;
    let heartbeatAlive = true; let notificationCount = 0; let notificationMinute = Date.now();
    const pending = new Map<string, { call: RpcCall; subscription?: number; timer: ReturnType<typeof setTimeout> }>();
    const subscriptions = new Map<number, 'signature' | 'account'>();
    const close = () => {
      if (closed) return; closed = true; activeSockets--; sockets.delete(close);
      clearInterval(heartbeat); clearTimeout(lifetime);
      client.terminate(); provider.terminate();
      for (const item of pending.values()) clearTimeout(item.timer);
      pending.clear(); subscriptions.clear();
      void lease.release();
    };
    const provider = new WebSocket(upstreamWs, {
      followRedirects: false, handshakeTimeout: LIMITS.deadlineMs,
      maxPayload: LIMITS.upstreamMessageBytes, perMessageDeflate: false,
    });
    // Attach synchronously: wallet SDKs can send immediately after the upgrade.
    // A bounded serialized queue waits for upstream readiness; no event is lost.
    let openedResolve: () => void; let openedReject: () => void;
    const opened = new Promise<void>((resolve, reject) => { openedResolve = resolve; openedReject = () => reject(relayUnavailable()); });
    void opened.catch(() => undefined);
    provider.on('open', () => openedResolve());
    provider.on('error', () => { openedReject(); close(); });
    provider.on('close', () => { openedReject(); close(); });
    client.on('error', close); client.on('close', close);
    client.on('pong', () => { heartbeatAlive = true; });
    const heartbeat = setInterval(() => {
      if (refreshing) { close(); return; }
      refreshing = true;
      void (async () => {
        try {
          if (!heartbeatAlive) throw relayUnavailable(); heartbeatAlive = false;
          if (req.cookies?.[SESSION_COOKIE]) {
            const current = await authenticate(req.cookies[SESSION_COOKIE]);
            if (current.sessionId !== identity.sessionId || current.wallet !== identity.wallet) throw relayUnavailable();
          }
          await lease.renew(); if (!closed) client.ping();
        } catch { close(); } finally { refreshing = false; }
      })();
    }, LIMITS.heartbeatMs); heartbeat.unref();
    const lifetime = setTimeout(close, LIMITS.socketLifetimeMs); lifetime.unref(); sockets.add(close);
    const sendClient = (value: unknown) => {
      if (closed) return;
      if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > LIMITS.socketBufferBytes) { close(); return; }
      const encoded = JSON.stringify(value);
      if (Buffer.byteLength(encoded) + client.bufferedAmount > LIMITS.socketBufferBytes) { close(); return; }
      client.send(encoded, (error) => { if (error) close(); });
    };
    const enqueue = (work: () => Promise<void>) => {
      if (closed) return;
      if (++queued > LIMITS.pending) { close(); return; }
      sequence = sequence.then(async () => { if (!closed) await work(); }).catch(close).finally(() => { queued--; });
    };
    client.on('message', (data: RawData, binary: boolean) => enqueue(async () => {
      if (binary) { close(); return; }
      let value: unknown;
      try { value = JSON.parse(data.toString()) as unknown; } catch { close(); return; }
      // rpc-websockets sends this notification every five seconds. It is local
      // keepalive traffic, not a Solana RPC method or paid upstream request.
      if (record(value) && value.jsonrpc === '2.0' && value.method === 'ping' && !Object.hasOwn(value, 'id')) return;
      let call: RpcCall;
      try { call = parseRpcCall(value, true); }
      catch (error) { sendClient(rpcFailure(null, error)); close(); return; }
      const id = JSON.stringify(call.id);
      if (pending.has(id) || pending.size >= LIMITS.pending) { close(); return; }
      const subscribe = call.method.endsWith('Subscribe');
      if (subscribe && subscriptions.size + [...pending.values()].filter((item) => item.call.method.endsWith('Subscribe')).length >= LIMITS.subscriptions) {
        sendClient(rpcFailure(call.id, relayLimited())); return;
      }
      const subscription = subscribe ? undefined : Number(call.params[0]);
      if (subscription !== undefined && subscriptions.get(subscription) !== (call.method.startsWith('signature') ? 'signature' : 'account')) {
        sendClient(rpcFailure(call.id, new RpcRelayError(400, -32602, 'Unknown RPC subscription'))); return;
      }
      await admission.charge(identity, 'read'); await opened;
      if (closed || provider.readyState !== WebSocket.OPEN || provider.bufferedAmount > LIMITS.socketBufferBytes) { close(); return; }
      const timer = setTimeout(close, LIMITS.deadlineMs); timer.unref();
      pending.set(id, { call, timer, ...(subscription === undefined ? {} : { subscription }) });
      provider.send(JSON.stringify(call), (error) => { if (error) close(); });
    }));
    provider.on('message', (data: RawData, binary: boolean) => enqueue(async () => {
      if (binary) { close(); return; }
      const value = parseRpcJson(data.toString());
      if (!record(value) || value.jsonrpc !== '2.0') { close(); return; }
      if (Object.hasOwn(value, 'id')) {
        const id = JSON.stringify(value.id); const item = pending.get(id);
        if (!item) { close(); return; }
        const safe = sanitizeRpcResponse(value, item.call.id); clearTimeout(item.timer); pending.delete(id);
        if (Object.hasOwn(safe, 'result')) {
          if (item.subscription !== undefined) {
            if (typeof safe.result !== 'boolean') { close(); return; }
            if (safe.result) subscriptions.delete(item.subscription);
          } else {
            if (!Number.isSafeInteger(safe.result) || Number(safe.result) < 0 || subscriptions.has(Number(safe.result))) { close(); return; }
            subscriptions.set(Number(safe.result), item.call.method.startsWith('signature') ? 'signature' : 'account');
          }
        }
        sendClient(safe); return;
      }
      if (!record(value.params) || !Number.isSafeInteger(value.params.subscription)) { close(); return; }
      const subscription = Number(value.params.subscription); const type = subscriptions.get(subscription);
      if (!type || value.method !== `${type}Notification` || !Object.hasOwn(value.params, 'result')) { close(); return; }
      if (Date.now() - notificationMinute >= 60_000) { notificationMinute = Date.now(); notificationCount = 0; }
      if (++notificationCount > 1_000) { close(); return; }
      await admission.charge(identity, 'notification');
      sendClient({ jsonrpc: '2.0', method: value.method, params: { subscription, result: value.params.result } });
      // Signature subscriptions terminate after the final status, but not the
      // optional early "receivedSignature" notification used by some SDKs.
      if (type === 'signature' && record(value.params.result) && value.params.result.value !== 'receivedSignature') subscriptions.delete(subscription);
    }));
  });
}

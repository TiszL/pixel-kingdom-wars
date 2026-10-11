/**
 * /telemetry is a SINK (M23 a13): dark by default, never errors to a player,
 * and the pseudonymous identity boundary is what keeps raw wallets out of any
 * third-party vendor. The first pins protect exactly those three properties.
 *
 * The ARMED suite pins the 2026-09-05 relay audit fixes: Sentry events carry
 * what "resolve in next release" needs and group across deploys; vendor
 * rejections are counted instead of swallowed; SIGTERM drains; PostHog gets a
 * $pageview per app open, one aggregated error count per batch, and one
 * $identify per (wallet, device); the API's own 500s and failed jobs reach
 * Sentry under a token bucket.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import {
  analyticsId, flushTelemetry, identifyDevice, initTelemetry, normalizeMessage, normalizeSource,
  pageviewProps, parseStackFrames, relayClientError, relayServerError, relayStats, resetTelemetry, serverTrack,
} from '../src/telemetry';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

describe('POST /telemetry', () => {
  it('accepts a valid batch with 204 while relays are dark (no keys)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/telemetry',
      payload: {
        context: { sessionId: 'abc', buildVersion: '0.0.0-test', platform: 'desktop' },
        events: [
          { event: 'app_opened', eventId: 'e1', ts: new Date().toISOString() },
          { event: 'app_error', props: { message: 'boom', source: 'x.ts:1' } },
        ],
      },
    });
    expect(res.statusCode).toBe(204);
  });

  it('answers 204 for malformed bodies too — a sink must never error a player', async () => {
    for (const payload of [
      {},
      { events: 'nope' },
      { events: [{ event: '' }] },
      { events: Array.from({ length: 100 }, () => ({ event: 'flood' })) },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/telemetry', payload });
      expect(res.statusCode).toBe(204);
    }
  });
});

describe('authentication diagnostics', () => {
  it('retains only known phase categories, never extra signature or provider fields', async () => {
    const diagnosticApp = await buildApp(TEST_CONFIG, db);
    const records: unknown[][] = [];
    diagnosticApp.addHook('onRequest', (req, _reply, done) => {
      vi.spyOn(req.log, 'info').mockImplementation((...args: unknown[]) => { records.push(args); });
      done();
    });
    await diagnosticApp.ready();
    try {
      await diagnosticApp.inject({ method: 'POST', url: '/telemetry', payload: { events: [
        { event: 'auth_session_phase', props: { operation: 'cookie', phase: 'cleanup', reason: 'superseded_verification', signature: 'PRIVATE_SIGNATURE', provider: 'PRIVATE_PROVIDER' } },
        { event: 'auth_session_phase', props: { operation: 'cookie', phase: 'PRIVATE_SIGNATURE', reason: 'logout' } },
      ] } });
      const auth = records.filter((args) => args[1] === 'client authentication diagnostic');
      expect(auth).toHaveLength(1);
      expect(auth[0]![0]).toEqual({ telemetry: 'auth_session_phase', operation: 'cookie', phase: 'cleanup', reason: 'superseded_verification', authed: false });
      expect(JSON.stringify(auth)).not.toContain('PRIVATE');
    } finally { await diagnosticApp.close(); }
  });
});

describe('analyticsId', () => {
  it('is a stable pseudonym that never contains the wallet', () => {
    initTelemetry(TEST_CONFIG);
    const wallet = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';
    const id = analyticsId(wallet);
    expect(id).toBe(analyticsId(wallet)); // stable
    expect(id).toHaveLength(16);
    expect(wallet.includes(id)).toBe(false);
    expect(id.includes(wallet)).toBe(false);
    expect(analyticsId(null, 'sess')).toBe('anon:sess'); // pre-auth identity
  });

  it('prefers the persisted device id for anonymous events so a funnel survives a reload', () => {
    initTelemetry(TEST_CONFIG);
    // The per-tab session id is new on every reload; the device id is not, and
    // it is the anchor $identify later joins to the wallet (audit PA-01).
    expect(analyticsId(null, 'sess', 'device-1234')).toBe('anon:device-1234');
    // Caller-controlled text: anything not id-shaped falls back to the session.
    expect(analyticsId(null, 'sess', 'not an id!')).toBe('anon:sess');
  });
});

// ---------------------------------------------------------------------------
// Armed relays: fetch is stubbed, so every vendor call is observable.
// ---------------------------------------------------------------------------

const ARMED = {
  ...TEST_CONFIG,
  POSTHOG_API_KEY: 'phc_test_key_never_logged',
  SENTRY_DSN: 'https://sentrykey@o123.ingest.sentry.io/456',
};

type Call = { url: string; body: Record<string, unknown>; headers: Record<string, string> };

function fetchStub(status: () => number = () => 200) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(null, { status: status() });
  });
  return { fn, calls, posthog: () => calls.filter((c) => c.url.includes('/batch/')), sentry: () => calls.filter((c) => c.url.includes('/store/')) };
}

function posthogEvents(calls: Call[]): Array<{ event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }> {
  return calls.flatMap((c) => c.body['batch'] as Array<{ event: string; distinct_id: string; timestamp: string; properties: Record<string, unknown> }>);
}

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await flushTelemetry();
}

describe('armed relays', () => {
  let armed: FastifyInstance;
  let stub: ReturnType<typeof fetchStub>;
  let status = 200;

  beforeAll(async () => {
    armed = await buildApp(ARMED, db);
    armed.get('/__boom', async () => { throw new Error('kaboom in handler'); });
    await armed.ready();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await armed.close();
    // The shared dark app runs after this suite in file order; re-arm nothing.
    initTelemetry(TEST_CONFIG);
  });
  beforeEach(() => {
    status = 200;
    stub = fetchStub(() => status);
    vi.stubGlobal('fetch', stub.fn);
    initTelemetry(ARMED);
    resetTelemetry();
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('flushes only parsed authentication diagnostics and allowlisted context to PostHog', async () => {
    const eventId = 'fb911f26-8680-4f10-a4c1-240c546a2a13';
    const sessionId = 'f35ad68a-145a-4919-b70d-37fe8139b27d';
    const deviceId = '7d058b8c-5b07-4169-b59e-73e6a2e8df69';
    const ts = '2026-09-08T11:30:00.000Z';
    await armed.inject({ method: 'POST', url: '/telemetry', payload: {
      context: { sessionId, deviceId, platform: 'android', buildVersion: '0.3.3', gitSha: 'abcdef1', solanaMobile: true,
        signature: 'PRIVATE_CONTEXT_SIGNATURE', provider: 'PRIVATE_CONTEXT_PROVIDER' },
      events: [
        { event: 'auth_session_phase', eventId, ts, props: { operation: 'cookie', phase: 'cleanup', reason: 'superseded_verification', signature: 'PRIVATE_SIGNATURE', provider: 'PRIVATE_PROVIDER' } },
        { event: 'auth_session_phase', props: { operation: 'cookie', phase: 'PRIVATE_SIGNATURE', reason: 'logout' } },
        { event: 'auth_session_phase', eventId: 'PRIVATE_EVENT_ID', ts: 'PRIVATE_TIMESTAMP', props: { operation: 'session', phase: 'accepted' } },
      ],
    } });
    await settle();
    const events = posthogEvents(stub.posthog());
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: 'auth_session_phase', distinct_id: `anon:${deviceId}`, timestamp: ts,
      properties: { operation: 'cookie', phase: 'cleanup', reason: 'superseded_verification', platform: 'android',
        buildVersion: '0.3.3', gitSha: 'abcdef1', solanaMobile: true, source: 'client', is_internal: false, network: 'devnet', event_id: eventId } });
    expect(events[1]!.properties['event_id']).toBeUndefined();
    expect(events[1]!.timestamp).not.toBe('PRIVATE_TIMESTAMP');
    expect(JSON.stringify(stub.posthog())).not.toContain('PRIVATE');
  });

  it('Sentry client events carry release/env/event_id/user/tags/UA and a deploy-stable fingerprint', async () => {
    const res = await armed.inject({
      method: 'POST', url: '/telemetry',
      headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14) PKW-Test' },
      payload: {
        context: {
          sessionId: 'sess-1', deviceId: 'dev-11111111', buildVersion: '1.4.2',
          gitSha: 'abc1234', platform: 'android', solanaMobile: true,
        },
        events: [{
          event: 'app_error',
          props: {
            message: "TypeError: Cannot read properties of undefined (reading 'x') at https://play.pixelkingdomwars.com/assets/index-BQ3jK2sr.js:12:44",
            source: 'index-BQ3jK2sr.js:12', name: 'TypeError', count: 3,
          },
        }],
      },
    });
    expect(res.statusCode).toBe(204);
    await settle();
    const [post] = stub.sentry();
    expect(post).toBeDefined();
    expect(post!.headers['X-Sentry-Auth']).toContain('sentry_key=sentrykey');
    const body = post!.body;
    // "Resolve in next release" needs a release; it is the CLIENT bundle's sha,
    // never buildVersion (only Android shell releases bump that).
    expect(body['release']).toBe('pkw-web@abc1234');
    expect(body['dist']).toBe('1.4.2');
    expect(body['environment']).toBe('development'); // NODE_ENV=test is not production
    expect(body['event_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof body['timestamp']).toBe('string');
    expect(body['user']).toEqual({ id: 'anon:dev-11111111' });
    expect(body['tags']).toEqual({
      source: 'web-client', kind: 'error', platform: 'android', solanaMobile: 'true', buildVersion: '1.4.2',
    });
    expect(body['request']).toEqual({ headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) PKW-Test' } });
    expect(body['exception']).toMatchObject({ values: [{ type: 'TypeError' }] });
    // Grouping key survives a deploy: chunk hash, line/col and asset URL gone.
    expect(body['fingerprint']).toEqual([
      'error',
      "TypeError: Cannot read properties of undefined (reading 'x') at <url>",
      'index.js',
    ]);
    expect(body['culprit']).toBe('index.js');
    expect((body['extra'] as Record<string, unknown>)['count']).toBe(3);
    // The wallet never travels: only the pseudonym does.
    expect(JSON.stringify(body)).not.toContain('sentrykey=');
  });

  it('native error batches scrub identity and build context before both Sentry and the PostHog summary', async () => {
    const res = await armed.inject({ method: 'POST', url: '/telemetry', payload: {
      context: { platform: 'android-native', gitSha: 'PRIVATE_SHA', buildVersion: 'PRIVATE_VERSION',
        sessionId: 'PRIVATE_SESSION', deviceId: 'PRIVATE_DEVICE', wallet: 'PRIVATE_WALLET', token: 'PRIVATE_TOKEN' },
      events: [{ event: 'app_error', props: { code: 'NATIVE_STARTUP', message: 'PRIVATE_THROWABLE',
        source: 'PRIVATE_WALLET.kt:42', name: 'PRIVATE_CLASS', count: 1 } }],
    } });
    expect(res.statusCode).toBe(204); await settle();
    expect(stub.sentry()).toHaveLength(1);
    expect(stub.sentry()[0]!.body).toMatchObject({ release: 'pkw-native@unknown', user: { id: 'anon:unknown' },
      message: 'Native client startup failed', extra: { platform: 'android-native', count: 1 } });
    expect(posthogEvents(stub.posthog())).toEqual([expect.objectContaining({ event: 'client_errors', distinct_id: 'anon:unknown',
      properties: { count: 1, source: 'client', is_internal: false, network: 'devnet' } })]);
    expect(JSON.stringify(stub.calls)).not.toContain('PRIVATE');
  });

  it('relays bounded boot and restore diagnostics without admitting arbitrary props or context overrides', async () => {
    const diagnostics = {
      renderState: 'context-lost' as const, contextState: 'lost' as const, activeScene: 'battle' as const,
      sceneState: 'loading' as const, sceneActive: true, sceneVisible: false, stepAgeMs: 4, renderAgeMs: 5100,
      prepLoadProtocol: 'h3' as const, prepLoadReason: 'idle-timeout' as const, prepLoadAttempt: 3, prepLoadActiveMs: 120_000,
      prepPhase: 'terrain' as const, prepCompleted: 64, prepTotal: 256, prepCacheHit: true, prepWidth: 1536, prepHeight: 1536,
      prepDownloadMs: 100, prepVerifyMs: 12, prepDecodeMs: 33, prepPaintMs: 90, prepUploadMs: 7, prepMaxPaintBatchMs: 8,
      loadProfile: 'constrained', loadReason: 'active-deadline', loadAttempt: 2,
      loadActiveMs: 95_000, loadBudgetMs: 95_000, loadQueued: 3, loadInflight: 6, loadProcessing: 1,
      loadFirstReason: 'idle-timeout', loadFirstActiveMs: 42_000, loadFirstLoadedBytes: 1_800_000,
      loadFailures: 'warefallback-img:image:processing:16:200:500000/2880461;sprite-meta:json:queued:-:-:0/0',
      workerState: 'previous', restoreReason: 'timeout', restoreStage: 'base_snapshot', httpStatus: 503,
    };
    const res = await armed.inject({ method: 'POST', url: '/telemetry', payload: {
      context: { diagnostics: 'PRIVATE_CONTEXT_OVERRIDE', gitSha: 'abcdef1' },
      events: [{ event: 'app_error', props: {
        message: 'Required boot artwork failed', name: 'BootAssetLoadError', count: 2,
        ...diagnostics, wallet: 'PRIVATE_WALLET', response: 'PRIVATE_RESPONSE',
      } }],
    } });
    expect(res.statusCode).toBe(204);
    await settle();
    expect(stub.sentry()).toHaveLength(1);
    expect(stub.sentry()[0]!.body['extra']).toEqual({ gitSha: 'abcdef1', diagnostics, count: 2 });
    expect(JSON.stringify(stub.sentry())).not.toContain('PRIVATE');
    expect(posthogEvents(stub.posthog()).map(event => event.event)).toEqual(['client_errors']);
  });

  it('rejects invalid diagnostic fields individually while retaining the error and valid recovery categories', async () => {
    await armed.inject({ method: 'POST', url: '/telemetry', payload: {
      context: { diagnostics: 'PRIVATE_CONTEXT_OVERRIDE' },
      events: [{ event: 'app_error', props: {
        renderState: 'PRIVATE_STATE', contextState: 'PRIVATE_CONTEXT', activeScene: 'PRIVATE_SCENE',
        sceneState: 'PRIVATE_SCENE_STATE', sceneActive: 'PRIVATE_ACTIVE', sceneVisible: 1, stepAgeMs: -1, renderAgeMs: 600_001,
        prepLoadProtocol: 'PRIVATE_PROTOCOL', prepLoadReason: 'PRIVATE_REASON', prepLoadAttempt: 4, prepLoadActiveMs: 120_001,
        prepPhase: 'PRIVATE_PHASE', prepCompleted: -1, prepTotal: 100_000_001, prepCacheHit: 'PRIVATE_CACHE',
        prepWidth: 16385, prepHeight: 1.5, prepDownloadMs: -1, prepVerifyMs: 600_001,
        message: 'Base restore failed', loadProfile: 'PRIVATE_PROFILE', loadReason: 'PRIVATE_REASON',
        loadAttempt: 3, loadActiveMs: -1, loadBudgetMs: 600_001, loadQueued: 1_001,
        loadFirstReason: 'PRIVATE_REASON', loadFirstActiveMs: -1, loadFirstLoadedBytes: 100_000_001,
        loadInflight: 1.5, loadProcessing: -1, httpStatus: 600, workerState: 'PRIVATE_WORKER',
        loadFailures: 'https://private.invalid/wallet', restoreReason: 'request', restoreStage: 'raid_recovery',
      } }, { event: 'app_error', props: {
        message: 'Decode failed', loadFailures: 'bld-img:image:loading:12:200:100000001/100000000',
      } }],
    } });
    await settle();
    expect(stub.sentry()).toHaveLength(2);
    expect(stub.sentry()[0]!.body['extra']).toEqual({ diagnostics: { restoreReason: 'request', restoreStage: 'raid_recovery' } });
    expect(stub.sentry()[1]!.body['extra']).toEqual({});
    expect(JSON.stringify(stub.sentry())).not.toMatch(/PRIVATE|private\.invalid|100000001/);
  });

  it('unhandled rejections carry their code as a tag', async () => {
    await armed.inject({
      method: 'POST', url: '/telemetry',
      payload: {
        context: { sessionId: 's', gitSha: 'deadbee', platform: 'desktop' },
        events: [{ event: 'app_unhandled_rejection', props: { message: 'rpc failed', code: 'RPC_TIMEOUT' } }],
      },
    });
    await settle();
    const body = stub.sentry()[0]!.body;
    expect(body['tags']).toMatchObject({ kind: 'unhandledrejection', code: 'RPC_TIMEOUT' });
    expect(body['fingerprint']).toEqual(['unhandledrejection', 'rpc failed', '']);
  });

  it('counts a vendor rejection and warns ONCE a minute, never logging the key', async () => {
    status = 401;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    serverTrack('x', null, {}, { sessionId: 's' });
    serverTrack('y', null, {}, { sessionId: 's' });
    await flushTelemetry();
    serverTrack('z', null, {}, { sessionId: 's' });
    await flushTelemetry();
    // Two rejected batches (2 + 1 events), exactly one warning.
    expect(relayStats).toEqual({ sent: 0, rejected: 3, failed: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('posthog relay rejected batch');
    expect(warn.mock.calls[0]![1]).toEqual({ status: 401, n: 2 });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('phc_test_key');
    // A network failure is a different counter from a rejection.
    stub.fn.mockRejectedValueOnce(new Error('ECONNRESET'));
    serverTrack('w', null, {}, { sessionId: 's' });
    await flushTelemetry();
    expect(relayStats.failed).toBe(1);
  });

  it('Sentry rejections are counted too', async () => {
    status = 401;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    relayServerError(new Error('x'));
    await settle();
    expect(relayStats.rejected).toBe(1);
  });

  it('GET /health reports the relay counters', async () => {
    serverTrack('x', null, {}, { sessionId: 's' });
    await flushTelemetry();
    const res = await armed.inject({ url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().relay).toEqual({ sent: 1, rejected: 0, failed: 0 });
  });

  it('closing the app drains the buffer — a deploy SIGTERM must not lose the last 10 s', async () => {
    const closing = await buildApp(ARMED, db);
    await closing.ready();
    await closing.inject({
      method: 'POST', url: '/telemetry',
      payload: { context: { sessionId: 's' }, events: [{ event: 'tutorial_step', props: { step: 2 } }] },
    });
    expect(stub.posthog()).toHaveLength(0); // still buffered (10 s timer)
    await closing.close();
    expect(posthogEvents(stub.posthog()).map((e) => e.event)).toContain('tutorial_step');
  });

  it('emits one $pageview per app_opened at the configured web origin', async () => {
    await armed.inject({
      method: 'POST', url: '/telemetry',
      payload: {
        context: { sessionId: 'sess-2', deviceId: 'dev-22222222', platform: 'desktop' },
        events: [
          { event: 'app_opened', eventId: 'e1' },
          { event: 'tutorial_step', props: { step: 1 } },
          { event: 'tutorial_step', props: { step: 2 } },
        ],
      },
    });
    await flushTelemetry();
    const events = posthogEvents(stub.posthog());
    const pageviews = events.filter((e) => e.event === '$pageview');
    expect(pageviews).toHaveLength(1);
    expect(pageviews[0]!.properties).toMatchObject({
      $current_url: 'http://localhost:5173/', $host: 'localhost:5173', $pathname: '/', source: 'client',
    });
    // Anonymous identity is the DEVICE, not the per-tab session.
    expect(pageviews[0]!.distinct_id).toBe('anon:dev-22222222');
    expect(events.map((e) => e.event).sort()).toEqual(['$pageview', 'app_opened', 'tutorial_step', 'tutorial_step']);
  });

  it('aggregates client errors into one PostHog event per batch and never relays them individually', async () => {
    await armed.inject({
      method: 'POST', url: '/telemetry',
      payload: {
        context: { sessionId: 's', gitSha: 'abc1234' },
        events: [
          { event: 'app_error', props: { message: 'a' } },
          { event: 'app_error', props: { message: 'b' } },
          { event: 'app_unhandled_rejection', props: { message: 'c' } },
          { event: 'tutorial_step', props: { step: 1 } },
        ],
      },
    });
    await settle();
    const events = posthogEvents(stub.posthog());
    expect(events.filter((e) => e.event.startsWith('app_'))).toHaveLength(0);
    const agg = events.filter((e) => e.event === 'client_errors');
    expect(agg).toHaveLength(1);
    expect(agg[0]!.properties).toMatchObject({ count: 3, gitSha: 'abc1234' });
    // Sentry still sees each one (the reliability tier lives there).
    expect(stub.sentry()).toHaveLength(3);
  });

  it('a batch without errors emits no client_errors event', async () => {
    await armed.inject({
      method: 'POST', url: '/telemetry',
      payload: { context: { sessionId: 's' }, events: [{ event: 'tutorial_step' }] },
    });
    await flushTelemetry();
    expect(posthogEvents(stub.posthog()).map((e) => e.event)).toEqual(['tutorial_step']);
  });

  it('$identify joins anon:<deviceId> to the wallet pseudonym exactly once per pair', async () => {
    const wallet = '3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf';
    expect(identifyDevice(wallet, 'dev-33333333')).toBe(true);
    expect(identifyDevice(wallet, 'dev-33333333')).toBe(false); // idempotent
    expect(identifyDevice(wallet, 'dev-44444444')).toBe(true); // a second device is a new pair
    expect(identifyDevice(wallet, undefined)).toBe(false); // old clients send none
    expect(identifyDevice(wallet, 'nope!')).toBe(false); // caller-controlled text
    await flushTelemetry();
    const ids = posthogEvents(stub.posthog()).filter((e) => e.event === '$identify');
    expect(ids).toHaveLength(2);
    expect(ids[0]!.distinct_id).toBe(analyticsId(wallet));
    expect(ids[0]!.properties).toMatchObject({
      $anon_distinct_id: 'anon:dev-33333333', $set: { is_internal: false },
    });
    // Never the destructive merge, never the raw wallet.
    expect(JSON.stringify(ids)).not.toContain('$merge_dangerously');
    expect(JSON.stringify(ids)).not.toContain(wallet);
  });

  it('a signed-in /auth/verify with a deviceId emits the $identify after login_completed', async () => {
    const secretKey = utils.randomSecretKey();
    const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
    const ch = await armed.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
    expect(ch.statusCode).toBe(200);
    const { nonce, message } = ch.json() as { nonce: string; message: string };
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
    const res = await armed.inject({
      method: 'POST', url: '/auth/verify',
      payload: { wallet, nonce, signature, deviceId: 'dev-55555555' },
    });
    expect(res.statusCode).toBe(200);
    await flushTelemetry();
    const events = posthogEvents(stub.posthog()).map((e) => e.event);
    expect(events.indexOf('login_completed')).toBeGreaterThanOrEqual(0);
    expect(events.indexOf('$identify')).toBeGreaterThan(events.indexOf('login_completed'));
  });

  it("relays the API's own 500s to Sentry with release, exception frames and a pseudonym", async () => {
    const res = await armed.inject({ url: '/__boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { message: 'Internal Server Error' } }); // still opaque
    await settle();
    const [post] = stub.sentry();
    expect(post).toBeDefined();
    const body = post!.body;
    expect(body['platform']).toBe('node');
    expect(body['logger']).toBe('pkw-api');
    expect(body['release']).toBe('pkw-api@dev'); // BUILD.gitSha is 'dev' outside an image build
    expect(body['environment']).toBe('development');
    expect(body['event_id']).toMatch(/^[0-9a-f]{32}$/);
    expect(body['tags']).toMatchObject({ source: 'pkw-api', route: '/__boom', method: 'GET', statusCode: '500' });
    const exc = (body['exception'] as { values: Array<{ type: string; value: string; stacktrace?: { frames: unknown[] } }> }).values[0]!;
    expect(exc.type).toBe('Error');
    expect(exc.value).toBe('kaboom in handler');
    expect(exc.stacktrace!.frames.length).toBeGreaterThan(0);
    expect(exc.stacktrace!.frames.length).toBeLessThanOrEqual(10);
    expect(body['user']).toBeUndefined(); // anonymous request → no user block
  });

  it('client 4xx framework errors are NOT relayed — only the opaque 500 branch is', async () => {
    const res = await armed.inject({ method: 'POST', url: '/telemetry', payload: '{not json', headers: { 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(400);
    await settle();
    expect(stub.sentry()).toHaveLength(0);
  });

  it('server error relay is a 10/min token bucket and never throws', async () => {
    vi.useFakeTimers({ now: Date.UTC(2026, 8, 5, 12, 0, 0) });
    try {
      // beforeEach reset on the real clock. Rebase the bucket after installing
      // this fixed clock, or runs after this date move backwards and never refill.
      resetTelemetry();
      for (let i = 0; i < 25; i += 1) relayServerError(new Error(`e${i}`), { logger: 'pkw-worker', route: 'job:snapshot' });
      expect(stub.fn).toHaveBeenCalledTimes(10);
      vi.setSystemTime(Date.UTC(2026, 8, 5, 12, 0, 30)); // half a minute → 5 tokens back
      for (let i = 0; i < 25; i += 1) relayServerError(new Error('again'));
      expect(stub.fn).toHaveBeenCalledTimes(15);
      expect(() => relayServerError(undefined)).not.toThrow();
      expect(() => relayServerError('a string, not an Error')).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(stub.sentry()[0]!.body['logger']).toBe('pkw-worker');
    expect(stub.sentry()[0]!.body['tags']).toMatchObject({ source: 'pkw-worker', route: 'job:snapshot' });
  });

  it('relays only safe inventory stage, cause and numeric evidence alongside the job id', async () => {
    relayServerError(new Error('Founding verification unavailable'), { logger: 'pkw-worker', route: 'job:mint-evidence', reqId: 'mint-123',
      mintInventory: { reason: 'rpc_rate_limit', stage: 'assets', attempts: 3, contextRetries: 1, httpStatus: 429,
        rpcCode: -32016, beforeSlot: 100, assetCount: 93, afterSlot: Number.NaN, afterSize: -1,
        rpcUrl: 'https://private.invalid?token=secret', cause: { signedBody: 'private payload' }, wallet: 'raw-wallet' } });
    await settle();
    const body = stub.sentry()[0]!.body;
    expect(body['extra']).toEqual({ reqId: 'mint-123', mintInventory: { reason: 'rpc_rate_limit', stage: 'assets', attempts: 3,
      contextRetries: 1, httpStatus: 429, rpcCode: -32016, beforeSlot: 100, assetCount: 93 } });
    expect(JSON.stringify(body)).not.toMatch(/private.invalid|token=secret|signedBody|raw-wallet|private payload/);
  });
  it('bounds attempt diagnostics and strips credentials and provider data from every record', async () => {
    const record = { attempt: 1, stage: 'assets', durationMs: 125, reason: 'upstream_unknown', rpcCode: -32000,
      requestedContextSlot: 100, returnedContextSlot: -1, endpoint: 'https://PRIVATE_HOST', cause: 'PRIVATE_BODY' };
    relayServerError(new Error('Founding verification unavailable'), { mintInventory: { attemptLog: Array(20).fill(record) } });
    await settle();
    const body = stub.sentry()[0]!.body;
    expect(body['extra']).toEqual({ mintInventory: { attemptLog: Array(3).fill({ attempt: 1, stage: 'assets',
      durationMs: 125, reason: 'upstream_unknown', rpcCode: -32000, requestedContextSlot: 100 }) } });
    expect(JSON.stringify(body)).not.toContain('PRIVATE');
  });
  it('drops unrecognized inventory labels and stringified numbers instead of forwarding arbitrary metadata', async () => {
    relayServerError(new Error('Founding verification unavailable'), { mintInventory: {
      reason: 'private-message', stage: 'https://rpc.invalid', attempts: '3', cause: 'raw body', beforeSlot: Number.POSITIVE_INFINITY,
    } });
    await settle();
    expect(stub.sentry()[0]!.body['extra']).toBeUndefined();
  });
  it('is silent for both vendors when no keys are configured', async () => {
    initTelemetry(TEST_CONFIG);
    serverTrack('x', null, {}, { sessionId: 's' });
    relayServerError(new Error('x'));
    identifyDevice('3HaPGBPEuEtckbc7peEkNCXZKQTEyDqtmrfnM9bEbpLf', 'dev-66666666');
    await settle();
    expect(stub.fn).not.toHaveBeenCalled();
  });
});

describe('grouping normalizers', () => {
  it('strip Vite content hashes, line/col and URL paths from a source', () => {
    expect(normalizeSource('index-BQ3jK2sr.js:123')).toBe('index.js');
    expect(normalizeSource('https://play.pixelkingdomwars.com/assets/BaseScene-Cx_1aB2c.js:12:5')).toBe('BaseScene.js');
    expect(normalizeSource('mobilePhantomAdapter-Da3_kL9q.js:7')).toBe('mobilePhantomAdapter.js');
    expect(normalizeSource(':0')).toBe(''); // "Script error." has no source
    expect(normalizeSource(undefined)).toBe('');
    expect(normalizeSource('sw.js:1')).toBe('sw.js'); // no hash → untouched
  });

  it('strip URLs, chunk hashes, positions and long numbers from a message', () => {
    expect(normalizeMessage('Failed to fetch dynamically imported module: https://play.pixelkingdomwars.com/assets/menu-AbCd1234.js'))
      .toBe('Failed to fetch dynamically imported module: <url>');
    expect(normalizeMessage('boom in chunk-AbCd1234.js:10:2')).toBe('boom in chunk.js');
    expect(normalizeMessage('raid 1725500000 timed out')).toBe('raid <n> timed out');
    expect(normalizeMessage('Cannot read properties of undefined (reading \'x\')')).toBe('Cannot read properties of undefined (reading \'x\')');
  });

  it('parses V8 stack frames oldest-first, capped, paths only', () => {
    const stack = [
      'Error: kaboom',
      '    at handler (file:///app/apps/api/dist/app.js:310:11)',
      '    at async Object.run (/app/node_modules/fastify/lib/hooks.js:27:5)',
      '    at /app/node_modules/fastify/lib/route.js:100:3',
      'not a frame line',
    ].join('\n');
    const frames = parseStackFrames(stack);
    expect(frames).toEqual([
      { filename: '/app/node_modules/fastify/lib/route.js', lineno: 100, colno: 3 },
      { filename: '/app/node_modules/fastify/lib/hooks.js', lineno: 27, colno: 5, function: 'Object.run' },
      { filename: 'file:///app/apps/api/dist/app.js', lineno: 310, colno: 11, function: 'handler' },
    ]);
    expect(parseStackFrames(undefined)).toEqual([]);
    const deep = Array.from({ length: 30 }, (_, i) => `    at f${i} (/x/y.js:${i}:1)`).join('\n');
    expect(parseStackFrames(`Error\n${deep}`)).toHaveLength(10);
  });
});

describe('$pageview address', () => {
  it('is PLAY_URL when set — WEB_ORIGIN is the CORS allowlist and need not lead with the play origin', () => {
    // Production lists more than one credentialed origin; a $pageview filed
    // under the wrong host would leave PostHog's stock dashboards empty for
    // the real play address.
    expect(pageviewProps({
      WEB_ORIGIN: ['https://ops.example.com', 'https://play.pixelkingdomwars.com'],
      PLAY_URL: 'https://play.pixelkingdomwars.com',
    })).toEqual({
      $current_url: 'https://play.pixelkingdomwars.com/', $host: 'play.pixelkingdomwars.com', $pathname: '/',
    });
  });

  it('falls back to WEB_ORIGIN[0] for configs that never set PLAY_URL (local dev)', () => {
    expect(pageviewProps({ WEB_ORIGIN: ['http://localhost:5173'] })).toEqual({
      $current_url: 'http://localhost:5173/', $host: 'localhost:5173', $pathname: '/',
    });
  });

  it('keeps a path on PLAY_URL so PostHog path filters see the real landing route', () => {
    expect(pageviewProps({ WEB_ORIGIN: ['http://localhost:5173'], PLAY_URL: 'https://play.example.com/app' }))
      .toEqual({ $current_url: 'https://play.example.com/app', $host: 'play.example.com', $pathname: '/app' });
  });
});

// NATIVE_RELAY_PURE_START — this block also runs without API globalSetup while
// another source lane owns the shared disposable database.
describe('native client reliability attribution', () => {
  let stub: ReturnType<typeof fetchStub>;
  beforeEach(() => {
    stub = fetchStub(); vi.stubGlobal('fetch', stub.fn); initTelemetry(ARMED); resetTelemetry();
  });
  afterEach(async () => { await flushTelemetry(); vi.unstubAllGlobals(); resetTelemetry(); initTelemetry(TEST_CONFIG); });
  const context = { platform: 'android-native', gitSha: 'abcdef1234567890', buildVersion: '0.3.3-native:17', solanaMobile: true };
  const messages = {
    NATIVE_UNCAUGHT: 'Native client stopped unexpectedly', NATIVE_STARTUP: 'Native client startup failed',
    NATIVE_RENDER: 'Native rendering failed', NATIVE_SCREEN: 'Native screen action failed',
    // Wallet payment failure classes the native client reports (one per MWA error branch); an
    // unlisted code would collapse to NATIVE_ERROR and the Seeker triage would lose the branch.
    NATIVE_WALLET_ACCOUNT_MISMATCH: 'Wallet approved a different account',
    NATIVE_WALLET_AUTHORIZATION_FAILED: 'Wallet refused the saved authorization (MWA -1)',
    NATIVE_WALLET_INVALID_PAYLOADS: 'Wallet rejected the transaction payload (MWA -2)',
    NATIVE_WALLET_NOT_SIGNED: 'Wallet request declined (MWA -3)',
    NATIVE_WALLET_NOT_SUBMITTED: 'Wallet signed but did not submit (MWA -4)',
    NATIVE_WALLET_CLUSTER_NOT_SUPPORTED: 'Wallet does not support the cluster (MWA -7)',
    NATIVE_WALLET_SIGN_AND_SEND_UNSUPPORTED: 'Wallet does not implement sign-and-send',
    NATIVE_WALLET_METHOD_NOT_FOUND_SEND: 'Wallet does not implement sign-and-send (-32601)',
    NATIVE_WALLET_METHOD_NOT_FOUND_SIGN: 'Wallet does not implement sign-only (-32601)',
    NATIVE_WALLET_TX_VERSION_CHANGED: 'Wallet returned a different transaction version',
    NATIVE_WALLET_TX_SIGNERS_CHANGED: 'Wallet changed the transaction signers',
    NATIVE_WALLET_TX_BLOCKHASH_CHANGED: 'Wallet changed the recent blockhash',
    NATIVE_WALLET_TX_INSTRUCTIONS_CHANGED: 'Wallet changed the payment instructions',
    NATIVE_WALLET_TX_PRIORITY_FEE_TOO_HIGH: 'Wallet added a priority fee above the safety limit',
    NATIVE_WALLET_TX_BAD_SIGNATURE: 'Wallet signature does not verify',
    NATIVE_WALLET_FALLBACK_USED: 'Payment completed through the sign-only fallback',
    NATIVE_WALLET_FALLBACK_USED_COMPUTE_BUDGET: 'Sign-only fallback accepted added priority-fee instructions',
    NATIVE_WALLET_REMOTE_ERROR: 'Wallet returned another MWA error',
    NATIVE_WALLET_NOT_FOUND: 'No compatible wallet app answered',
    NATIVE_WALLET_TIMEOUT: 'Wallet did not answer in time',
    NATIVE_WALLET_INTERRUPTED: 'Wallet session cancelled or interrupted',
    NATIVE_WALLET_INVALID_RESPONSE: "Wallet reply failed the app's checks",
    NATIVE_WALLET_RPC_REJECTED: 'Relay rejected the signed transaction',
    NATIVE_WALLET_UNKNOWN: 'Wallet payment failed for an unclassified reason',
    // M45 §5 update-channel outcomes: an unlisted code collapses to NATIVE_ERROR and
    // triage loses which verify/install branch refused the update on the device.
    NATIVE_UPDATE_OFFERED: 'Update offered to the player',
    NATIVE_UPDATE_DOWNLOADED: 'Update package downloaded',
    NATIVE_UPDATE_VERIFIED: 'Update package verified',
    NATIVE_UPDATE_INSTALLED: 'Update installed',
    NATIVE_UPDATE_DECLINED: 'Player declined the update',
    NATIVE_UPDATE_FAILED_HASH: 'Update package hash did not match',
    NATIVE_UPDATE_FAILED_SIGNER: 'Update package signer did not match',
    NATIVE_UPDATE_FAILED_VERSION: 'Update package version was not newer',
    NATIVE_UPDATE_FAILED_PACKAGE: 'Update package name did not match',
    NATIVE_UPDATE_FAILED_ORIGIN: 'Update offer pointed at another origin',
    NATIVE_UPDATE_FAILED_NETWORK: 'Update download failed on the network',
    NATIVE_UPDATE_FAILED_STORAGE: 'Update download failed on storage',
    NATIVE_UPDATE_FAILED_PERMISSION: 'Install permission was not granted',
    NATIVE_UPDATE_FAILED_INSTALL: 'System installer refused the update',
    NATIVE_UPDATE_INSTALL_CANCELLED: 'Player cancelled the Android install dialog',
    NATIVE_UPDATE_FAILED_INSTALL_SESSION: 'Install session could not be created or committed',
    NATIVE_UPDATE_FAILED_INSTALL_BLOCKED: 'Android blocked the update install',
    NATIVE_UPDATE_FAILED_INSTALL_CONFLICT: 'Update conflicts with the installed package',
    NATIVE_UPDATE_FAILED_INSTALL_INCOMPATIBLE: 'Update is incompatible with the device',
    NATIVE_UPDATE_FAILED_INSTALL_INVALID: 'Android found the update file invalid',
    NATIVE_UPDATE_FAILED_INSTALL_STORAGE: 'Android had no space to install the update',
    NATIVE_UPDATE_FAILED_INSTALL_TIMEOUT: 'Android timed out installing the update',
  };
  for (const [code, message] of Object.entries(messages)) it(`${code} is attributed to the saved native binary with a fixed safe message`, async () => {
    relayClientError({ kind: 'error', code, message: 'PRIVATE_THROWABLE_TEXT', source: 'MainActivity.kt:42',
      name: 'PRIVATE_EXCEPTION', pseudonym: 'anon:unknown', count: 3, context });
    await settle(); const body = stub.sentry()[0]!.body;
    expect(body).toMatchObject({ platform: 'java', logger: 'pkw-native', release: 'pkw-native@abcdef1', dist: '0.3.3-native-17',
      message, user: { id: 'anon:unknown' }, tags: { source: 'android-native', platform: 'android-native', code },
      exception: { values: [{ type: 'NativeClientError', value: message }] },
      extra: { ...context, count: 3 } });
    expect(body['fingerprint']).toEqual(['error', code]);
    expect(body['culprit']).toBeUndefined(); expect(body['extra']).not.toHaveProperty('rawSource');
    expect(JSON.stringify(body)).not.toContain('PRIVATE'); expect(stub.posthog()).toHaveLength(0);
  });
  // Seeker incident 2026-09-18: three releases failed every payment and the branch that fired was
  // only in Sentry. The API log must keep the closed-vocabulary code and build, and nothing private.
  it('a native wallet code leaves one safe API log line, and a fallback success is not an error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      relayClientError({ kind: 'error', code: 'NATIVE_WALLET_NOT_SIGNED', message: 'PRIVATE_THROWABLE_TEXT', source: 'PRIVATE_SOURCE',
        pseudonym: 'anon:unknown', count: 2, context: { ...context, wallet: 'PRIVATE_WALLET' } });
      relayClientError({ kind: 'error', code: 'NATIVE_WALLET_FALLBACK_USED_COMPUTE_BUDGET', message: 'x', pseudonym: 'anon:unknown', context });
      relayClientError({ kind: 'error', code: 'NATIVE_RENDER', message: 'x', pseudonym: 'anon:unknown', context });
      await settle();
      const lines = warn.mock.calls.filter((call) => call[0] === '[native-wallet]');
      expect(lines).toHaveLength(2);
      expect(lines[0]![1]).toEqual({ code: 'NATIVE_WALLET_NOT_SIGNED', buildVersion: '0.3.3-native:17', gitSha: 'abcdef1', count: 2 });
      expect(JSON.stringify(lines)).not.toContain('PRIVATE');
      const levels = stub.sentry().map((event) => [event.body['tags'] && (event.body['tags'] as Record<string, string>)['code'], event.body['level']]);
      expect(levels).toEqual([['NATIVE_WALLET_NOT_SIGNED', 'error'], ['NATIVE_WALLET_FALLBACK_USED_COMPUTE_BUDGET', 'info'], ['NATIVE_RENDER', 'error']]);
    } finally { warn.mockRestore(); }
  });
  // Sentry 2026-09-27: a 0.6.0 "installer refused" was only in Sentry. Update failures leave the same
  // safe API log line as wallet failures; funnel markers and a cancelled dialog must not page as errors.
  it('a native update failure leaves one safe API log line, and funnel markers are not errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      relayClientError({ kind: 'error', code: 'NATIVE_UPDATE_FAILED_INSTALL_STORAGE', message: 'PRIVATE_THROWABLE_TEXT', source: 'PRIVATE_SOURCE',
        pseudonym: 'anon:unknown', count: 2, context: { ...context, wallet: 'PRIVATE_WALLET' } });
      relayClientError({ kind: 'error', code: 'NATIVE_UPDATE_OFFERED', message: 'x', pseudonym: 'anon:unknown', context });
      relayClientError({ kind: 'error', code: 'NATIVE_UPDATE_INSTALL_CANCELLED', message: 'x', pseudonym: 'anon:unknown', context });
      relayClientError({ kind: 'error', code: 'NATIVE_UPDATE_FAILED_INSTALL', message: 'x', pseudonym: 'anon:unknown', context });
      await settle();
      const lines = warn.mock.calls.filter((call) => call[0] === '[native-update]');
      expect(lines.map((call) => call[1])).toEqual([
        { code: 'NATIVE_UPDATE_FAILED_INSTALL_STORAGE', buildVersion: '0.3.3-native:17', gitSha: 'abcdef1', count: 2 },
        { code: 'NATIVE_UPDATE_FAILED_INSTALL', buildVersion: '0.3.3-native:17', gitSha: 'abcdef1' },
      ]);
      expect(JSON.stringify(lines)).not.toContain('PRIVATE');
      const levels = stub.sentry().map((event) => [(event.body['tags'] as Record<string, string>)['code'], event.body['level']]);
      expect(levels).toEqual([['NATIVE_UPDATE_FAILED_INSTALL_STORAGE', 'error'], ['NATIVE_UPDATE_OFFERED', 'info'],
        ['NATIVE_UPDATE_INSTALL_CANCELLED', 'info'], ['NATIVE_UPDATE_FAILED_INSTALL', 'error']]);
    } finally { warn.mockRestore(); }
  });
  it('native context and source cannot carry credentials, stacks, identities or URL parameters', async () => {
    relayClientError({ kind: 'error', message: 'PRIVATE_MESSAGE', source: '/private/path/MainActivity.kt:42?token=PRIVATE_TOKEN',
      name: 'PRIVATE_NAME', code: 'PRIVATE_CODE', count: Infinity, pseudonym: 'anon:PRIVATE_SESSION', userAgent: 'PRIVATE_USER_AGENT',
      context: { platform: 'android-native', gitSha: 'PRIVATE_SHA', buildVersion: 'https://private.invalid/token',
        sessionId: 'PRIVATE_SESSION', deviceId: 'PRIVATE_DEVICE', wallet: 'PRIVATE_WALLET', cookie: 'PRIVATE_COOKIE',
        signature: 'PRIVATE_SIGNATURE', token: 'PRIVATE_TOKEN', diagnostics: { secret: 'PRIVATE_DIAGNOSTIC' } } });
    await settle(); const body = stub.sentry()[0]!.body;
    expect(body).toMatchObject({ message: 'Native client error', release: 'pkw-native@unknown', user: { id: 'anon:unknown' },
      extra: { platform: 'android-native' }, tags: { code: 'NATIVE_ERROR' } });
    expect(body['dist']).toBeUndefined(); expect(body['request']).toBeUndefined(); expect(body['culprit']).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE|private\.invalid/);
  });
  it('all native sources are discarded, including valid-looking filenames which could encode private data', async () => {
    const sources = ['PRIVATE_WALLET.kt:42', 'MainActivity.kt:42', 'gg.pixelkingdomwars.MainActivity.kt:42',
      'MainActivity.onCreate:42', 'MainActivity.kt:42\nat Secret.kt:1', 'MainActivity.kt:-1'];
    for (const source of sources) relayClientError({ kind: 'error', code: 'NATIVE_RENDER', message: 'ignored', source, pseudonym: 'anon:unknown', context });
    await settle(); expect(stub.sentry()).toHaveLength(sources.length);
    for (const event of stub.sentry()) {
      expect(event.body['culprit']).toBeUndefined(); expect(event.body['extra']).not.toHaveProperty('rawSource');
    }
    expect(JSON.stringify(stub.sentry())).not.toMatch(/PRIVATE|MainActivity|Secret\.kt/);
  });
  it('native dev and unknown releases remain explicit and valid server HMAC identities stay pseudonymous', async () => {
    for (const gitSha of ['dev', 'unknown']) relayClientError({ kind: 'error', code: 'NATIVE_STARTUP', message: 'ignored',
      pseudonym: 'aabbccddeeff0011', context: { ...context, gitSha } });
    await settle();
    expect(stub.sentry().map(post => post.body['release'])).toEqual(['pkw-native@dev', 'pkw-native@unknown']);
    expect(stub.sentry()[0]!.body['user']).toEqual({ id: 'aabbccddeeff0011' });
  });
  it('an Android browser keeps the existing web release, platform, text and extras contract', async () => {
    relayClientError({ kind: 'error', message: 'Existing web error', name: 'TypeError', source: 'index-abcdefgh.js:7',
      pseudonym: 'anon:browser', context: { ...context, platform: 'android', custom: 'existing' }, userAgent: 'Browser UA' });
    await settle(); const body = stub.sentry()[0]!.body;
    expect(body).toMatchObject({ platform: 'javascript', logger: 'pkw-client', release: 'pkw-web@abcdef1', message: 'Existing web error',
      tags: { source: 'web-client', platform: 'android' }, extra: { platform: 'android', custom: 'existing' },
      request: { headers: { 'User-Agent': 'Browser UA' } } });
  });
});

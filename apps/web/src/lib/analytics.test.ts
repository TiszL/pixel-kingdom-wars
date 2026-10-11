/** @vitest-environment happy-dom */
/**
 * The client error tier exists to tell the operator about bugs, not about
 * deploys. Every deploy manufactures chunk-load failures and maintenance
 * rejections on stale tabs; browsers manufacture "Script error." and
 * ResizeObserver noise; wallets manufacture cancellations. Relaying all of it
 * 1:1 turned Sentry mail into the thing the owner ignores (audit 2026-09-05
 * SENTRY-04/05/06). These pins keep the denylist, the per-session dedupe, the
 * deploy-stable source and the device identity honest.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({ API_URL: 'http://api.test' }));
vi.mock('./version', () => ({
  BUILD: { version: '1.4.2', gitSha: 'abcdef0123456', builtAt: null, simVersion: 14 },
}));

type Analytics = typeof import('./analytics');

async function fresh(): Promise<Analytics> {
  vi.resetModules();
  return import('./analytics');
}

interface Sent { context: Record<string, unknown>; events: Array<{ event: string; props?: Record<string, unknown> }> }

function sentBodies(fetchMock: ReturnType<typeof vi.fn>): Sent[] {
  return fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Sent);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('shouldReport denylist', () => {
  it.each([
    // [kind, message, source, code, name, expected]
    ['error', 'Script error.', ':0', undefined, undefined, false],
    ['error', 'Script error.', undefined, undefined, undefined, false],
    ['error', 'ResizeObserver loop completed with undelivered notifications.', 'index.js:1', undefined, undefined, false],
    ['error', 'ResizeObserver loop limit exceeded', 'index.js:1', undefined, undefined, false],
    ['unhandledrejection', 'fetch failed', undefined, 'NETWORK_UNAVAILABLE', undefined, false],
    ['unhandledrejection', 'down for deploy', undefined, 'MAINTENANCE', undefined, false],
    ['unhandledrejection', 'User rejected the request.', undefined, '4001', undefined, false],
    ['unhandledrejection', 'The user rejected the request', undefined, undefined, undefined, false],
    ['unhandledrejection', 'Transaction cancelled', undefined, undefined, undefined, false],
    ['unhandledrejection', 'signature request canceled by user', undefined, undefined, undefined, false],
    ['unhandledrejection', 'Permission denied', undefined, undefined, undefined, false],
    ['unhandledrejection', 'The operation was aborted', undefined, undefined, 'AbortError', false],
    ['unhandledrejection', 'AbortError: signal is aborted without reason', undefined, undefined, undefined, false],
    ['unhandledrejection', 'Failed to fetch dynamically imported module: https://play.pixelkingdomwars.com/assets/menu-AbCd1234.js', undefined, undefined, undefined, false],
    ['unhandledrejection', 'error loading dynamically imported module', undefined, undefined, undefined, false],
    ['error', 'Importing a module script failed.', 'index.js:1', undefined, undefined, false],
    // Real bugs still report — including "Script error." WITH a source.
    ['error', "Cannot read properties of undefined (reading 'x')", 'BaseScene.js:12', undefined, 'TypeError', true],
    ['error', 'Script error.', 'index.js:4', undefined, undefined, true],
    ['unhandledrejection', 'rpc timeout', undefined, 'RPC_TIMEOUT', undefined, true],
    ['unhandledrejection', 'raid not found', undefined, undefined, 'ApiError', true],
  ] as const)('%s %j (source=%s code=%s name=%s) → %s', async (kind, message, source, code, name, expected) => {
    const { shouldReport } = await fresh();
    expect(shouldReport(kind, message, source, code, name)).toBe(expected);
  });
});

describe('stripChunkHash', () => {
  it('drops the Vite content hash but keeps the chunk name and line', async () => {
    const { stripChunkHash } = await fresh();
    expect(stripChunkHash('index-BQ3jK2sr.js:12')).toBe('index.js:12');
    expect(stripChunkHash('BaseScene-Cx_1aB2c.js:12:5')).toBe('BaseScene.js:12:5');
    expect(stripChunkHash('sw.js:1')).toBe('sw.js:1');
    expect(stripChunkHash('react-boundary')).toBe('react-boundary');
    expect(stripChunkHash(':0')).toBe(':0');
  });
});

describe('per-session dedupe', () => {
  it('retains bounded boot diagnostics on the first error and its deduplicated repeat', async () => {
    const a = await fresh();
    const diagnostics = {
      renderState: 'context-lost' as const, contextState: 'lost' as const, activeScene: 'battle' as const,
      sceneState: 'loading' as const, sceneActive: true, sceneVisible: false, stepAgeMs: 4, renderAgeMs: 5100,
      prepLoadProtocol: 'h3' as const, prepLoadReason: 'idle-timeout' as const, prepLoadAttempt: 3, prepLoadActiveMs: 120_000,
      prepPhase: 'terrain' as const, prepCompleted: 64, prepTotal: 256, prepCacheHit: true, prepWidth: 1536, prepHeight: 1536,
      prepDownloadMs: 100, prepVerifyMs: 12, prepDecodeMs: 33, prepPaintMs: 90, prepUploadMs: 7, prepMaxPaintBatchMs: 8,
      loadProfile: 'constrained' as const, loadReason: 'idle-timeout' as const, loadAttempt: 2,
      loadActiveMs: 21_000, loadBudgetMs: 95_000, loadQueued: 3, loadInflight: 6, loadProcessing: 1,
      loadFirstReason: 'idle-timeout' as const, loadFirstActiveMs: 42_000, loadFirstLoadedBytes: 1_800_000,
      loadFailures: 'warefallback-img:image:processing:16:200:500000/2880461', workerState: 'current' as const,
    };
    a.captureError('error', { message: 'Required art failed', name: 'BootAssetLoadError', diagnostics });
    a.captureError('error', { message: 'Required art failed', diagnostics: { workerState: 'previous' } });
    await vi.advanceTimersByTimeAsync(15_000);
    const events = sentBodies(fetchMock)[0]!.events;
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.props).toMatchObject({ ...diagnostics, count: 1 });
    expect(events.every(event => event.props?.['diagnostics'] === undefined)).toBe(true);
  });

  it('drops arbitrary identities and invalid diagnostic values before enqueueing', async () => {
    const a = await fresh();
    a.captureError('error', {
      message: 'Restore failed', diagnostics: {
        renderState: 'PRIVATE_STATE', contextState: 'PRIVATE_CONTEXT', activeScene: 'PRIVATE_SCENE',
        sceneState: 'PRIVATE_SCENE_STATE', sceneActive: 'PRIVATE_ACTIVE', sceneVisible: 1, stepAgeMs: -1, renderAgeMs: 600_001,
        prepLoadProtocol: 'PRIVATE_PROTOCOL', prepLoadReason: 'PRIVATE_REASON', prepLoadAttempt: 4, prepLoadActiveMs: 120_001,
        prepPhase: 'PRIVATE_PHASE', prepCompleted: -1, prepTotal: 100_000_001, prepCacheHit: 'PRIVATE_CACHE',
        prepWidth: 16385, prepHeight: 1.5, prepDownloadMs: -1, prepVerifyMs: 600_001,
        loadProfile: 'PRIVATE_PROFILE', loadAttempt: 3, loadActiveMs: -1, loadInflight: 1.5,
        loadFirstReason: 'PRIVATE_REASON', loadFirstActiveMs: -1, loadFirstLoadedBytes: 100_000_001,
        loadFailures: 'https://private.invalid/wallet', wallet: 'PRIVATE_WALLET',
        restoreReason: 'request', restoreStage: 'base_snapshot', httpStatus: 503,
      } as unknown as Parameters<Analytics['captureError']>[1]['diagnostics'],
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sentBodies(fetchMock)[0]!.events[0]!.props).toEqual({
      message: 'Restore failed', count: 1, restoreReason: 'request', restoreStage: 'base_snapshot', httpStatus: 503,
    });
    expect(JSON.stringify(sentBodies(fetchMock))).not.toMatch(/PRIVATE|private\.invalid/);
  });

  it('sends the first occurrence at once and one counted event per flush for repeats', async () => {
    const a = await fresh();
    for (let i = 0; i < 3; i += 1) {
      a.captureError('error', { message: 'boom', source: 'index-BQ3jK2sr.js:12', name: 'TypeError' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [batch] = sentBodies(fetchMock);
    expect(batch!.events.map((e) => [e.event, e.props?.['count'], e.props?.['source']])).toEqual([
      ['app_error', 1, 'index.js:12'],
      ['app_error', 2, 'index.js:12'],
    ]);
    expect(batch!.events[0]!.props).toMatchObject({ message: 'boom', name: 'TypeError' });
    // A render loop between flushes costs ONE event, however many throws.
    for (let i = 0; i < 60; i += 1) a.captureError('error', { message: 'boom', source: 'index-Zz9yX8wV.js:12' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const second = sentBodies(fetchMock)[1]!;
    expect(second.events).toHaveLength(1);
    expect(second.events[0]!.props?.['count']).toBe(60);
    // A different source is a different key.
    a.captureError('error', { message: 'boom', source: 'menu-AbCd1234.js:3' });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sentBodies(fetchMock)[2]!.events).toEqual([
      expect.objectContaining({ event: 'app_error', props: expect.objectContaining({ source: 'menu.js:3', count: 1 }) }),
    ]);
  });

  it('never enqueues a denylisted error', async () => {
    const a = await fresh();
    a.captureError('error', { message: 'Script error.', source: ':0' });
    a.captureError('unhandledrejection', { message: 'user rejected the request', code: '4001' });
    a.captureError('unhandledrejection', { message: 'Failed to fetch dynamically imported module: x.js' });
    // The game boundary's stale-bundle case: the message decides, not the name.
    a.captureError('error', {
      message: 'Failed to fetch dynamically imported module: https://play.pixelkingdomwars.com/assets/PhaserGame-AbCd1234.js',
      name: 'TypeError', source: 'react-boundary', boundary: 'game',
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits a drained batch so the server cap of 40 events is never exceeded', async () => {
    const a = await fresh();
    for (let i = 0; i < 45; i += 1) a.captureError('error', { message: `e${i}`, source: 'x.js:1' });
    await vi.advanceTimersByTimeAsync(15_000);
    for (const b of sentBodies(fetchMock)) expect(b.events.length).toBeLessThanOrEqual(40);
    expect(sentBodies(fetchMock).reduce((n, b) => n + b.events.length, 0)).toBe(45);
  });
});

describe('window listeners', () => {
  it('handleErrorEvent sends basename:line, name and code — never the stack', async () => {
    const a = await fresh();
    const error = Object.assign(new TypeError('x is undefined'), { code: 'E_X' });
    a.handleErrorEvent({
      message: 'Uncaught TypeError: x is undefined',
      filename: 'https://play.pixelkingdomwars.com/assets/BattleScene-Cx_1aB2c.js', lineno: 77, error,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    const ev = sentBodies(fetchMock)[0]!.events[0]!;
    expect(ev.event).toBe('app_error');
    expect(ev.props).toEqual({
      message: 'Uncaught TypeError: x is undefined', source: 'BattleScene.js:77', name: 'TypeError', code: 'E_X', count: 1,
    });
    expect(JSON.stringify(ev)).not.toContain('at ');
  });

  it('handleRejectionEvent drops maintenance-window rejections and keeps real ones', async () => {
    const a = await fresh();
    a.handleRejectionEvent({ reason: Object.assign(new Error('503'), { code: 'MAINTENANCE' }) });
    a.handleRejectionEvent({ reason: Object.assign(new Error('raid not found'), { name: 'ApiError', code: 'RAID_NOT_FOUND' }) });
    a.handleRejectionEvent({ reason: 'a bare string reason' });
    await vi.advanceTimersByTimeAsync(15_000);
    const events = sentBodies(fetchMock)[0]!.events;
    expect(events.map((e) => e.props?.['message'])).toEqual(['raid not found', 'a bare string reason']);
    expect(events[0]!.props).toMatchObject({ name: 'ApiError', code: 'RAID_NOT_FOUND' });
  });

  it.each([
    ['Error: boom\n    at load (https://user:secret@play.test/private/assets/index-BQ3jK2sr.js?token=secret#private:12:4)', 'index.js:12:4'],
    ['load@https://play.test/private/audio.mjs?wallet=secret:45:6', 'audio.mjs:45:6'],
    ['Error: boom\n    at chrome-extension://private-extension-id/scripts/inpage.js:7:8', 'inpage.js:7:8'],
  ])('keeps one original rejection location without leaking its URL (%s)', async (stack, source) => {
    const a = await fresh();
    a.handleRejectionEvent({ reason: { message: 'boom', stack } });
    await vi.advanceTimersByTimeAsync(15_000);
    const event = sentBodies(fetchMock)[0]!.events[0]!;
    expect(event.props).toEqual({ message: 'boom', source, count: 1 });
    for (const privatePart of ['secret', 'private', 'https:', 'chrome-extension:', 'load@', ' at ']) {
      expect(JSON.stringify(event)).not.toContain(privatePart);
    }
  });

  it.each([
    'Error: https://private.test/message.js:1:2',
    '    at eval (eval at load (https://private.test/index.js:1:2), <anonymous>:3:4)',
    '    at blob:https://private.test/secret.js:1:2',
    '    at data:text/javascript,secret.js:1:2',
    '    at file:///private/user/secret.js:1:2',
  ])('does not treat messages or unsafe frames as rejection evidence (%s)', async (stack) => {
    const a = await fresh();
    a.handleRejectionEvent({ reason: { message: 'boom', stack } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sentBodies(fetchMock)[0]!.events[0]!.props).toEqual({ message: 'boom', count: 1 });
  });

  it('does not invent a source for primitive rejections or throw while inspecting hostile properties', async () => {
    const a = await fresh();
    for (const reason of ['bare string', null, 42]) a.handleRejectionEvent({ reason });
    const reason = { message: 'no stack', get stack(): never { throw new Error('blocked getter'); } };
    expect(() => a.handleRejectionEvent({ reason })).not.toThrow();
    expect(() => a.handleRejectionEvent({ reason: { get message(): never { throw new Error('blocked'); } } })).not.toThrow();
    await vi.advanceTimersByTimeAsync(15_000);
    const events = sentBodies(fetchMock)[0]!.events;
    expect(events.map(e => e.props?.['message'])).toEqual(['bare string', '', '42', 'no stack', 'Unknown rejection']);
    expect(events.every(e => !Object.hasOwn(e.props!, 'source'))).toBe(true);
  });

  it('retains an original error when an optional name or code getter throws', async () => {
    const a = await fresh();
    a.handleRejectionEvent({ reason: {
      message: 'original failure', stack: '    at https://play.test/loader.js:4:5',
      get name(): never { throw new Error('unreadable name'); },
      get code(): never { throw new Error('unreadable code'); },
    } });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sentBodies(fetchMock)[0]!.events[0]!.props).toEqual({ message: 'original failure', source: 'loader.js:4:5', count: 1 });
  });
});

describe('device identity', () => {
  it('persists a random id in localStorage and reuses it', async () => {
    const a = await fresh();
    const id = a.getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(localStorage.getItem('pkw:analytics-device')).toBe(id);
    expect(a.getDeviceId()).toBe(id);
    const b = await fresh(); // a reload
    expect(b.getDeviceId()).toBe(id);
  });

  it('ignores a tampered stored value and survives a throwing storage', async () => {
    localStorage.setItem('pkw:analytics-device', 'not an id <script>');
    const a = await fresh();
    expect(a.getDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('private mode'); });
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('private mode'); });
    try {
      const b = await fresh();
      expect(b.getDeviceId()).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });
});

describe('EVENTS', () => {
  it('track accepts only listed names, so a drifted name fails typecheck', async () => {
    const a = await fresh();
    a.track(a.EVENTS.TUTORIAL_STEP, { step: 1 });
    // @ts-expect-error — unknown event names must not compile (they would start a silent new series in PostHog).
    a.track('tutorial_stpe', { step: 1 });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sentBodies(fetchMock)[0]!.events.map((e) => e.event)).toEqual(['tutorial_step', 'tutorial_stpe']);
    // The client aggregate must not collide with the server's singular name.
    expect(Object.values(a.EVENTS)).not.toContain('tester_milestone_earned');
    expect(Object.values(a.EVENTS)).not.toContain('tester_feedback_submitted');
    expect(Object.values(a.EVENTS)).toContain('tester_milestones_announced');
  });
});

describe('initAnalytics', () => {
  it('sends app_opened with session + device context and wires the window listeners', async () => {
    const a = await fresh();
    a.initAnalytics();
    window.dispatchEvent(new ErrorEvent('error', {
      message: 'real bug', filename: 'https://play.pixelkingdomwars.com/assets/index-BQ3jK2sr.js', lineno: 9,
    }));
    await vi.advanceTimersByTimeAsync(15_000);
    const [batch] = sentBodies(fetchMock);
    expect(batch!.context).toMatchObject({
      buildVersion: '1.4.2', gitSha: 'abcdef0', simVersion: 14, platform: 'desktop', solanaMobile: false,
      deviceId: localStorage.getItem('pkw:analytics-device'),
    });
    expect(String(batch!.context['sessionId'])).toMatch(/^[0-9a-f-]{36}$/);
    expect(batch!.events.map((e) => e.event)).toEqual(['app_opened', 'app_error']);
    expect(batch!.events[1]!.props).toMatchObject({ source: 'index.js:9', count: 1 });
  });
});

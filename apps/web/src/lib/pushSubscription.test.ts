import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  get: vi.fn(), postRaw: vi.fn(), delRaw: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => ({
  ...await importOriginal<typeof import('./api')>(),
  api: apiMock,
}));
vi.mock('./analytics', async (orig) => ({ ...(await orig<typeof import('./analytics')>()), track: vi.fn() }));

import { PUSH_ENDPOINT_KEY, PUSH_FLAG_KEY, pushSubscriptionActive } from './mobileShell';
import { ApiError } from './api';
import {
  disablePush, enablePush, PUSH_SESSION_FENCE_KEY, pushNotificationsSupported, resumePushSessionAndSync,
  suspendPushSession, syncPushSubscription, urlBase64ToUint8Array,
} from './pushSubscription';

// D-101: the subscription must survive UPDATE NOW (which unregisters the
// worker and destroys the PushSubscription), so every boot re-syncs from the
// two local keys, and nothing here may ever throw into the game loop.

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
  } as Storage;
}

function subscription(endpoint: string) {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'P', auth: 'A' } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function pushStateUrl(path: string): string {
  const origin = typeof location !== 'undefined' && location.origin
    ? location.origin : 'https://play.pixelkingdomwars.com';
  return new URL(path, origin).href;
}

let storage: Storage;
let manager: { getSubscription: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn> };
let permission: NotificationPermission;
let workerCacheEntries: Map<string, Response>;
let workerStateCache: {
  match: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};
let workerController: { postMessage: ReturnType<typeof vi.fn> };

class TestMessagePort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  peer: TestMessagePort | null = null;
  close = vi.fn();
  postMessage(data: unknown): void {
    queueMicrotask(() => this.peer?.onmessage?.({ data } as MessageEvent<unknown>));
  }
}

class TestMessageChannel {
  port1 = new TestMessagePort();
  port2 = new TestMessagePort();
  constructor() {
    this.port1.peer = this.port2;
    this.port2.peer = this.port1;
  }
}

beforeEach(() => {
  storage = memoryStorage();
  permission = 'granted';
  manager = {
    getSubscription: vi.fn(async () => null),
    subscribe: vi.fn(async () => subscription('https://push.example/new')),
  };
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('Notification', {
    get permission() { return permission; },
    requestPermission: vi.fn(async () => permission),
  });
  vi.stubGlobal('PushManager', class PushManager {});
  workerCacheEntries = new Map();
  workerStateCache = {
    match: vi.fn(async (key: string) => workerCacheEntries.get(String(key))?.clone()),
    put: vi.fn(async (key: string, response: Response) => {
      workerCacheEntries.set(String(key), response.clone());
    }),
    delete: vi.fn(async (key: string) => workerCacheEntries.delete(String(key))),
  };
  workerController = { postMessage: vi.fn((message: unknown, transfer?: TestMessagePort[]) => {
    const state = message as { type?: unknown; fenceNonce?: unknown } | null;
    if (state?.type !== 'push-session-resumed' || typeof state.fenceNonce !== 'string') return;
    const ack = pushStateUrl(`/_pkw-push/session-resumed?fence=${state.fenceNonce}`);
    workerCacheEntries.set(ack, new Response(state.fenceNonce));
    transfer?.[0]?.postMessage({
      type: 'push-session-result', fenceNonce: state.fenceNonce, active: true,
    });
  }) };
  vi.stubGlobal('MessageChannel', TestMessageChannel);
  vi.stubGlobal('caches', { open: vi.fn(async () => workerStateCache) });
  vi.stubGlobal('navigator', {
    userAgent: 'test-agent',
    locks: {
      request: vi.fn(async (_name: string, _options: LockOptions, operation: () => Promise<boolean>) => operation()),
    },
    serviceWorker: {
      controller: workerController,
      getRegistration: vi.fn(async () => ({ pushManager: manager })),
    },
  });
  apiMock.get.mockReset().mockResolvedValue({ publicKey: 'BAAA' });
  apiMock.postRaw.mockReset().mockResolvedValue({});
  apiMock.delRaw.mockReset().mockResolvedValue({});
});

afterEach(() => vi.unstubAllGlobals());

describe('urlBase64ToUint8Array', () => {
  it('decodes url-safe base64 without padding into the raw key bytes', () => {
    // 'BAAA' -> 0x04 0x00 0x00, the way a VAPID public key begins (uncompressed point).
    expect([...urlBase64ToUint8Array('BAAA')]).toEqual([4, 0, 0]);
    expect([...urlBase64ToUint8Array('-_8')]).toEqual([251, 255]);
  });
});

describe('syncPushSubscription', () => {
  it('distinguishes notification permission from actual Web Push support', () => {
    expect(pushNotificationsSupported()).toBe(true);
    vi.stubGlobal('PushManager', undefined);
    expect(pushNotificationsSupported()).toBe(false);
  });

  it('does nothing until the player opted in AND the permission is granted', async () => {
    expect(await syncPushSubscription()).toBe(false);
    storage.setItem(PUSH_FLAG_KEY, '1');
    permission = 'default';
    expect(await syncPushSubscription()).toBe(false);
    expect(manager.getSubscription).not.toHaveBeenCalled();
    expect(apiMock.postRaw).not.toHaveBeenCalled();
  });

  it('returns promptly when registration failed instead of awaiting ready forever', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      locks: {
        request: vi.fn(async (_name: string, _options: LockOptions, operation: () => Promise<boolean>) => operation()),
      },
      serviceWorker: { getRegistration: vi.fn(async () => undefined) },
    });
    await expect(syncPushSubscription()).resolves.toBe(false);
    expect(apiMock.get).not.toHaveBeenCalled();
  });

  it('fails closed when cross-realm Web Locks are unavailable', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    vi.stubGlobal('navigator', {
      userAgent: 'legacy-browser',
      serviceWorker: {
        controller: workerController,
        getRegistration: vi.fn(async () => ({ pushManager: manager })),
      },
    });

    expect(await syncPushSubscription()).toBe(false);
    expect(manager.getSubscription).not.toHaveBeenCalled();
    expect(apiMock.postRaw).not.toHaveBeenCalled();
    expect(workerController.postMessage).toHaveBeenCalledWith({
      type: 'push-session-suspended', fenceNonce: expect.any(String),
    });
    expect(workerStateCache.put).toHaveBeenCalledOnce();
  });

  it('subscribes with the server VAPID key and POSTs the previous endpoint when none is live', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/old');
    expect(await syncPushSubscription()).toBe(true);
    expect(apiMock.get).toHaveBeenCalledWith('/notifications/vapid');
    const options = manager.subscribe.mock.calls[0]![0] as PushSubscriptionOptionsInit;
    expect(options.userVisibleOnly).toBe(true);
    expect([...(options.applicationServerKey as Uint8Array)]).toEqual([4, 0, 0]);
    expect(apiMock.postRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: 'https://push.example/new',
      keys: { p256dh: 'P', auth: 'A' },
      previousEndpoint: 'https://push.example/old',
      userAgent: 'test-agent',
    });
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBe('https://push.example/new');
    expect(pushSubscriptionActive()).toBe(true);
  });

  it('reuses a live browser subscription without asking for the key, and omits an unchanged previousEndpoint', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    manager.getSubscription.mockResolvedValue(subscription('https://push.example/live'));
    expect(await syncPushSubscription()).toBe(true);
    expect(apiMock.get).not.toHaveBeenCalled();
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(apiMock.postRaw.mock.calls[0]![1]).not.toHaveProperty('previousEndpoint');
  });

  it('serializes auth, controller-takeover and Settings sync requests', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const live = subscription('https://push.example/live');
    let release!: () => void;
    let active = 0;
    let maxActive = 0;
    manager.getSubscription.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => { release = resolve; });
      active -= 1;
      return live;
    });
    const first = syncPushSubscription();
    const second = syncPushSubscription();
    await vi.waitFor(() => expect(active).toBe(1));
    release();
    await first;
    await vi.waitFor(() => expect(active).toBe(1));
    release();
    await second;
    expect(maxActive).toBe(1);
    expect(apiMock.postRaw).toHaveBeenCalledTimes(2);
  });

  it('stops quietly when the server has push disabled (publicKey null)', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/from-unregistered-worker');
    apiMock.get.mockResolvedValue({ publicKey: null });
    expect(await syncPushSubscription()).toBe(false);
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(apiMock.postRaw).not.toHaveBeenCalled();
    expect(pushSubscriptionActive()).toBe(false);
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
  });

  it('clears stale acknowledged-active state when a live browser subscription cannot be acknowledged', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    manager.getSubscription.mockResolvedValue(subscription('https://push.example/live'));
    apiMock.postRaw.mockRejectedValue(new ApiError(503, 'push disabled', 'PUSH_DISABLED'));
    expect(pushSubscriptionActive()).toBe(true);
    expect(await syncPushSubscription()).toBe(false);
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    // The player still opted in, so mobileShell's hidden-tab fallback is now
    // armed instead of being suppressed by a stale acknowledgement.
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
    expect(pushSubscriptionActive()).toBe(false);
  });

  it('clears the local acknowledgement while an ownership sync is offline and fenced', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    manager.getSubscription.mockResolvedValue(subscription('https://push.example/live'));
    apiMock.postRaw.mockRejectedValue(new ApiError(0, 'offline', 'NETWORK_UNAVAILABLE'));
    expect(await syncPushSubscription()).toBe(false);
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    expect(pushSubscriptionActive()).toBe(false);
  });

  it.each(['false', 'reject'])('keeps delivery fenced when a prior-wallet endpoint unsubscribe %s', async (mode) => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/wallet-a');
    const walletA = subscription('https://push.example/wallet-a');
    if (mode === 'false') walletA.unsubscribe.mockResolvedValue(false);
    else walletA.unsubscribe.mockRejectedValue(new Error('push service rejected unsubscribe'));
    manager.getSubscription.mockResolvedValue(walletA);
    apiMock.postRaw.mockRejectedValueOnce(new ApiError(409, 'endpoint owned', 'PUSH_ENDPOINT_OWNED'));
    apiMock.delRaw.mockRejectedValue(new ApiError(403, 'wrong wallet', 'FORBIDDEN'));

    expect(await syncPushSubscription()).toBe(false);
    expect(walletA.unsubscribe).toHaveBeenCalledOnce();
    expect(manager.subscribe).not.toHaveBeenCalled();
    expect(apiMock.postRaw).toHaveBeenCalledOnce();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: walletA.endpoint,
    });
    expect(workerController.postMessage).toHaveBeenCalledWith({
      type: 'push-session-suspended', fenceNonce: expect.any(String),
    });
    expect(workerController.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'push-session-resumed',
    }), expect.anything());
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
  });

  it('registers a fresh capability on the next sync only after the prior one is gone', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/wallet-a');
    const walletA = subscription('https://push.example/wallet-a');
    const walletB = subscription('https://push.example/wallet-b');
    manager.getSubscription.mockResolvedValueOnce(walletA).mockResolvedValueOnce(null);
    manager.subscribe.mockResolvedValue(walletB);
    apiMock.postRaw
      .mockRejectedValueOnce(new ApiError(409, 'endpoint owned', 'PUSH_ENDPOINT_OWNED'))
      .mockResolvedValueOnce({});

    expect(await syncPushSubscription()).toBe(false);
    expect(await syncPushSubscription()).toBe(true);
    expect(manager.subscribe).toHaveBeenCalledOnce();
    expect(apiMock.postRaw).toHaveBeenCalledTimes(2);
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBe(walletB.endpoint);
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
  });

  it('swallows every failure and leaves no endpoint claimed', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    manager.subscribe.mockRejectedValue(new Error('push service down'));
    await expect(syncPushSubscription()).resolves.toBe(false);
    manager.subscribe.mockResolvedValue(subscription('https://push.example/new'));
    apiMock.postRaw.mockRejectedValue(new Error('503'));
    await expect(syncPushSubscription()).resolves.toBe(false);
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    vi.stubGlobal('navigator', { userAgent: 'x' }); // no serviceWorker at all
    await expect(syncPushSubscription()).resolves.toBe(false);
  });
});

describe('enablePush / disablePush', () => {
  it('enable asks for the permission first and only sets the flag once granted', async () => {
    permission = 'denied';
    expect(await enablePush()).toBe(false);
    expect(storage.getItem(PUSH_FLAG_KEY)).toBeNull();
    permission = 'granted';
    expect(await enablePush()).toBe(true);
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
    expect(apiMock.postRaw).toHaveBeenCalledOnce();
  });

  it('keeps a granted opt-in across an offline sync so the next boot retries', async () => {
    apiMock.get.mockRejectedValue(new Error('offline'));
    expect(await enablePush()).toBe(true);
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
  });

  it('does not ask for permission or persist ON when Web Push is unsupported', async () => {
    vi.stubGlobal('PushManager', undefined);
    expect(await enablePush()).toBe(false);
    expect(Notification.requestPermission).not.toHaveBeenCalled();
    expect(storage.getItem(PUSH_FLAG_KEY)).toBeNull();
  });

  it('disable clears the flag before any network work, unsubscribes and retires the server row', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    const live = subscription('https://push.example/live');
    manager.getSubscription.mockResolvedValue(live);
    await disablePush();
    expect(storage.getItem(PUSH_FLAG_KEY)).toBeNull();
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    expect(live.unsubscribe).toHaveBeenCalledOnce();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', { endpoint: 'https://push.example/live' });
    expect(pushSubscriptionActive()).toBe(false);
    expect(workerStateCache.put).toHaveBeenCalled();
  });

  it('retires both a browser-rotated endpoint and the last server-acknowledged endpoint', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/acknowledged');
    const rotated = subscription('https://push.example/rotated');
    manager.getSubscription.mockResolvedValue(rotated);
    await disablePush();
    expect(rotated.unsubscribe).toHaveBeenCalledOnce();
    expect(apiMock.delRaw.mock.calls).toEqual([
      ['/notifications/subscribe', { endpoint: 'https://push.example/acknowledged' }],
      ['/notifications/subscribe', { endpoint: 'https://push.example/rotated' }],
    ]);
  });

  it('still retires the remembered server endpoint when browser registration lookup fails', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/acknowledged');
    manager.getSubscription.mockRejectedValue(new Error('registration corrupt'));
    await disablePush();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: 'https://push.example/acknowledged',
    });
  });

  it('disable never throws when the network refuses', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    apiMock.delRaw.mockRejectedValue(new Error('offline'));
    await expect(disablePush()).resolves.toBeUndefined();
    expect(storage.getItem(PUSH_FLAG_KEY)).toBeNull();
  });
});

describe('authenticated push-session detach', () => {
  it('invalidates an in-flight sync, retires both endpoints, and resubscribes only for the next login', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/old');
    const live = subscription('https://push.example/live');
    let release!: () => void;
    // Re-open the session after prior tests may have deliberately suspended it.
    manager.getSubscription.mockResolvedValueOnce(live);
    await resumePushSessionAndSync();
    apiMock.postRaw.mockClear();
    manager.getSubscription.mockClear();
    manager.getSubscription.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return live;
    });
    const oldSync = syncPushSubscription();
    await vi.waitFor(() => expect(manager.getSubscription).toHaveBeenCalledOnce());
    const detach = suspendPushSession();
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    release();
    expect(await oldSync).toBe(false);
    await detach;
    expect(live.unsubscribe).toHaveBeenCalled();
    expect(apiMock.postRaw).not.toHaveBeenCalled();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: 'https://push.example/live',
    });
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
    expect(workerStateCache.put).toHaveBeenCalled();

    apiMock.delRaw.mockClear();
    manager.getSubscription.mockResolvedValue(null);
    expect(await resumePushSessionAndSync()).toBe(true);
    expect([...workerCacheEntries.keys()].some((key) => key.includes('/_pkw-push/session-resumed?fence='))).toBe(true);
    expect(apiMock.postRaw).toHaveBeenCalledWith('/notifications/subscribe', expect.objectContaining({
      endpoint: 'https://push.example/new',
    }));
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBe('https://push.example/new');
  });

  it('fails closed on expired/offline DELETE but preserves opt-in for a later authenticated resync', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/old');
    const live = subscription('https://push.example/live');
    manager.getSubscription.mockResolvedValue(live);
    apiMock.delRaw.mockRejectedValue(new Error('401 expired'));

    await expect(suspendPushSession()).resolves.toBeUndefined();
    expect(live.unsubscribe).toHaveBeenCalledOnce();
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');

    apiMock.delRaw.mockResolvedValue({});
    manager.getSubscription.mockResolvedValue(null);
    expect(await resumePushSessionAndSync()).toBe(true);
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBe('https://push.example/new');
  });

  it('replaces a stale durable marker with an unacknowledged ownership fence before POST', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const markerKey = pushStateUrl('/_pkw-push/session-suspended');
    workerCacheEntries.set(markerKey, new Response('stale-generation'));
    const live = subscription('https://push.example/live');
    manager.getSubscription.mockResolvedValue(live);

    expect(await resumePushSessionAndSync()).toBe(true);
    const suspension = workerController.postMessage.mock.calls[0]![0] as { fenceNonce: string };
    expect(suspension.fenceNonce).not.toBe('stale-generation');
    expect(await workerCacheEntries.get(markerKey)?.clone().text()).toBe(suspension.fenceNonce);
    expect(workerController.postMessage).toHaveBeenCalledWith({
      type: 'push-session-suspended', fenceNonce: suspension.fenceNonce,
    });
    expect(workerController.postMessage).toHaveBeenCalledWith({
      type: 'push-session-resumed', fenceNonce: suspension.fenceNonce,
    }, expect.any(Array));
    expect(live.unsubscribe).not.toHaveBeenCalled();
  });

  it('undoes a server subscription that commits while session detach is requested', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const live = subscription('https://push.example/live');
    manager.getSubscription.mockResolvedValue(live);
    await resumePushSessionAndSync();
    apiMock.postRaw.mockClear();
    apiMock.delRaw.mockClear();

    let commit!: () => void;
    apiMock.postRaw.mockImplementationOnce(async () => new Promise<void>((resolve) => { commit = resolve; }));
    const staleSync = syncPushSubscription();
    await vi.waitFor(() => expect(apiMock.postRaw).toHaveBeenCalledOnce());
    const detach = suspendPushSession();
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    commit();

    expect(await staleSync).toBe(false);
    await detach;
    expect(live.unsubscribe).toHaveBeenCalled();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: 'https://push.example/live',
    });
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
  });

  it('rejects and retires a resume when another page realm suspends during its POST', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const replacement = subscription('https://push.example/cross-realm');
    manager.getSubscription.mockResolvedValue(null);
    manager.subscribe.mockResolvedValue(replacement);
    let commit!: () => void;
    apiMock.postRaw.mockImplementationOnce(async () => new Promise<void>((resolve) => { commit = resolve; }));

    const staleResume = resumePushSessionAndSync();
    await vi.waitFor(() => expect(apiMock.postRaw).toHaveBeenCalledOnce());
    // This is tab B: shared browser state changes, but tab A's module-local
    // epoch and operation queue do not. That is the production failure mode.
    const newerFence = 'realm-b-off';
    storage.removeItem(PUSH_FLAG_KEY);
    storage.setItem(PUSH_SESSION_FENCE_KEY, newerFence);
    const suspendedKey = pushStateUrl('/_pkw-push/session-suspended');
    workerCacheEntries.set(suspendedKey, new Response(newerFence));
    commit();

    expect(await staleResume).toBe(false);
    expect(replacement.unsubscribe).toHaveBeenCalledOnce();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: replacement.endpoint,
    });
    expect(await workerCacheEntries.get(suspendedKey)?.text()).toBe(newerFence);
    expect(workerController.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'push-session-resumed',
    }));
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
  });

  it('rejects a worker activation reply that crosses a newer realm suspension', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const live = subscription('https://push.example/live');
    manager.getSubscription.mockResolvedValue(live);
    let replyPort: TestMessagePort | undefined;
    let activationFence: string | undefined;
    workerController.postMessage.mockImplementation((message: unknown, transfer?: TestMessagePort[]) => {
      const state = message as { type?: unknown; fenceNonce?: unknown } | null;
      if (state?.type !== 'push-session-resumed' || typeof state.fenceNonce !== 'string') return;
      activationFence = state.fenceNonce;
      replyPort = transfer?.[0];
    });

    const resume = resumePushSessionAndSync();
    await vi.waitFor(() => expect(replyPort).toBeDefined());
    // The SW has committed activation, but tab B suspends before tab A consumes
    // its reply. Tab A must compensate and cannot touch B's durable generation.
    const newerFence = 'realm-b-newer-fence';
    storage.setItem(PUSH_SESSION_FENCE_KEY, newerFence);
    const suspendedKey = pushStateUrl('/_pkw-push/session-suspended');
    const newerResumeKey = pushStateUrl(`/_pkw-push/session-resumed?fence=${newerFence}`);
    workerCacheEntries.set(suspendedKey, new Response(newerFence));
    workerCacheEntries.set(newerResumeKey, new Response(newerFence));
    replyPort!.postMessage({
      type: 'push-session-result', fenceNonce: activationFence, active: true,
    });

    expect(await resume).toBe(false);
    expect(await workerCacheEntries.get(suspendedKey)?.text()).toBe(newerFence);
    expect(await workerCacheEntries.get(newerResumeKey)?.text()).toBe(newerFence);
    expect(live.unsubscribe).toHaveBeenCalled();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: live.endpoint,
    });
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
  });

  it('rotates back to a durable suspension when the worker activation reply times out', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    manager.getSubscription.mockResolvedValue(subscription('https://push.example/live'));
    workerController.postMessage.mockImplementation(() => undefined);
    vi.useFakeTimers();
    try {
      const resume = resumePushSessionAndSync();
      for (let index = 0; index < 100; index += 1) await Promise.resolve();
      const resumeCall = workerController.postMessage.mock.calls.find(([message]) => (
        (message as { type?: unknown })?.type === 'push-session-resumed'
      ));
      expect(resumeCall).toBeDefined();

      await vi.advanceTimersByTimeAsync(5_000);
      expect(await resume).toBe(false);

      const suspensionCalls = workerController.postMessage.mock.calls.filter(([message]) => (
        (message as { type?: unknown })?.type === 'push-session-suspended'
      ));
      expect(suspensionCalls).toHaveLength(2);
      const finalFence = (suspensionCalls[1]![0] as { fenceNonce: string }).fenceNonce;
      expect(await workerCacheEntries.get(pushStateUrl('/_pkw-push/session-suspended'))?.text())
        .toBe(finalFence);
      expect(workerCacheEntries.has(
        pushStateUrl(`/_pkw-push/session-resumed?fence=${finalFence}`),
      )).toBe(false);
      expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('fences before persistence and lets only the worker acknowledge resume', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    manager.getSubscription.mockResolvedValue(subscription('https://push.example/live'));

    expect(await resumePushSessionAndSync()).toBe(true);
    expect(workerController.postMessage).toHaveBeenCalledTimes(2);
    const fenceNonce = (workerController.postMessage.mock.calls[0]![0] as { fenceNonce: string }).fenceNonce;
    expect(workerController.postMessage.mock.calls[0]![0]).toEqual({
      type: 'push-session-suspended', fenceNonce,
    });
    expect(workerController.postMessage.mock.calls[1]![0]).toEqual({
      type: 'push-session-resumed', fenceNonce,
    });
    expect(workerController.postMessage.mock.invocationCallOrder[0])
      .toBeLessThan(workerStateCache.put.mock.invocationCallOrder[0]!);
    expect(workerStateCache.put).toHaveBeenCalledTimes(1);
    expect([...workerCacheEntries.keys()].filter((key) => key.includes('/session-resumed?')))
      .toHaveLength(1);

    await suspendPushSession();
    expect(workerController.postMessage).toHaveBeenCalledTimes(3);
    expect(workerController.postMessage).toHaveBeenLastCalledWith({
      type: 'push-session-suspended', fenceNonce: expect.any(String),
    });
    expect(workerController.postMessage.mock.invocationCallOrder[2])
      .toBeLessThan(workerStateCache.put.mock.invocationCallOrder.at(-1)!);
  });

  it('uses the active registration when the page has no controlling worker', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const active = { postMessage: vi.fn() };
    vi.stubGlobal('navigator', {
      userAgent: 'test-agent',
      locks: {
        request: vi.fn(async (_name: string, _options: LockOptions, operation: () => Promise<boolean>) => operation()),
      },
      serviceWorker: {
        controller: null,
        getRegistration: vi.fn(async () => ({ pushManager: manager, active })),
      },
    });

    await suspendPushSession();
    expect(active.postMessage).toHaveBeenCalledWith({
      type: 'push-session-suspended', fenceNonce: expect.any(String),
    });
  });

  it('invalidates an old ACK before a failed marker put while browser and API teardown fail', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    storage.setItem(PUSH_ENDPOINT_KEY, 'https://push.example/live');
    const marker = pushStateUrl('/_pkw-push/session-suspended');
    const oldAck = pushStateUrl('/_pkw-push/session-resumed?fence=old-active');
    workerCacheEntries.set(marker, new Response('old-active'));
    workerCacheEntries.set(oldAck, new Response('old-active'));
    const live = subscription('https://push.example/live');
    live.unsubscribe.mockRejectedValue(new Error('push service offline'));
    manager.getSubscription.mockResolvedValue(live);
    workerStateCache.put.mockRejectedValueOnce(new Error('cache quota'));
    apiMock.delRaw.mockRejectedValue(new Error('api offline'));

    await expect(suspendPushSession()).resolves.toBeUndefined();
    expect(workerController.postMessage).toHaveBeenCalledWith({
      type: 'push-session-suspended', fenceNonce: expect.any(String),
    });
    expect(workerStateCache.put).toHaveBeenCalledOnce();
    expect(workerStateCache.delete).toHaveBeenCalledWith(oldAck);
    expect(await workerCacheEntries.get(marker)?.clone().text()).toBe('old-active');
    expect(workerCacheEntries.has(oldAck)).toBe(false);
    expect(live.unsubscribe).toHaveBeenCalledOnce();
    expect(apiMock.delRaw).toHaveBeenCalledWith('/notifications/subscribe', {
      endpoint: 'https://push.example/live',
    });
    expect(storage.getItem(PUSH_ENDPOINT_KEY)).toBeNull();
  });

  it('cancels a wedged sync and bounds endpoint retirement so sign-out can reach logout', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    const live = subscription('https://push.example/live');
    manager.getSubscription.mockResolvedValue(live);
    expect(await resumePushSessionAndSync()).toBe(true);

    apiMock.postRaw.mockClear();
    apiMock.delRaw.mockClear();
    const post = deferred<void>();
    const remove = deferred<unknown>();
    apiMock.postRaw.mockImplementationOnce(async () => post.promise);
    apiMock.delRaw.mockImplementation(async () => remove.promise);
    vi.useFakeTimers();
    try {
      const staleSync = syncPushSubscription();
      for (let index = 0; index < 100 && apiMock.postRaw.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(apiMock.postRaw).toHaveBeenCalledOnce();

      const detach = suspendPushSession();
      expect(await staleSync).toBe(false);
      for (let index = 0; index < 100 && apiMock.delRaw.mock.calls.length === 0; index += 1) {
        await Promise.resolve();
      }
      expect(apiMock.delRaw).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(detach).resolves.toBeUndefined();

    } finally {
      // Let the abandoned transport and best-effort cleanup settle even when
      // an assertion fails, so this module's serialized queue stays isolated.
      post.resolve();
      remove.resolve({});
      await Promise.resolve();
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it('keeps suspension durable and quiet when worker messaging fails', async () => {
    storage.setItem(PUSH_FLAG_KEY, '1');
    workerController.postMessage.mockImplementation(() => { throw new Error('worker replaced'); });

    await expect(suspendPushSession()).resolves.toBeUndefined();
    expect(workerStateCache.put).toHaveBeenCalledOnce();
    expect(workerController.postMessage).toHaveBeenCalledWith({
      type: 'push-session-suspended', fenceNonce: expect.any(String),
    });
    expect(storage.getItem(PUSH_FLAG_KEY)).toBe('1');
  });
});

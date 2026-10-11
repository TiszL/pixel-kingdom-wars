/**
 * THE GLOBAL GATE HANDLERS, AND WHY THE 402 ONE IS CODE-ONLY.
 *
 * `LAND_NOT_OWNED` is the API's new machine-readable refusal, and the client
 * turns it into a buy-land offer from anywhere. The danger is that 402 is NOT a
 * new status in this API: `requireEntryPaid` and the non-`entry` deposit refusal
 * both already 402 with NO code, and today's paywall is built on one of them —
 * `enterGame` reads `status === 402` off the /base load and routes to the
 * blocking ENTRY screen.
 *
 * So a status-only match would fire the new soft prompt on a server that has not
 * shipped free onboarding, on the very request that is supposed to produce the
 * hard paywall. These tests pin that it cannot: the coded 402 fires, the codeless
 * one does not, and neither changes what the caller is thrown.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError, BASE_CLIENT_UPGRADE_REQUIRED, RECENT_AUTH_HEADER, api, isAlphaGated,
  isBaseClientUpgradeRequired, isBaseSelectionError, isLandNotOwned,
  setAlphaGatedHandler, setBaseSelectionInvalidHandler, setLandGatedHandler,
  setOutdatedHandler, setUnauthorizedHandler,
} from './api';

/** A fetch that answers once with the given status + JSON error envelope. */
function stubFetch(
  status: number,
  error?: ({ code?: string; message?: string } & Record<string, unknown>),
): void {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => (error ? { error } : {}),
  })));
}

afterEach(() => {
  vi.unstubAllGlobals();
  setLandGatedHandler(() => { /* reset */ });
  setAlphaGatedHandler(() => { /* reset */ });
  setUnauthorizedHandler(() => { /* reset */ });
  setOutdatedHandler(() => { /* reset */ });
  setBaseSelectionInvalidHandler(() => { /* reset */ });
});

describe('typed multi-base upgrade and ownership exits', () => {
  it('preserves canonical machine details needed to recover a stale raid clock', async () => {
    const clock = { protocolVersion: 2, revision: 7, rate: 2 };
    stubFetch(409, { code: 'RAID_CLOCK_STALE', message: 'clock changed', clock });
    const error = await api.postRaw('/raids/example/speed', {}).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).details?.clock).toEqual(clock);
  });

  it('routes BASE_CLIENT_UPGRADE_REQUIRED to selection, not the simulator updater', async () => {
    const onBase = vi.fn();
    const onOutdated = vi.fn();
    setBaseSelectionInvalidHandler(onBase);
    setOutdatedHandler(onOutdated);
    stubFetch(426, { code: BASE_CLIENT_UPGRADE_REQUIRED, message: 'choose a base' });
    const error = await api.get('/base').catch((cause: unknown) => cause);
    expect(isBaseClientUpgradeRequired(error)).toBe(true);
    expect(isBaseSelectionError(error)).toBe(true);
    expect(onBase).toHaveBeenCalledOnce();
    expect(onBase).toHaveBeenCalledWith(BASE_CLIENT_UPGRADE_REQUIRED);
    expect(onOutdated).not.toHaveBeenCalled();
  });

  it('exits a base immediately when fresh deed authority reports a mismatch', async () => {
    const onBase = vi.fn();
    setBaseSelectionInvalidHandler(onBase);
    stubFetch(409, { code: 'DEED_OWNERSHIP_CHANGED', message: 'deed changed' });
    const error = await api.post('/bases/example/activate').catch((cause: unknown) => cause);
    expect(isBaseSelectionError(error)).toBe(true);
    expect(onBase).toHaveBeenCalledOnce();
    expect(onBase).toHaveBeenCalledWith('DEED_OWNERSHIP_CHANGED');
  });

  it.each(['wallet', 'base', 'epoch'])('does not let a delayed deed refusal evict a newer %s scope', async (changed) => {
    const onBase = vi.fn();
    let scope = 'wallet/base/epoch';
    setBaseSelectionInvalidHandler(onBase, () => scope);
    let answer!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { answer = resolve; })));
    const request = api.get('/base?baseId=old').catch((cause: unknown) => cause);
    scope = `${changed}/new`;
    answer(new Response(JSON.stringify({ error: { code: 'DEED_OWNERSHIP_CHANGED' } }), { status: 409 }));
    expect(await request).toBeInstanceOf(ApiError); // the original caller still learns the refusal
    expect(onBase).not.toHaveBeenCalled();
  });

  it('lets a background GET own only its temporary-authority notice and still rejects the read', async () => {
    const onBase = vi.fn();
    setBaseSelectionInvalidHandler(onBase, () => 'same-wallet/base/epoch');
    stubFetch(503, { code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await expect(api.get('/base', { deferAuthorityUnavailable: true })).rejects.toMatchObject({
      status: 503, code: 'DEED_AUTHORITY_UNAVAILABLE',
    });
    expect(onBase).not.toHaveBeenCalled();
    stubFetch(409, { code: 'DEED_OWNERSHIP_CHANGED' });
    await expect(api.get('/base', { deferAuthorityUnavailable: true })).rejects.toBeInstanceOf(ApiError);
    expect(onBase).toHaveBeenCalledExactlyOnceWith('DEED_OWNERSHIP_CHANGED');
  });

  it('still delivers a current uncertain authority response for recoverable messaging', async () => {
    const onBase = vi.fn();
    setBaseSelectionInvalidHandler(onBase, () => 'same-wallet/base/epoch');
    stubFetch(503, { code: 'DEED_AUTHORITY_UNAVAILABLE' });
    await expect(api.get('/base')).rejects.toBeInstanceOf(ApiError);
    expect(onBase).toHaveBeenCalledWith('DEED_AUTHORITY_UNAVAILABLE');
  });
});

describe('402 land gate', () => {
  it('fires the handler on 402 LAND_NOT_OWNED and still throws for the caller', async () => {
    const onLand = vi.fn();
    setLandGatedHandler(onLand);
    stubFetch(402, { code: 'LAND_NOT_OWNED', message: 'land required' });
    const err = await api.get('/forge').catch((e: unknown) => e);
    expect(onLand).toHaveBeenCalledOnce();
    // The throw matters too: a screen may need to stop its own spinner. The gate
    // is an ADDITION to the error path, not a replacement for it.
    expect(err).toBeInstanceOf(ApiError);
    expect(isLandNotOwned(err)).toBe(true);
  });

  it('does NOT fire on a CODELESS 402 — the flag-off paywall is untouched', async () => {
    // apps/api/src/auth/session.ts requireEntryPaid: `throw new HttpError(402,
    // 'entry payment required')` — no code. That is what the server sends today,
    // and today's behaviour must be exactly today's behaviour.
    const onLand = vi.fn();
    setLandGatedHandler(onLand);
    stubFetch(402, { message: 'entry payment required' });
    const err = await api.get('/base').catch((e: unknown) => e);
    expect(onLand).not.toHaveBeenCalled();
    expect((err as ApiError).status).toBe(402); // enterGame's paywall branch still sees it
    expect(isLandNotOwned(err)).toBe(false);
  });

  it('does NOT fire on some OTHER coded 402', async () => {
    const onLand = vi.fn();
    setLandGatedHandler(onLand);
    stubFetch(402, { code: 'SOMETHING_ELSE', message: 'nope' });
    await api.get('/deposits').catch(() => null);
    expect(onLand).not.toHaveBeenCalled();
  });

  it('keeps the two gates separate: an alpha 403 raises only the alpha panel', async () => {
    const onLand = vi.fn();
    const onAlpha = vi.fn();
    setLandGatedHandler(onLand);
    setAlphaGatedHandler(onAlpha);
    stubFetch(403, { code: 'ALPHA_GATED', message: 'closed alpha' });
    const err = await api.get('/base').catch((e: unknown) => e);
    expect(onAlpha).toHaveBeenCalledOnce();
    expect(onLand).not.toHaveBeenCalled();
    expect(isAlphaGated(err)).toBe(true);
  });

  it('orders onboarding as closed alpha first, then the land offer after admission', async () => {
    // WHY: the 0.2 SOL deed purchase is not the invitation. A fresh stranger must
    // first see ALPHA_GATED; only a later request from an admitted, landless
    // account may raise LAND_NOT_OWNED. Keeping the callbacks distinct also
    // prevents the parallel entry-state loads from replacing the invite screen.
    const onAlpha = vi.fn();
    const onLand = vi.fn();
    setAlphaGatedHandler(onAlpha);
    setLandGatedHandler(onLand);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: false, status: 403,
        json: async () => ({ error: { code: 'ALPHA_GATED', message: 'closed alpha' } }),
      })
      .mockResolvedValueOnce({
        ok: false, status: 402,
        json: async () => ({ error: { code: 'LAND_NOT_OWNED', message: 'buy your land' } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await api.get('/base').catch(() => null);
    expect(onAlpha).toHaveBeenCalledOnce();
    expect(onLand).not.toHaveBeenCalled();

    await api.get('/forge').catch(() => null);
    expect(onAlpha).toHaveBeenCalledOnce();
    expect(onLand).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a 2xx never raises the gate', async () => {
    const onLand = vi.fn();
    setLandGatedHandler(onLand);
    stubFetch(200);
    await api.get('/base');
    expect(onLand).not.toHaveBeenCalled();
  });
});

describe('isLandNotOwned', () => {
  it('requires BOTH the 402 and the code', () => {
    expect(isLandNotOwned(new ApiError(402, 'x', 'LAND_NOT_OWNED'))).toBe(true);
    expect(isLandNotOwned(new ApiError(402, 'entry payment required'))).toBe(false);
    expect(isLandNotOwned(new ApiError(403, 'x', 'LAND_NOT_OWNED'))).toBe(false);
    expect(isLandNotOwned(new Error('402'))).toBe(false);
    expect(isLandNotOwned(null)).toBe(false);
  });
});

describe('transport failures', () => {
  it('turns the browser\'s opaque Failed to fetch into a useful server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));

    const err = await api.get('/me').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({
      status: 0,
      code: 'NETWORK_UNAVAILABLE',
      message: 'Unable to reach the game server. Check your connection and try again.',
    });
  });

  it('forwards cancellation only when a GET caller explicitly supplies it', async () => {
    const fetchMock = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();

    await api.get('/me', { signal: controller.signal });
    await api.postRaw('/actions', {});

    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ signal: controller.signal });
    expect(fetchMock.mock.calls[1]![1]).not.toHaveProperty('signal');
  });
});

describe('binary uploads', () => {
  it('keeps screenshot uploads and reads private while retaining the session transport', async () => {
    const image = new Blob(['private-image'], { type: 'image/webp' });
    const controller = new AbortController();
    const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'image' }) })
      .mockResolvedValueOnce({ ok: true, blob: async () => image, json: vi.fn(() => { throw new Error('binary response parsed as JSON'); }) });
    vi.stubGlobal('fetch', fetcher);
    await expect(api.postBinary('/tester/feedback/report/screenshots/request', image, { signal: controller.signal })).resolves.toEqual({ id: 'image' });
    await expect(api.getBlob('/tester/feedback/report/screenshots/image', { signal: controller.signal })).resolves.toBe(image);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', body: image, cache: 'no-store', credentials: 'include', signal: controller.signal, headers: { 'content-type': 'image/webp' } });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'include', signal: controller.signal });
  });
  it('preserves typed attachment errors and does not expose an aborted download', async () => {
    const unauthorized = vi.fn(); setUnauthorizedHandler(unauthorized);
    stubFetch(401, { code: 'UNAUTHORIZED', message: 'Sign in again' });
    await expect(api.getBlob('/tester/feedback/r/screenshots/i')).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(unauthorized).toHaveBeenCalledOnce();
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => { controller.abort(); return new Blob(['private']); } })));
    await expect(api.getBlob('/tester/feedback/r/screenshots/i', { signal: controller.signal })).rejects.toBeDefined();
  });
  it('sends an avatar as the exact image body and MIME instead of JSON or multipart', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      status: 200,
      json: async () => ({ avatarUrl: 'https://cdn.example/avatar.webp' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    const image = new Blob(['image-bytes'], { type: 'image/webp' });

    await api.patchBinary('/me/avatar', image);

    const [url, init] = fetchMock.mock.calls[0]!;
    const request = init as RequestInit;
    expect(url).toMatch(/\/me\/avatar$/);
    expect(request).toMatchObject({ method: 'PATCH', body: image });
    expect(request.headers).toMatchObject({ 'content-type': 'image/webp' });
    expect(request.headers).not.toHaveProperty('content-disposition');
  });
});

describe('recent primary authentication', () => {
  it('sends the in-memory grant and a 428 never triggers global session logout', async () => {
    const onUnauthorized = vi.fn();
    setUnauthorizedHandler(onUnauthorized);
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: false,
      status: 428,
      json: async () => ({
        error: { code: 'RECENT_AUTH_REQUIRED', message: 'confirm with your wallet' },
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const err = await api.postRecent('/auth/export/challenge', {}, 'signed-grant').catch((e: unknown) => e);

    expect(err).toMatchObject({ status: 428, code: 'RECENT_AUTH_REQUIRED' });
    expect(onUnauthorized).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ [RECENT_AUTH_HEADER]: 'signed-grant' });
  });
});


describe('cookie-changing response validation', () => {
  function allowCookieLocks() {
    vi.stubGlobal('navigator', { locks: { request: (_name: string, optionsOrOperation: unknown, operation?: () => Promise<unknown>) =>
      (operation ?? optionsOrOperation as () => Promise<unknown>)() } });
  }
  it.each(['missing fields', 'lost JSON body'])('revokes successful headers with %s before the next login', async (scenario) => {
    allowCookieLocks();
    let cookieWallet: string | null = null;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/auth/logout')) {
        cookieWallet = null;
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
      cookieWallet = 'wallet-A'; // Browser applies the response headers first.
      return { ok: true, status: 200, json: async () => {
        if (scenario === 'lost JSON body') throw new Error('connection lost');
        return {};
      } };
    }));
    await expect(api.postAuth('/auth/social', {}, () => true)).rejects.toMatchObject({ code: 'LOGIN_RESPONSE_INVALID' });
    expect(cookieWallet).toBeNull();
    expect(calls.map((url) => new URL(url).pathname)).toEqual(['/auth/social', '/auth/logout']);
  });
  it('keeps a rejected TOTP credential available for the next code', async () => {
    allowCookieLocks();
    let cookie = 'pending'; let attempts = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toMatch(/auth\/login\/verify$/);
      if (++attempts === 1) return { ok: false, status: 422, json: async () => ({ error: { message: 'invalid code' } }) };
      expect(cookie).toBe('pending'); cookie = 'full';
      return { ok: true, status: 200, json: async () => ({ wallet: 'wallet-A', entryPaid: false }) };
    }));
    await expect(api.postAuth('/auth/login/verify', { code: '000000' }, () => true)).rejects.toMatchObject({ status: 422 });
    expect(cookie).toBe('pending');
    await expect(api.postAuth('/auth/login/verify', { code: '123456' }, () => true)).resolves.toMatchObject({ wallet: 'wallet-A' });
    expect(cookie).toBe('full');
  });
});

describe('opt-in cancellation for land recovery requests', () => {
  it('passes cancellation to both acknowledgement and verification without changing their bodies', async () => {
    stubFetch(200);
    const controller = new AbortController();
    await api.postRaw('/deposits/d/paid', { signature: 'signature' }, { signal: controller.signal });
    await api.post('/deposits/d/verify', undefined, { signal: controller.signal });
    await api.patch('/admin/tester/issues/example', { expectedRevision: 3 }, { signal: controller.signal });
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls[0]![1]?.signal).toBe(controller.signal);
    expect(calls[1]![1]?.signal).toBe(controller.signal);
    expect(calls[2]![1]?.signal).toBe(controller.signal);
    expect(JSON.parse(String(calls[2]![1]?.body))).toEqual({ expectedRevision: 3 });
    expect(JSON.parse(String(calls[0]![1]?.body))).toEqual({ signature: 'signature' });
    expect(JSON.parse(String(calls[1]![1]?.body))).toHaveProperty('idempotencyKey');
  });

  it('ignores a late unauthorized response from a cancelled request', async () => {
    const unauthorized = vi.fn();
    setUnauthorizedHandler(unauthorized);
    const controller = new AbortController();
    stubFetch(401, { message: 'old session' });
    controller.abort();
    await expect(api.get('/deposits/old', { signal: controller.signal })).rejects.toBeDefined();
    expect(unauthorized).not.toHaveBeenCalled();
  });
});

describe('command-local exact currency transport', () => {
  it('preserves frozen keys/bodies and never bleeds a currency into another command or receipt read', async () => {
    stubFetch(200); const body = { idempotencyKey: 'original', amount: '10' };
    await api.postRaw('/paid', body, { expectedCurrency: 'GEMS' });
    await api.post('/paid', body, { expectedCurrency: 'KEEP' });
    await api.postRaw('/other', body); await api.get('/receipt');
    const calls = vi.mocked(fetch).mock.calls;
    expect(calls.map(([, options]) => new Headers(options?.headers).get('x-pkw-expected-currency'))).toEqual(['GEMS', 'KEEP', null, null]);
    expect(calls.slice(0, 3).map(([, options]) => JSON.parse(String(options?.body)))).toEqual([body, body, body]);
  });
  it('retains the current-account guard before dispatch and before applying a late reply', async () => {
    stubFetch(200);
    await expect(api.postRaw('/paid', {}, { expectedCurrency: 'GEMS', isCurrent: () => false })).rejects.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
    let current = true;
    vi.stubGlobal('fetch', vi.fn(async () => { current = false; return new Response('{}'); }));
    await expect(api.postRaw('/paid', {}, { expectedCurrency: 'KEEP', isCurrent: () => current })).rejects.toBeDefined();
  });
});

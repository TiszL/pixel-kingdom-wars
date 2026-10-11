import { describe, expect, it } from 'vitest';
import { AVATAR_MAX_IN_FLIGHT, createAvatarQueue, defaultPortrait, isAvatarPath } from './avatars';

// Why: a realm map can show 1,024 kingdoms and the avatar route allows 360 requests a minute per wallet. A burst past
// that blanks every tag (native 560fe54/e26fa94); a dropped request leaves a tag on its default portrait for good; a
// transient failure remembered as permanent keeps the portraits after the radio reconnects.
const path = (i: number) => `/api/avatars/${String(i).padStart(8, '0')}-0000-4000-8000-000000000000.webp`;
const flush = () => new Promise<void>(resolve => { setTimeout(resolve, 0); }); // Response.blob() settles in a later task

function rig() {
  let t = 0;
  const pending: { url: string; resolve: (r: Response) => void; reject: (e: unknown) => void }[] = [];
  const timers: { at: number; fn: () => void }[] = [];
  const revoked: string[] = [];
  let changes = 0, n = 0;
  const q = createAvatarQueue({
    fetchImpl: url => new Promise<Response>((resolve, reject) => { pending.push({ url, resolve, reject }); }),
    createObjectURL: () => `blob:${++n}`,
    revokeObjectURL: u => { revoked.push(u); },
    onChange: () => { changes++; },
    now: () => t,
    setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); },
  });
  const image = () => new Response(new Blob([new Uint8Array([1])], { type: 'image/webp' }), { status: 200 });
  return {
    q, pending, revoked, timers, image,
    get changes() { return changes; },
    advance(ms: number) { t += ms; for (const x of timers.splice(0)) if (x.at <= t) x.fn(); else timers.push(x); },
  };
}

describe('realm-map avatar queue', () => {
  it('never has more than 4 requests in flight, and queues the rest instead of dropping them', async () => {
    const r = rig();
    for (let i = 0; i < 20; i++) expect(r.q.url(path(i))).toBeNull();
    expect(r.pending).toHaveLength(AVATAR_MAX_IN_FLIGHT);
    expect(r.q.stats().queued).toBe(16);
    let served = 0;
    while (r.pending.length) {
      expect(r.q.stats().inFlight).toBeLessThanOrEqual(4);
      r.pending.shift()!.resolve(r.image()); served++;
      await flush();
    }
    expect(served).toBe(20);
    expect(r.q.stats().maxInFlightSeen).toBe(4);
    expect(r.q.url(path(19))).toMatch(/^blob:/);
  });

  it("fetches only the server's own same-origin avatar paths", () => {
    const r = rig();
    for (const bad of ['https://tracking.invalid/x.webp', '/api/avatars/../me.webp', 'javascript:alert(1)', '', null, undefined]) expect(r.q.url(bad)).toBeNull();
    expect(r.pending).toHaveLength(0);
    expect(isAvatarPath(path(1))).toBe(true);
  });

  it('remembers a 404 for this visit only, and retries a transient failure after its backoff', async () => {
    const r = rig();
    r.q.url(path(1)); r.pending.shift()!.resolve(new Response(null, { status: 404 })); await flush();
    expect(r.q.url(path(1))).toBeNull(); expect(r.pending).toHaveLength(0);
    r.q.url(path(2)); r.pending.shift()!.resolve(new Response(null, { status: 503 })); await flush();
    expect(r.q.url(path(2))).toBeNull(); expect(r.pending).toHaveLength(0);
    const before = r.changes; r.advance(1_000); expect(r.changes).toBe(before + 1); // the map is woken to ask again
    r.q.url(path(2)); expect(r.pending).toHaveLength(1);
    r.pending.shift()!.resolve(r.image()); await flush();
    expect(r.q.url(path(2))).toMatch(/^blob:/);
    r.q.clear();
    r.q.url(path(1)); expect(r.pending).toHaveLength(1); // a new visit asks again
  });

  it('keeps an LRU of pictures and revokes what it evicts, never the one just shown', async () => {
    const r = rig();
    for (let i = 0; i < 33; i++) { r.q.url(path(i)); r.pending.shift()!.resolve(r.image()); await flush(); }
    expect(r.q.stats().cached).toBe(32);
    expect(r.revoked).toEqual(['blob:1']);
    r.q.url(path(1)); // shown again: now the most recent
    r.q.url(path(40)); r.pending.shift()!.resolve(r.image()); await flush();
    expect(r.revoked).toEqual(['blob:1', 'blob:3']);
    r.q.clear(); expect(r.revoked).toHaveLength(2 + 32);
  });

  it('the default portrait is a local image, never a request', () => {
    expect(defaultPortrait('Keeper', false)).toMatch(/^data:image\/svg\+xml,/);
    expect(decodeURIComponent(defaultPortrait('Ar Bel', true))).toContain('>AB<');
  });
});

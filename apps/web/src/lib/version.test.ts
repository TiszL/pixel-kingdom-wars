/**
 * compareVersions decides whether a player can play and whether they get nagged.
 * Getting it wrong in either direction is bad in a different way: too eager and
 * every player stares at a permanent banner (this genuinely shipped — see the
 * web-only deploy case below); too lax and they watch battles that never
 * happened. These pin both edges.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUILD, compareVersions, fetchDeployedWeb, fetchServerVersion, VERSION_REQUEST_TIMEOUT_MS,
  type DeployedWeb, type ServerVersion, versionedPublicAsset,
} from './version';
import { readFileSync } from 'node:fs';

/** A stamped release build — what a real deployed bundle looks like. BUILD in a
 *  test process is always the unstamped 'dev' one, so the release-only branches
 *  are unreachable without this. */
const LOCAL = { gitSha: 'aaaaaaa1111', simVersion: BUILD.simVersion };

const api = (over: Partial<ServerVersion> = {}): ServerVersion => ({
  version: '1.0.0', gitSha: 'apisha9999', builtAt: null, simVersion: LOCAL.simVersion, ...over,
});
const web = (over: Partial<DeployedWeb> = {}): DeployedWeb => ({
  version: '1.0.0', gitSha: LOCAL.gitSha, builtAt: null, ...over,
});

it('versions mutable public artifacts against the exact running bundle', () => {
  expect(versionedPublicAsset('/brand/ware/ui_portrait_keep_t1.png'))
    .toBe(`/brand/ware/ui_portrait_keep_t1.png?v=${encodeURIComponent(BUILD.gitSha)}`);
  expect(versionedPublicAsset('/brand/ui_forgescene.png?mode=still'))
    .toBe(`/brand/ui_forgescene.png?mode=still&v=${encodeURIComponent(BUILD.gitSha)}`);
});

describe('compareVersions', () => {
  it('is current when the deployed web build matches, whatever the API sha is', () => {
    // THE BUG THIS FILE EXISTS FOR. Soft updates used to compare the client sha
    // against the API sha — but web assets legitimately deploy far more often
    // than the API (that is the whole TWA update model), so the shas almost
    // always differ and the banner was PERMANENT: pressing RELOAD fetched the
    // same web build, which still disagreed with the API, forever.
    expect(compareVersions(api({ gitSha: 'completely-different' }), web(), LOCAL).kind)
      .toBe('current');
  });

  it('is SOFT exactly when a NEWER WEB BUILD is deployed than the one running', () => {
    expect(compareVersions(api(), web({ gitSha: 'bbbbbbb2222' }), LOCAL).kind).toBe('soft');
  });

  it('offers the replacement build even when its visible version name stays 0.5.8', () => {
    expect(compareVersions(api({ version: '0.5.8' }), web({ version: '0.5.8', gitSha: 'replacement' }), LOCAL).kind).toBe('soft');
  });

  it('FORCES on a simulator mismatch, in either direction', () => {
    // Replay correctness is client-vs-API. Both directions: a client ahead of
    // the server (an API rollback) desyncs exactly as badly as one behind it.
    expect(compareVersions(api({ simVersion: LOCAL.simVersion + 1 }), web(), LOCAL).kind).toBe('forced');
    expect(compareVersions(api({ simVersion: LOCAL.simVersion - 1 }), web(), LOCAL).kind).toBe('forced');
  });

  it('a sim mismatch outranks a pending web update', () => {
    // If the soft branch ran first, the one condition that must not be
    // dismissible would render as a dismissible banner.
    const s = compareVersions(
      api({ simVersion: LOCAL.simVersion + 1 }), web({ gitSha: 'bbbbbbb2222' }), LOCAL);
    expect(s.kind).toBe('forced');
  });

  it('says current when both sources are unreachable', () => {
    // Offline must never read as "out of date" — that would throw an update wall
    // at every player whose train went through a tunnel.
    expect(compareVersions(null, null, LOCAL).kind).toBe('current');
  });

  it('the API alone being reachable produces no soft banner', () => {
    // No version.json (the dev server, or a host that never got one) means the
    // deployed-web question is unanswerable — silence, not a guess from the API.
    expect(compareVersions(api({ gitSha: 'different' }), null, LOCAL).kind).toBe('current');
  });

  it('does not nag between unstamped dev builds', () => {
    expect(compareVersions(api(), web({ gitSha: 'dev' }), { gitSha: 'dev', simVersion: LOCAL.simVersion }).kind)
      .toBe('current');
    expect(compareVersions(api(), web({ gitSha: 'dev' }), LOCAL).kind).toBe('current');
  });
});

describe('bounded version discovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  const readers = [
    { name: 'API', read: fetchServerVersion, value: api() },
    { name: 'web', read: fetchDeployedWeb, value: web() },
  ];
  for (const { name, read, value } of readers) {
    it.each(['headers', 'body'])(`bounds stalled ${name} %s and ignores a late abort-ignoring response`, async (phase) => {
      let signal!: AbortSignal; let complete!: (value: never) => void;
      const stalled = new Promise<never>((resolve) => { complete = resolve; });
      const fetcher = vi.fn((_url: string, options?: RequestInit) => {
        signal = options!.signal!;
        return phase === 'headers' ? stalled : Promise.resolve({ ok: true, json: () => stalled });
      });
      vi.stubGlobal('fetch', fetcher);
      let finished = false;
      const result = read().finally(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(VERSION_REQUEST_TIMEOUT_MS - 1);
      expect(finished).toBe(false); expect(signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toBeNull(); expect(signal.aborted).toBe(true);
      complete((phase === 'headers' ? { ok: true, json: async () => value } : value) as never);
      await Promise.resolve(); await Promise.resolve();
      expect(await result).toBeNull(); expect(fetcher).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    });

    it(`returns valid ${name} metadata and cancels its deadline`, async () => {
      const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => value });
      vi.stubGlobal('fetch', fetcher);
      expect(await read()).toEqual(value);
      expect(fetcher.mock.calls[0]?.[1].cache).toBe('no-store');
      expect(vi.getTimerCount()).toBe(0);
    });

    it(`component cancellation immediately ends the ${name} body read`, async () => {
      let requestSignal!: AbortSignal;
      vi.stubGlobal('fetch', vi.fn((_url: string, options?: RequestInit) => {
        requestSignal = options!.signal!;
        return Promise.resolve({ ok: true, json: () => new Promise(() => {}) });
      }));
      const caller = new AbortController(); const result = read(caller.signal);
      await Promise.resolve(); caller.abort();
      expect(await result).toBeNull(); expect(requestSignal.aborted).toBe(true); expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['http', 'json', 'network', 'shape'])(`treats ${name} %s failure as unavailable, never as a version`, async (failure) => {
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (failure === 'network') throw new Error('offline');
        return { ok: failure !== 'http', json: async () => {
          if (failure === 'json') throw new SyntaxError('incomplete JSON');
          return failure === 'shape' ? { version: '0.5.8' } : value;
        } };
      }));
      expect(await read()).toBeNull(); expect(vi.getTimerCount()).toBe(0);
    });
  }
  it('an already-cancelled caller issues no network request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const caller = new AbortController(); caller.abort();
    expect(await fetchServerVersion(caller.signal)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('update cache cleanup', () => {
  it('preserves the verified mobile pack and durable push privacy fence while clearing build caches', () => {
    const source = readFileSync(new URL('./version.ts', import.meta.url), 'utf8');
    expect(source).toContain("k !== 'pkw-asset-pack-v1' && k !== 'pkw-push-session-v1'");
    expect(source).not.toContain('Promise.all(keys.map((k) => caches.delete(k)))');
  });
});

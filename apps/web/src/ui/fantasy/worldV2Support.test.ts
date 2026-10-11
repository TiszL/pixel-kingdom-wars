/** @vitest-environment happy-dom */
// The eager World v2 gate: flag first (a flag-off build must never even create a probe
// context, so production stays on the CPU globe until the owner turns it on), then WebGL2.
// Why no float-target check: the flat globe shader never renders to a float target, and
// demanding one would push phones that can draw the new world back to the old one.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ get: vi.fn(), track: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: { get: net.get } }));
vi.mock('../../lib/analytics', () => ({ EVENTS: { WORLD_V2_FALLBACK: 'world_v2_fallback' }, track: net.track }));
import {
  WORLD_V2_CAPABILITY_TIMEOUT_MS, WORLD_V2_CAPABILITY_TTL_MS, reportWorldV2Fallback, resetWorldV2Probe, worldV2Available, worldV2Capability,
  worldV2FlagEnabled, worldV2Problem,
} from './worldV2Support';

function stubContext(context: object | null) {
  const getContext = vi.fn(() => context);
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const element = create(tag);
    if (tag === 'canvas') Object.defineProperty(element, 'getContext', { value: getContext });
    return element;
  }) as typeof document.createElement);
  return getContext;
}
const context = () => {
  const lose = { loseContext: vi.fn() };
  return { lose, gl: { getExtension: vi.fn((name: string) => name === 'WEBGL_lose_context' ? lose : null) } };
};
/** A context whose WEBGL_debug_renderer_info names the rasteriser. */
const rendererContext = (renderer: string) => {
  const lose = { loseContext: vi.fn() }, info = { UNMASKED_RENDERER_WEBGL: 0x9246 };
  return { lose, gl: { RENDERER: 0x1f01, getParameter: vi.fn((name: number) => (name === 0x9246 ? renderer : 'WebKit WebGL')),
    getExtension: vi.fn((name: string) => (name === 'WEBGL_lose_context' ? lose : name === 'WEBGL_debug_renderer_info' ? info : null)) } };
};
const setSearch = (search: string) => window.history.replaceState(null, '', `/${search}`);

beforeEach(() => { resetWorldV2Probe(); net.get.mockReset(); net.track.mockReset(); net.get.mockReturnValue(new Promise(() => {})); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); resetWorldV2Probe(); setSearch(''); });

describe('World v2 gate', () => {
  it('is off unless the build flag is exactly "1", without probing the GPU or reading the capability', () => {
    const getContext = stubContext(context().gl);
    for (const value of ['0', '', 'true']) {
      vi.stubEnv('VITE_FEATURE_WORLD_V2', value);
      expect(worldV2FlagEnabled()).toBe(false);
      expect(worldV2Available()).toBe(false);
    }
    expect(getContext).not.toHaveBeenCalled();
    expect(net.get).not.toHaveBeenCalled();
  });

  it('keeps the CPU globe without WebGL2, or when the probe throws', () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(null);
    expect(worldV2Available()).toBe(false);
    expect(worldV2Problem()).toMatch(/WebGL2/);
    resetWorldV2Probe(); vi.restoreAllMocks();
    stubContext({ getExtension: () => { throw new Error('lost'); } });
    expect(worldV2Available()).toBe(false);
  });

  it('selects World v2 with plain WebGL2 (no float-target demand), releases the probe context, and probes once', () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    const { gl, lose } = context();
    const getContext = stubContext(gl);
    expect(worldV2Available()).toBe(true);
    expect(worldV2Available()).toBe(true);
    expect(getContext).toHaveBeenCalledOnce();
    expect(getContext).toHaveBeenCalledWith('webgl2');
    expect(gl.getExtension).not.toHaveBeenCalledWith('EXT_color_buffer_float');
    expect(lose.loseContext).toHaveBeenCalledOnce();
  });
});

// The kill-switch matrix at the gate. Why: the web shares native's D-180 switch, so the owner can send every web
// player back to the CPU globe without a release; but a slow or absent answer must never switch a working world off,
// and a software rasteriser (SwiftShader) draws the new world at a few frames a second, so it keeps the CPU globe
// unless QA forces it for captures.
describe('World v2 kill switch', () => {
  // (was "read once per session": review r2 (L9) made the answer expire after WORLD_V2_CAPABILITY_TTL_MS; within that
  // window it is still one read, which is what this pins; the flip across visits is pinned below)
  it('an explicit worldV2.enabled=false is read once per TTL window and closes the gate (logged once)', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(context().gl);
    net.get.mockResolvedValue({ protocolVersion: 1, worldV2: { enabled: false } });
    expect(worldV2Available()).toBe(true); // first visit: not known yet, WorldV2 awaits the same read
    await expect(worldV2Capability()).resolves.toBe(false);
    expect(worldV2Available()).toBe(false);
    expect(worldV2Available()).toBe(false);
    expect(net.get).toHaveBeenCalledOnce();
    expect(net.get).toHaveBeenCalledWith('/native/capabilities', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(net.track).toHaveBeenCalledOnce();
    expect(net.track).toHaveBeenCalledWith('world_v2_fallback', { reason: expect.stringMatching(/^capability-off/) });
  });

  // Review r2 (L9): the answer used to be cached for the page's life. A web tab or a Seeker TWA page that had opened
  // WORLD once kept building World v2 for days after the owner turned it off (and a timed-out first read never retried).
  // The next map visit after the TTL must obey the new answer, in both directions; within the TTL, no extra reads.
  it('re-reads the switch on a map visit after the TTL: a flip between two visits is obeyed', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(context().gl);
    net.get.mockResolvedValue({ worldV2: { enabled: true } });
    expect(worldV2Available()).toBe(true); // visit 1
    await expect(worldV2Capability()).resolves.toBe(true);
    net.get.mockResolvedValue({ worldV2: { enabled: false } }); // the owner turns it off
    await vi.advanceTimersByTimeAsync(WORLD_V2_CAPABILITY_TTL_MS - 1);
    await expect(worldV2Capability()).resolves.toBe(true); // still fresh: no read
    expect(net.get).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(worldV2Available()).toBe(true); // visit 2 starts the new read (WorldV2 awaits it before any GL engine)
    await expect(worldV2Capability()).resolves.toBe(false); // ... and falls back on it
    expect(net.get).toHaveBeenCalledTimes(2);
    expect(worldV2Available()).toBe(false); // visit 3 skips the chunk
    net.get.mockResolvedValue({ worldV2: { enabled: true } }); // turned back on
    await vi.advanceTimersByTimeAsync(WORLD_V2_CAPABILITY_TTL_MS);
    expect(worldV2Available()).toBe(true); // the next visit reads it again: not stuck on the old false
    await expect(worldV2Capability()).resolves.toBe(true);
    expect(net.get).toHaveBeenCalledTimes(3);
  });

  it('a timed-out read is retried on a visit after the TTL, not kept for the page\'s life', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(context().gl);
    const read = worldV2Capability(); // never answers
    await vi.advanceTimersByTimeAsync(WORLD_V2_CAPABILITY_TIMEOUT_MS);
    await expect(read).resolves.toBeNull();
    net.get.mockResolvedValue({ worldV2: { enabled: false } });
    await vi.advanceTimersByTimeAsync(WORLD_V2_CAPABILITY_TTL_MS);
    await expect(worldV2Capability()).resolves.toBe(false);
    expect(net.get).toHaveBeenCalledTimes(2);
  });

  it('a missing field or a failed read keeps the build default', async () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(context().gl);
    net.get.mockResolvedValue({ protocolVersion: 1 });
    await expect(worldV2Capability()).resolves.toBeNull();
    expect(worldV2Available()).toBe(true);
    resetWorldV2Probe();
    net.get.mockRejectedValue(new Error('offline'));
    await expect(worldV2Capability()).resolves.toBeNull();
    expect(worldV2Available()).toBe(true);
  });

  it('no answer within the timeout means the build default, and the late read is aborted', async () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(context().gl);
    let signal: AbortSignal | undefined;
    net.get.mockImplementation((_path: string, options: { signal: AbortSignal }) => { signal = options.signal; return new Promise(() => {}); });
    const read = worldV2Capability();
    await vi.advanceTimersByTimeAsync(WORLD_V2_CAPABILITY_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(read).resolves.toBeNull();
    expect(signal?.aborted).toBe(true);
    expect(worldV2Available()).toBe(true);
  });

  it.each(['Google SwiftShader', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)'])(
    'a software rasteriser (%s) keeps the CPU globe', renderer => {
      vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
      const { gl, lose } = rendererContext(renderer);
      stubContext(gl);
      expect(worldV2Available()).toBe(false);
      expect(worldV2Problem()).toMatch(/^software-rasteriser/);
      expect(lose.loseContext).toHaveBeenCalledOnce();
      expect(net.track).toHaveBeenCalledWith('world_v2_fallback', { reason: expect.stringMatching(/^software-rasteriser/) });
      // the GPU string itself is never sent
      expect(JSON.stringify(net.track.mock.calls)).not.toMatch(/SwiftShader|llvmpipe/);
    });

  it('?worldv2=force runs World v2 on a software rasteriser, but never without WebGL2', () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    setSearch('?worldv2=force');
    stubContext(rendererContext('Google SwiftShader').gl);
    expect(worldV2Available()).toBe(true);
    resetWorldV2Probe(); vi.restoreAllMocks();
    stubContext(null);
    expect(worldV2Available()).toBe(false);
  });

  it('a hardware renderer passes', () => {
    vi.stubEnv('VITE_FEATURE_WORLD_V2', '1');
    stubContext(rendererContext('Adreno (TM) 740').gl);
    expect(worldV2Available()).toBe(true);
    expect(net.track).not.toHaveBeenCalled();
  });

  it('logs each fallback reason once per session', () => {
    reportWorldV2Fallback('globe: WebGL2 unavailable');
    reportWorldV2Fallback('globe: WebGL2 unavailable');
    reportWorldV2Fallback('globe context lost');
    expect(net.track.mock.calls).toEqual([
      ['world_v2_fallback', { reason: 'globe: WebGL2 unavailable' }], ['world_v2_fallback', { reason: 'globe context lost' }]]);
  });
});

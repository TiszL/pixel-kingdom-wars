// Eager gate for World v2 (flat globe + realm maps, D-186). Lives outside worldv2/ on
// purpose: FantasyWorldLayer calls it before deciding whether to fetch the lazy WorldV2
// chunk, and nothing under worldv2/ may enter first paint. Keep it tiny, and never import
// worldv2/ from here.
//
// The kill switch has three layers (PLAN §1):
//   1. the build flag VITE_FEATURE_WORLD_V2 compiles the world in at all;
//   2. the shared runtime capability `worldV2.enabled` from GET /native/capabilities
//      (D-180, the switch native already reads): only an explicit `false` turns the web
//      world off; a missing field, an error or no answer within the timeout means the
//      build default (on);
//   3. the device: WebGL2, and not a software rasteriser (SwiftShader, llvmpipe), unless
//      the QA override `?worldv2=force` is in the page URL.
// Every refusal is logged once per session through the client telemetry shim.
import { api } from '../../lib/api';
import { EVENTS, track } from '../../lib/analytics';

/** How long the capability read may take before the build default applies. A client
 *  network limit, not a game number. */
export const WORLD_V2_CAPABILITY_TIMEOUT_MS = 3_000;
/** How long a settled capability answer is reused before the next map visit reads it again.
 *  A client cache window, not a game number: a web tab or a Seeker TWA page lives for days,
 *  and the owner's kill switch must reach it on its next visit, not at its next reload. */
export const WORLD_V2_CAPABILITY_TTL_MS = 60_000;

/** Build flag: the new world is compiled in only when this is exactly "1". */
export function worldV2FlagEnabled(): boolean {
  return import.meta.env.VITE_FEATURE_WORLD_V2 === '1';
}

/** QA override: `?worldv2=force` runs World v2 on a software rasteriser (SwiftShader
 *  captures). It never overrides the build flag, the capability or a missing WebGL2. */
export function worldV2Forced(): boolean {
  try { return new URLSearchParams(globalThis.location?.search ?? '').get('worldv2') === 'force'; } catch { return false; }
}

const SOFTWARE_RASTERISER = /swiftshader|llvmpipe|softpipe|software rasterizer/i;
let probed: { problem: string | null } | null = null;

/** Why this device cannot run World v2, or null when it can. The flat globe needs only
 *  WebGL2 (no float render targets, unlike the relief path); a software rasteriser can
 *  draw it, but at a few frames a second, so it keeps the CPU globe. Probed once per page;
 *  the probe context is released at once because browsers cap live contexts. */
export function worldV2Problem(): string | null {
  if (probed) return probed.problem;
  let problem: string | null = null;
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) problem = 'no-webgl2: WebGL2 is not available';
    else {
      try {
        const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
        const read = (name: number | undefined): string => (name !== undefined && typeof gl.getParameter === 'function' ? String(gl.getParameter(name) ?? '') : '');
        const renderer = `${read(info?.UNMASKED_RENDERER_WEBGL)} ${read(gl.RENDERER)}`;
        if (SOFTWARE_RASTERISER.test(renderer) && !worldV2Forced()) problem = 'software-rasteriser: WebGL2 runs on the CPU';
      } finally { gl.getExtension('WEBGL_lose_context')?.loseContext(); }
    }
  } catch { problem = 'probe-failed: WebGL2 probe failed'; }
  probed = { problem };
  return problem;
}

interface CapabilityRead { value: boolean | null; settled: boolean; settledAt: number; promise: Promise<boolean | null> }
let capability: CapabilityRead | null = null;

/** The shared runtime kill switch: false only when the server sends
 *  `worldV2: { enabled: false }`; null (the build default) when the field is missing, the
 *  read fails or it takes longer than WORLD_V2_CAPABILITY_TIMEOUT_MS. One read is shared
 *  while in flight and reused for WORLD_V2_CAPABILITY_TTL_MS after it settles; the first
 *  call after that (the next map visit) reads it again. */
export function worldV2Capability(): Promise<boolean | null> {
  if (capability && (!capability.settled || Date.now() - capability.settledAt < WORLD_V2_CAPABILITY_TTL_MS)) return capability.promise;
  const read: CapabilityRead = { value: null, settled: false, settledAt: 0, promise: Promise.resolve(null) };
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(null); }, WORLD_V2_CAPABILITY_TIMEOUT_MS); });
  const answer = api.get<unknown>('/native/capabilities', { signal: abort.signal }).then(body => {
    const switchField = (body as { worldV2?: { enabled?: unknown } } | null)?.worldV2?.enabled;
    return typeof switchField === 'boolean' ? switchField : null;
  }, () => null);
  read.promise = Promise.race([answer, late]).then(value => {
    clearTimeout(timer); read.value = value; read.settled = true; read.settledAt = Date.now(); return value;
  });
  capability = read;
  return read.promise;
}

const reported = new Set<string>();
/** Log why a visit left (or never reached) World v2, once per reason per session. The
 *  reason is a coarse category plus our own message: never a URL, wallet or GPU string. */
export function reportWorldV2Fallback(reason: string): void {
  const text = reason.slice(0, 120);
  if (reported.has(text)) return;
  reported.add(text);
  track(EVENTS.WORLD_V2_FALLBACK, { reason: text });
}

/** The layer renders WorldV2 only when the flag is on, the capability has not said false
 *  and the device qualifies. The flag is checked first, so a flag-off build never creates
 *  a probe context nor reads the capability. A call with no fresh answer (the first visit,
 *  or one after the TTL) starts the capability read; WorldV2 awaits that same read before
 *  it builds a GL engine, so an explicit false still ends on the CPU globe, and while the
 *  answer is fresh the chunk is skipped. */
export function worldV2Available(): boolean {
  if (!worldV2FlagEnabled()) return false;
  void worldV2Capability();
  if (capability?.settled && capability.value === false) { reportWorldV2Fallback('capability-off: worldV2.enabled is false'); return false; }
  const problem = worldV2Problem();
  if (problem) { reportWorldV2Fallback(problem); return false; }
  return true;
}

/** Test seam: forget the memoised probe, capability read and reported reasons. */
export function resetWorldV2Probe(): void { probed = null; capability = null; reported.clear(); }

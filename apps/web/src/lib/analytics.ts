/**
 * Client telemetry shim.
 *
 * NO SDK — posthog-js is ~50 KB against a 1000 KB first-paint wall, and the
 * authoritative record is our own backend anyway. This shim batches explicit
 * product events to POST /telemetry (sendBeacon on page-hide so exits are not
 * lost); the SERVER relays to PostHog/Sentry when keys are configured and
 * drops everything silently otherwise. Client events are the "screen viewed /
 * tutorial started" tier — anything that must be TRUE (raid resolved, deed
 * minted) is emitted server-side at its commit point, never from here.
 *
 * Privacy: no wallet addresses, no message bodies, no tokens. The server maps
 * the session to its internal analytics id; this file sends only event names,
 * bounded properties, build/platform context, a random per-tab session id and
 * a random per-device id (localStorage) that lets the server join a device's
 * pre-sign-in funnel to its wallet pseudonym — it identifies a browser
 * profile, never a person, and the server never stores it.
 *
 * Reliability tier: window errors and rejections are filtered through a
 * denylist (browser noise, wallet cancellations, the chunk-load and
 * maintenance errors every deploy manufactures) and de-duplicated per
 * session, because relaying them 1:1 turned each redeploy into a burst of
 * Sentry mail (audit 2026-09-05 SENTRY-04/05/06).
 *
 * See docs/ANALYTICS.md for the taxonomy and identity model.
 */
import { API_URL } from './api';
import { BUILD } from './version';
import { ATLAS_PREFIXES } from '@shardkeep/shared';

const MAX_QUEUE = 40;
const FLUSH_MS = 15_000;
const MAX_PROP_CHARS = 200;
/** Per-session error dedupe memory; past this, new keys are sent untracked. */
const MAX_ERROR_KEYS = 200;
const DEVICE_KEY = 'pkw:analytics-device';
const ID_RE = /^[A-Za-z0-9-]{8,36}$/;

/**
 * Every client-emitted event name. `track()` accepts ONLY these, so a typo or
 * a name that drifts from docs/ANALYTICS.md fails typecheck instead of
 * silently starting a new series in PostHog. Server-emitted names
 * (login_completed, raid_resolved…) live beside their commit points in
 * apps/api and are listed in the same doc.
 */
export const EVENTS = {
  APP_OPENED: 'app_opened',
  APP_ERROR: 'app_error',
  APP_UNHANDLED_REJECTION: 'app_unhandled_rejection',
  TUTORIAL_STEP: 'tutorial_step',
  TUTORIAL_COMPLETED: 'tutorial_completed',
  TUTORIAL_GUIDE_SKIPPED: 'tutorial_guide_skipped',
  LAND_CREDITED: 'land_credited',
  LAND_RESERVE: 'land_reserve',
  LAND_PAY: 'land_pay',
  LAND_FAILED: 'land_failed',
  LAND_EXPIRED: 'land_expired',
  EXCHANGE_OPENED: 'exchange_opened',
  REFERRAL_LINK_SHARED: 'referral_link_shared',
  TESTER_SCREEN_OPENED: 'tester_screen_opened',
  TESTER_MILESTONES_ANNOUNCED: 'tester_milestones_announced',
  DEVNET_FAUCET_CLAIM: 'devnet_faucet_claim',
  DEVNET_FAUCET_FUNDED: 'devnet_faucet_funded',
  DEVNET_FAUCET_FAILED: 'devnet_faucet_failed',
  PHANTOM_MOBILE_CONNECT: 'phantom_mobile_connect',
  AUTH_SESSION_PHASE: 'auth_session_phase',
  LANDSCAPE_PREF: 'landscape_pref',
  NOTIFICATIONS_PERMISSION: 'notifications_permission',
  PERF_SUMMARY: 'perf_summary',
  PUSH_ENABLED: 'push_enabled',
  PUSH_DISABLED: 'push_disabled',
  WORLD_V2_FALLBACK: 'world_v2_fallback',
} as const;
export type EventName = (typeof EVENTS)[keyof typeof EVENTS];

type Props = Record<string, string | number | boolean>;

interface TelemetryEvent {
  event: string;
  eventId: string;
  ts: string;
  props?: Props;
}

let queue: TelemetryEvent[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
let context: Record<string, string | number | boolean> = {};
let deviceId: string | null = null;

/** Stable per-browser-profile id. Random, first-party, never derived from
 * anything; a storage failure (private mode, quota) degrades to a per-load id. */
export function getDeviceId(): string {
  if (deviceId) return deviceId;
  let id: string | null = null;
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored && ID_RE.test(stored)) id = stored;
  } catch { /* storage unavailable */ }
  if (!id) {
    id = crypto.randomUUID();
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* per-load fallback */ }
  }
  deviceId = id;
  return id;
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; flush(); }, FLUSH_MS);
}

function bound(props: Props | undefined): Props | undefined {
  if (!props) return undefined;
  const out: Props = {};
  for (const [k, v] of Object.entries(props)) {
    out[k] = typeof v === 'string' ? v.slice(0, MAX_PROP_CHARS) : v;
  }
  return out;
}

function enqueue(event: string, props: Props | undefined): void {
  const bounded = bound(props);
  queue.push({
    event: event.slice(0, 64),
    eventId: crypto.randomUUID(),
    ts: new Date().toISOString(),
    ...(bounded ? { props: bounded } : {}),
  });
}

function send(batch: TelemetryEvent[], useBeacon: boolean): void {
  const body = JSON.stringify({ context, events: batch });
  const url = `${API_URL}/telemetry`;
  try {
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    void fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => null);
  } catch { /* telemetry must never break gameplay */ }
}

function flush(useBeacon = false): void {
  drainRepeats();
  // The server accepts at most MAX_QUEUE events per body; a drain can push a
  // batch past it, so send in chunks rather than have the sink drop it all.
  while (queue.length > 0) send(queue.splice(0, MAX_QUEUE), useBeacon);
}

/** Record one explicit product event. Fire-and-forget; never throws. */
export function track(event: EventName, props?: Props): void {
  try {
    enqueue(event, props);
    if (queue.length >= MAX_QUEUE) flush();
    else scheduleFlush();
  } catch { /* never break gameplay */ }
}

// ---------------------------------------------------------------------------
// Reliability tier
// ---------------------------------------------------------------------------

export type ErrorKind = 'error' | 'unhandledrejection';

/** Coarse boot/restore categories only; no request URLs, bodies or identities. */
export interface ErrorDiagnostics {
  renderState?: 'loop-stopped' | 'context-lost' | undefined;
  contextState?: 'available' | 'lost' | 'restored' | undefined;
  activeScene?: 'base' | 'battle' | 'none' | undefined;
  sceneState?: 'loading' | 'ready' | 'failed' | undefined;
  prepLoadProtocol?: 'h1' | 'h2' | 'h3' | 'unknown' | undefined;
  prepLoadReason?: 'complete' | 'idle-timeout' | 'active-deadline' | 'network' | 'http' | 'range' | 'size' | 'integrity' | 'decode' | undefined;
  prepLoadAttempt?: number | undefined;
  prepLoadActiveMs?: number | undefined;
  prepPhase?: 'base' | 'download' | 'verify' | 'decode' | 'terrain' | 'upload' | 'walls' | 'ready' | undefined;
  stepAgeMs?: number | undefined;
  renderAgeMs?: number | undefined;
  prepCompleted?: number | undefined;
  prepTotal?: number | undefined;
  prepWidth?: number | undefined;
  prepHeight?: number | undefined;
  prepDownloadMs?: number | undefined;
  prepVerifyMs?: number | undefined;
  prepDecodeMs?: number | undefined;
  prepPaintMs?: number | undefined;
  prepUploadMs?: number | undefined;
  prepMaxPaintBatchMs?: number | undefined;
  sceneActive?: boolean | undefined;
  sceneVisible?: boolean | undefined;
  prepCacheHit?: boolean | undefined;
  loadProfile?: 'full' | 'constrained' | undefined;
  loadReason?: 'complete' | 'idle-timeout' | 'active-deadline' | undefined;
  loadFirstReason?: 'complete' | 'idle-timeout' | 'active-deadline' | undefined;
  loadFirstActiveMs?: number | undefined;
  loadFirstLoadedBytes?: number | undefined;
  loadAttempt?: number | undefined;
  loadActiveMs?: number | undefined;
  loadBudgetMs?: number | undefined;
  loadQueued?: number | undefined;
  loadInflight?: number | undefined;
  loadProcessing?: number | undefined;
  loadFailures?: string | undefined;
  workerState?: 'none' | 'current' | 'previous' | undefined;
  restoreReason?: 'timeout' | 'changed' | 'request' | undefined;
  restoreStage?: 'base_snapshot' | 'raid_recovery' | undefined;
  httpStatus?: number | undefined;
}

const LOAD_FAILURE_RE = new RegExp(`^(?:(?:${ATLAS_PREFIXES.join('|')})-(?:img|json)|sprite-meta):(image|json):(queued|loading|processing|complete|failed):(-|[0-9]{1,2}):(-|[0-5]?[0-9]{1,2}):([0-9]{1,9})/([0-9]{1,9})$`);

function errorDiagnostics(props: ErrorDiagnostics | undefined): Props {
  const out: Props = {};
  if (!props) return out;
  for (const [key, values] of Object.entries({
    renderState: ['loop-stopped', 'context-lost'],
    contextState: ['available', 'lost', 'restored'],
    activeScene: ['base', 'battle', 'none'],
    sceneState: ['loading', 'ready', 'failed'],
    prepLoadProtocol: ['h1', 'h2', 'h3', 'unknown'],
    prepLoadReason: ['complete', 'idle-timeout', 'active-deadline', 'network', 'http', 'range', 'size', 'integrity', 'decode'],
    prepPhase: ['base', 'download', 'verify', 'decode', 'terrain', 'upload', 'walls', 'ready'],
    loadProfile: ['full', 'constrained'], loadReason: ['complete', 'idle-timeout', 'active-deadline'],
    loadFirstReason: ['complete', 'idle-timeout', 'active-deadline'],
    workerState: ['none', 'current', 'previous'], restoreReason: ['timeout', 'changed', 'request'],
    restoreStage: ['base_snapshot', 'raid_recovery'],
  })) {
    const value = props[key as keyof ErrorDiagnostics];
    if (typeof value === 'string' && values.includes(value)) out[key] = value;
  }
  for (const [key, [min, max]] of Object.entries({
    stepAgeMs: [0, 600000],
    renderAgeMs: [0, 600000],
    prepLoadAttempt: [1, 3], prepLoadActiveMs: [0, 120000],
    prepCompleted: [0, 100000000],
    prepTotal: [0, 100000000],
    prepWidth: [0, 16384],
    prepHeight: [0, 16384],
    prepDownloadMs: [0, 600000],
    prepVerifyMs: [0, 600000],
    prepDecodeMs: [0, 600000],
    prepPaintMs: [0, 600000],
    prepUploadMs: [0, 600000],
    prepMaxPaintBatchMs: [0, 600000],
    loadAttempt: [1, 2], loadActiveMs: [0, 600_000], loadBudgetMs: [0, 600_000],
    loadFirstActiveMs: [0, 600_000], loadFirstLoadedBytes: [0, 100_000_000],
    loadQueued: [0, 1_000], loadInflight: [0, 1_000], loadProcessing: [0, 1_000], httpStatus: [0, 599],
  } as const)) {
    const value = props[key as keyof ErrorDiagnostics];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max) out[key] = value;
  }
  for (const key of ['sceneActive', 'sceneVisible', 'prepCacheHit'] as const) {
    if (typeof props[key] === 'boolean') out[key] = props[key];
  }
  const failures = props.loadFailures;
  if (typeof failures === 'string' && failures.length <= MAX_PROP_CHARS && failures.split(';').every(entry => {
    const match = LOAD_FAILURE_RE.exec(entry);
    return match !== null && Number(match[5]) <= 100_000_000 && Number(match[6]) <= 100_000_000;
  })) out['loadFailures'] = failures;
  return out;
}

export interface ErrorReport {
  message: string;
  /** Coarse JS file/line for window errors or rejections; never a raw stack. */
  source?: string | undefined;
  /** Error class name (TypeError, AbortError…) when the thrower had one. */
  name?: string | undefined;
  /** Machine code (ApiError.code, wallet 4001…) when the thrower had one. */
  code?: string | undefined;
  boundary?: 'overlay' | 'game' | undefined;
  screen?: string | undefined;
  diagnostics?: ErrorDiagnostics | undefined;
}

const CHUNK_LOAD_RE = /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;
const WALLET_CANCEL_RE = /user rejected|denied|cancell?ed/i;
const NOISE_CODES = new Set(['NETWORK_UNAVAILABLE', 'MAINTENANCE', '4001', 'AbortError']);

/**
 * Is this error worth a Sentry event? False for what an operator can do
 * nothing about: cross-origin "Script error." with no source, the benign
 * ResizeObserver loop, wallet cancellations (4001 / "user rejected"), aborted
 * fetches, and the two things EVERY deploy manufactures — chunk-load failures
 * on stale bundles and the MAINTENANCE / NETWORK_UNAVAILABLE rejections during
 * the drain window. Each of those used to arrive 1:1 as error mail.
 */
export function shouldReport(
  kind: ErrorKind, message: string, source?: string, code?: string, name?: string,
): boolean {
  void kind;
  const msg = String(message ?? '');
  if (msg === 'Script error.' && (!source || source === ':0')) return false;
  if (/ResizeObserver loop/.test(msg)) return false;
  if (code !== undefined && NOISE_CODES.has(String(code))) return false;
  if (name === 'AbortError' || /^AbortError\b/.test(msg)) return false;
  if (WALLET_CANCEL_RE.test(msg)) return false;
  if (CHUNK_LOAD_RE.test(msg)) return false;
  return true;
}

/** `index-BQ3jK2sr.js:12` → `index.js:12`: the content hash changes on every
 *  deploy and would otherwise split one bug into one Sentry issue per release. */
export function stripChunkHash(source: string): string {
  return source.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+(?::\d+)*$)/i, '');
}

interface SeenError { event: EventName; props: Props; repeats: number }
const seen = new Map<string, SeenError>();

/**
 * Report one error through the denylist and the per-session dedupe: the first
 * occurrence of a (kind|message|source) key is sent at once with `count: 1`;
 * repeats only bump a counter that the next flush sends as ONE event carrying
 * `count` — so a render loop throwing 60 times a second costs one event per
 * flush, not sixty per second.
 */
export function captureError(kind: ErrorKind, report: ErrorReport): void {
  try {
    const message = String(report.message ?? '').slice(0, MAX_PROP_CHARS);
    const source = report.source !== undefined ? stripChunkHash(report.source).slice(0, MAX_PROP_CHARS) : undefined;
    if (!shouldReport(kind, message, source, report.code, report.name)) return;
    const key = `${kind}|${message}|${source ?? ''}`;
    const prev = seen.get(key);
    if (prev) {
      prev.repeats += 1;
      scheduleFlush();
      return;
    }
    const event = kind === 'error' ? EVENTS.APP_ERROR : EVENTS.APP_UNHANDLED_REJECTION;
    const props: Props = {
      message,
      ...(source !== undefined ? { source } : {}),
      ...(report.name ? { name: report.name.slice(0, 64) } : {}),
      ...(report.code ? { code: String(report.code).slice(0, 64) } : {}),
      ...(report.boundary ? { boundary: report.boundary } : {}),
      ...(report.screen ? { screen: report.screen.slice(0, 64) } : {}),
      ...errorDiagnostics(report.diagnostics),
    };
    if (seen.size < MAX_ERROR_KEYS) seen.set(key, { event, props, repeats: 0 });
    track(event, { ...props, count: 1 });
  } catch { /* never break gameplay */ }
}

function drainRepeats(): void {
  for (const entry of seen.values()) {
    if (entry.repeats === 0) continue;
    enqueue(entry.event, { ...entry.props, count: entry.repeats });
    entry.repeats = 0;
  }
}

/** window 'error' listener. Only name/message/coarse location travel — never
 *  stack-local values. */
export function handleErrorEvent(e: { message?: unknown; filename?: unknown; lineno?: unknown; error?: unknown }): void {
  const err = e.error as { name?: unknown; code?: unknown } | null | undefined;
  captureError('error', {
    message: String(e.message ?? ''),
    source: `${String(e.filename ?? '').split('/').pop() ?? ''}:${Number(e.lineno) || 0}`,
    name: typeof err?.name === 'string' ? err.name : undefined,
    code: err?.code !== undefined && err?.code !== null ? String(err.code) : undefined,
  });
}

/** One original JS frame helps locate a rejection without sending origins,
 * paths, URL credentials/parameters, function arguments or the full stack. */
function rejectionSource(reason: unknown): string | undefined {
  try {
    const stack = (reason as { stack?: unknown } | null)?.stack;
    if (typeof stack !== 'string') return undefined;
    for (const line of stack.slice(0, 8_000).split(/\r?\n/).slice(0, 12)) {
      const frame = line.match(/(?:^\s*at\s+(?:[^()\n]*\()?|^[^@\n]*@)((?:https?|chrome-extension|moz-extension):\/\/[^\s)]+)\)?\s*$/);
      const location = frame?.[1]?.match(/^(.*):(\d{1,9})(?::(\d{1,9}))$/);
      if (!location) continue;
      const file = new URL(location[1]!).pathname.split('/').pop();
      if (!file || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,95}\.[cm]?js$/.test(file)) continue;
      return `${file}:${location[2]}:${location[3]}`;
    }
  } catch { /* Missing or hostile error properties must never cause another error. */ }
  return undefined;
}

/** window 'unhandledrejection' listener. Preserve only an original coarse
 * source; constructing a new Error here would falsely identify this handler. */
export function handleRejectionEvent(e: { reason?: unknown }): void {
  let reason: unknown;
  try { reason = e.reason; } catch {
    captureError('unhandledrejection', { message: 'Unknown rejection' });
    return;
  }
  const read = (key: 'message' | 'name' | 'code'): unknown => {
    try { return (reason as Record<string, unknown> | null)?.[key]; } catch { return undefined; }
  };
  let message = 'Unknown rejection';
  let code: string | undefined;
  try {
    message = String(read('message') ?? (reason !== null && typeof reason === 'object' ? message : reason ?? ''));
  } catch { /* retain the bounded fallback when string coercion itself fails */ }
  try {
    const value = read('code');
    if (value !== undefined && value !== null) code = String(value);
  } catch { /* an unreadable optional code must not hide the original error */ }
  const name = read('name');
  captureError('unhandledrejection', {
    message,
    source: rejectionSource(reason),
    name: typeof name === 'string' ? name : undefined,
    code,
  });
}

/** Install once at boot: session context + global error capture. */
export function initAnalytics(): void {
  try {
    context = {
      sessionId: crypto.randomUUID(),
      deviceId: getDeviceId(),
      buildVersion: BUILD.version,
      gitSha: BUILD.gitSha.slice(0, 7),
      simVersion: BUILD.simVersion,
      platform: /android/i.test(navigator.userAgent) ? 'android'
        : /iphone|ipad/i.test(navigator.userAgent) ? 'ios' : 'desktop',
      solanaMobile: new URLSearchParams(window.location.search).get('client') === 'solana-mobile'
        || localStorage.getItem('pkw:solana-mobile-client') != null,
    };
    // Reliability tier: uncaught errors previously vanished into the console.
    window.addEventListener('error', handleErrorEvent);
    window.addEventListener('unhandledrejection', handleRejectionEvent);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush(true);
    });
    track(EVENTS.APP_OPENED);
  } catch { /* boot must not depend on telemetry */ }
}

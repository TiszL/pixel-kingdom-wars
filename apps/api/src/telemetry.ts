/**
 * Privacy-preserving analytics relay.
 *
 * The AUTHORITATIVE record is Postgres + Solana confirmations; PostHog exists
 * for funnels/retention dashboards and Sentry for the reliability tier (client
 * errors AND this process's own 500s / failed jobs). Both are OPTIONAL relays:
 * with no keys configured every entry point here is a validated no-op;
 * operators enable a relay through the environment.
 *
 * Privacy rules:
 *  - identity is a pseudonymous HMAC of the wallet (never the raw address);
 *  - no message bodies, no emails, no tokens, no signed payloads;
 *  - configured internal wallets are tagged is_internal so aggregate product
 *    reporting can exclude development and test activity.
 *
 * Fire-and-forget by design: a slow or failing analytics vendor must never
 * hold a game request or transaction. Nothing here throws; sends are batched
 * in memory (one API replica — K-020 posture), flushed on an interval and
 * drained once more on close so a deploy's SIGTERM does not lose the last
 * buffer (audit 2026-09-05 POSTHOG-01: ~7 deploys a day silently dropped up
 * to 10 s of events each).
 *
 * Vendor answers are READ, not swallowed: a 401 from a rotated key or the
 * wrong PostHog cloud used to be indistinguishable from success. Non-2xx
 * responses count in `relayStats` (surfaced on /health) and log one
 * rate-limited warning that never includes the key.
 *
 * See docs/ANALYTICS.md for the event taxonomy, identity model and the Sentry
 * release convention this file implements.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { Config } from './config';
import { BUILD } from './version';

interface RelayEvent {
  event: string;
  distinctId: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

const FLUSH_MS = 10_000;
const MAX_BUFFER = 500;
/** One "relay rejected" warning per minute, across both vendors. */
const REJECT_WARN_MS = 60_000;
/** $identify idempotency memory (wallet|deviceId pairs). One replica (K-020);
 *  a restart re-identifies once per pair, which PostHog treats as a no-op. */
const IDENTIFIED_MAX = 5_000;
/** Server-error relay token bucket: a crash loop must not become a Sentry
 *  quota incident or add outbound traffic to an already-failing process. */
const SERVER_ERROR_TOKENS_PER_MIN = 10;
/** Client device ids are caller-controlled text: UUID-shaped or ignored. */
const DEVICE_ID_RE = /^[A-Za-z0-9-]{8,36}$/;

let cfg: Config | null = null;
let buffer: RelayEvent[] = [];
let timer: NodeJS.Timeout | null = null;
let internalWallets = new Set<string>();
let lastRejectWarnAt = 0;
const identified = new Set<string>();
let errorTokens = SERVER_ERROR_TOKENS_PER_MIN;
let errorTokensAt = Date.now();
/** In-flight Sentry posts, so `flushTelemetry()` (onClose) can drain them. */
const inflight = new Set<Promise<void>>();

/**
 * Relay outcome counters, in EVENTS (a rejected PostHog batch of 40 counts
 * 40). Exposed on GET /health so "PostHog has been answering 401 since the key
 * rotation" is visible from outside the box instead of nowhere at all.
 */
export const relayStats = { sent: 0, rejected: 0, failed: 0 };

/** Arm the relays. Idempotent and non-destructive: server.ts calls it before
 *  the workers start (their failed jobs relay too) and buildApp calls it again;
 *  neither call drops anything already buffered. */
export function initTelemetry(config: Config): void {
  cfg = config;
  internalWallets = new Set([
    ...(config.ALPHA_WALLETS ?? []),
    ...(config.ADMIN_WALLETS ?? []),
  ]);
}

/** TESTS ONLY — drop buffered events and zero every counter/limiter so one
 *  suite's relay state never leaks into the next assertion. */
export function resetTelemetry(): void {
  buffer = [];
  if (timer) { clearTimeout(timer); timer = null; }
  identified.clear();
  relayStats.sent = 0; relayStats.rejected = 0; relayStats.failed = 0;
  lastRejectWarnAt = 0;
  errorTokens = SERVER_ERROR_TOKENS_PER_MIN;
  errorTokensAt = Date.now();
}

/** Pseudonymous analytics identity — stable per wallet, irreversible without
 * the server secret. Anonymous (pre-auth) events use the client's persisted
 * device id when it sent one (so a funnel survives a reload and can later be
 * joined to the wallet by `$identify`), else the per-tab session id. */
export function analyticsId(wallet: string | null, sessionId?: string, deviceId?: string): string {
  if (!wallet) {
    const anon = deviceId && DEVICE_ID_RE.test(deviceId) ? deviceId : sessionId;
    return `anon:${(anon ?? 'unknown').slice(0, 36)}`;
  }
  if (!cfg) return 'uninitialized';
  return createHmac('sha256', `pkw-analytics:${cfg.JWT_SECRET}`)
    .update(wallet).digest('hex').slice(0, 16);
}

/** Keyed short hash for a caller-visible secret-ish value (a referral code)
 * that must be COUNTABLE in analytics but never readable there. */
export function hashForAnalytics(value: string): string {
  if (!cfg) return 'uninitialized';
  return createHmac('sha256', `pkw-analytics-hash:${cfg.JWT_SECRET}`)
    .update(value).digest('hex').slice(0, 8);
}

export function isInternalWallet(wallet: string | null): boolean {
  return wallet !== null && internalWallets.has(wallet);
}

function environment(): 'production' | 'development' {
  return cfg?.NODE_ENV === 'production' ? 'production' : 'development';
}

function warnRejected(vendor: 'posthog' | 'sentry', status: number, n: number): void {
  const now = Date.now();
  if (now - lastRejectWarnAt < REJECT_WARN_MS) return;
  lastRejectWarnAt = now;
  // Never the key, never a body: status + size is enough to tell "wrong cloud
  // / rotated key" (401) from "vendor incident" (5xx).
  console.warn(`[telemetry] ${vendor} relay rejected batch`, { status, n });
}

function scheduleFlush(): void {
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flush(); }, FLUSH_MS);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (!cfg?.POSTHOG_API_KEY || buffer.length === 0) { buffer = []; return; }
  const batch = buffer;
  buffer = [];
  const host = cfg.POSTHOG_HOST ?? 'https://us.i.posthog.com';
  try {
    const res = await fetch(`${host}/batch/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.POSTHOG_API_KEY,
        batch: batch.map((e) => ({
          event: e.event,
          distinct_id: e.distinctId,
          timestamp: e.timestamp,
          properties: e.properties,
        })),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) relayStats.sent += batch.length;
    else {
      relayStats.rejected += batch.length;
      warnRejected('posthog', res.status, batch.length);
    }
  } catch {
    // vendor down — analytics loss is acceptable, game latency is not
    relayStats.failed += batch.length;
  }
}

/**
 * Drain everything now: the pending PostHog batch and any in-flight Sentry
 * posts. Registered as the app's onClose hook so SIGTERM (every deploy)
 * flushes instead of dropping the last FLUSH_MS of events.
 */
export async function flushTelemetry(): Promise<void> {
  try {
    if (timer) { clearTimeout(timer); timer = null; }
    await flush();
    await Promise.allSettled([...inflight]);
  } catch { /* draining is best-effort */ }
}

function push(e: RelayEvent): void {
  buffer.push(e);
  if (buffer.length >= MAX_BUFFER) void flush();
  else scheduleFlush();
}

/**
 * Record one event. `wallet` is hashed here — callers pass the raw wallet and
 * this boundary guarantees it never leaves the box. Server-authoritative
 * callers (raid resolved, deed minted…) call this AFTER their transaction
 * commits, per the brief's count-confirmed-state-changes rule.
 */
export function serverTrack(
  event: string,
  wallet: string | null,
  properties: Record<string, unknown> = {},
  opts?: { sessionId?: string; deviceId?: string; eventId?: string; timestamp?: string },
): void {
  try {
    if (!cfg?.POSTHOG_API_KEY) return;
    push({
      event,
      distinctId: analyticsId(wallet, opts?.sessionId, opts?.deviceId),
      timestamp: opts?.timestamp ?? new Date().toISOString(),
      properties: {
        ...properties,
        is_internal: isInternalWallet(wallet),
        network: 'devnet',
        ...(opts?.eventId ? { event_id: opts.eventId } : {}),
      },
    });
  } catch { /* never break the caller */ }
}

/**
 * Join a device's anonymous history to its wallet pseudonym — ONCE per
 * (wallet, device). Called after a successful sign-in. Without this every
 * funnel broke at login: pre-auth events lived under `anon:<device>` and
 * post-auth ones under the HMAC, and PostHog never learned they were the same
 * person (audit 2026-09-05 PA-01). Plain `$identify` only — never
 * `$merge_dangerously`, which can fuse two real players.
 *
 * Idempotency is an in-memory set: correct for the one-replica K-020 posture;
 * a second replica would re-send at most one $identify per pair, which
 * PostHog treats as a no-op.
 */
export function identifyDevice(wallet: string, deviceId: string | undefined): boolean {
  try {
    if (!cfg?.POSTHOG_API_KEY || !deviceId || !DEVICE_ID_RE.test(deviceId)) return false;
    const key = `${analyticsId(wallet)}|${deviceId}`;
    if (identified.has(key)) return false;
    if (identified.size >= IDENTIFIED_MAX) {
      const oldest = identified.values().next().value;
      if (oldest !== undefined) identified.delete(oldest);
    }
    identified.add(key);
    push({
      event: '$identify',
      distinctId: analyticsId(wallet),
      timestamp: new Date().toISOString(),
      properties: {
        $anon_distinct_id: `anon:${deviceId}`,
        $set: { is_internal: isInternalWallet(wallet) },
        is_internal: isInternalWallet(wallet),
        network: 'devnet',
      },
    });
    return true;
  } catch { return false; }
}

/**
 * `$pageview` properties for the one page the game has. `WEB_ORIGIN` is the
 * credentialed CORS allowlist and production may list more than one origin,
 * so the explicit `PLAY_URL` — where invite mail already sends players — is
 * the address of record when it is set; `WEB_ORIGIN[0]` is the fallback for
 * local/dev configs that never set it. A path on PLAY_URL is kept: PostHog's
 * path filters must see the route players actually land on.
 */
export function pageviewProps(
  config: Pick<Config, 'PLAY_URL' | 'WEB_ORIGIN'>,
): { $current_url: string; $host: string; $pathname: string } {
  const url = new URL(config.PLAY_URL ?? config.WEB_ORIGIN[0] ?? 'http://localhost:5173');
  const pathname = url.pathname || '/';
  return { $current_url: `${url.origin}${pathname}`, $host: url.host, $pathname: pathname };
}

// ---------------------------------------------------------------------------
// Sentry (store endpoint, hand-rolled: the official SDK is a dependency this
// narrow use does not justify — and on the client it would be a first-paint
// dependency against the 1000 KB wall).
// ---------------------------------------------------------------------------

function sentryTarget(): { url: string; auth: string } | null {
  if (!cfg?.SENTRY_DSN) return null;
  const dsn = new URL(cfg.SENTRY_DSN);
  const projectId = dsn.pathname.replace(/^\//, '');
  const key = dsn.username;
  if (!projectId || !key) return null;
  return {
    url: `${dsn.protocol}//${dsn.host}/api/${projectId}/store/`,
    auth: `Sentry sentry_version=7, sentry_key=${key}, sentry_client=pkw-relay/1.0`,
  };
}

function postSentry(payload: Record<string, unknown>): void {
  const target = sentryTarget();
  if (!target) return;
  const p = fetch(target.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Sentry-Auth': target.auth },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(8_000),
  }).then((res) => {
    if (res.ok) relayStats.sent += 1;
    else { relayStats.rejected += 1; warnRejected('sentry', res.status, 1); }
  }).catch(() => { relayStats.failed += 1; })
    .finally(() => { inflight.delete(p); });
  inflight.add(p);
}

/** Sentry event ids are 32 lowercase hex characters (a UUID without dashes). */
function sentryEventId(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * Grouping key for a client error must survive a deploy. Vite names every
 * chunk `<name>-<8-char content hash>.js`, so a raw `source` changed on every
 * release and Sentry opened a "new" issue (and re-opened a "regression") for
 * the same bug each time (audit SENTRY-03). Keep the chunk NAME, drop the
 * hash, the line/column and any URL path.
 */
export function normalizeSource(source: string | undefined): string {
  if (!source) return '';
  let s = source.trim().split('?')[0] ?? '';
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/(:\d+)+$/, '');
  s = s.replace(/-[A-Za-z0-9_-]{8}(?=\.[a-z0-9]+$)/i, '');
  return s.slice(0, 120);
}

/** Same rule for the message: asset URLs, chunk hashes, line:col pairs and
 *  long numbers (ids, timestamps) vary per deploy or per player, never per bug. */
export function normalizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s'")]+/g, '<url>')
    .replace(/-[A-Za-z0-9_-]{8}(?=\.[cm]?js\b)/g, '')
    .replace(/:\d+:\d+\b/g, '')
    .replace(/\b\d{4,}\b/g, '<n>')
    .trim()
    .slice(0, 200);
}

export interface ClientErrorReport {
  /** `error` for window.onerror / React boundaries, `unhandledrejection` for promises. */
  kind: 'error' | 'unhandledrejection';
  message: string;
  source?: string | undefined;
  /** Error class name when the client had one (TypeError, ChunkLoadError…). */
  name?: string | undefined;
  code?: string | undefined;
  /** Client-side per-session dedupe: how many occurrences this report stands for. */
  count?: number | undefined;
  /** The client's telemetry context (buildVersion, gitSha, platform, solanaMobile…). */
  context: Record<string, unknown>;
  /** Pseudonymous id from analyticsId() — never a wallet. */
  pseudonym: string;
  userAgent?: string | undefined;
}

/** Native sends fixed diagnostics, never Throwable/provider text. Reconstruct
 * its context independently so the legacy web extras contract cannot admit
 * credentials or device identifiers into a native reliability event. */
export function sanitizeNativeTelemetryContext(input: Record<string, unknown>): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = { platform: 'android-native' };
  const rules: Record<string, RegExp> = {
    gitSha: /^(?:dev|unknown|[a-f0-9]{7,40})$/i,
    buildVersion: /^[A-Za-z0-9][A-Za-z0-9._+-]*:[0-9]{1,10}$/,
  };
  for (const [key, pattern] of Object.entries(rules)) {
    const value = input[key];
    if (typeof value === 'string' && value.length <= 120 && pattern.test(value)) result[key] = value;
  }
  if (typeof input['solanaMobile'] === 'boolean') result['solanaMobile'] = input['solanaMobile'];
  return result;
}

const NATIVE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  NATIVE_ERROR: 'Native client error',
  NATIVE_UNCAUGHT: 'Native client stopped unexpectedly',
  NATIVE_STARTUP: 'Native client startup failed',
  NATIVE_RENDER: 'Native rendering failed',
  NATIVE_SCREEN: 'Native screen action failed',
  // Wallet payment failures by MWA error class (native wallet module `WalletFailureKind`):
  // the code names the branch that fired on the device; the transaction, the wallet's
  // own text and the account never travel. Seeker incident 2026-09-17: every SOL payment
  // failed behind one generic notice and no report said which branch.
  NATIVE_WALLET_ACCOUNT_MISMATCH: 'Wallet approved a different account',
  NATIVE_WALLET_AUTHORIZATION_FAILED: 'Wallet refused the saved authorization (MWA -1)',
  NATIVE_WALLET_INVALID_PAYLOADS: 'Wallet rejected the transaction payload (MWA -2)',
  NATIVE_WALLET_NOT_SIGNED: 'Wallet request declined (MWA -3)',
  NATIVE_WALLET_NOT_SUBMITTED: 'Wallet signed but did not submit (MWA -4)',
  NATIVE_WALLET_CLUSTER_NOT_SUPPORTED: 'Wallet does not support the cluster (MWA -7)',
  NATIVE_WALLET_SIGN_AND_SEND_UNSUPPORTED: 'Wallet does not implement sign-and-send',
  // 0.5.2 second cut (2026-09-18): one MWA association, wallet send first, sign-only fallback
  // with a semantic check. The step travels in the code because the on-device notice is the
  // only other evidence (release builds strip logcat).
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
  // Track N0 update channel: closed vocabulary shared with the native NativeError enum
  // (M45 §5). Codes only: no APK bytes, URLs or device identifiers travel.
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
  // Sentry 2026-09-27: a 0.6.0 "installer refused" said nothing about why. From native code 31
  // Android's install status is one code each; a cancelled dialog is the player's choice, not a failure.
  NATIVE_UPDATE_INSTALL_CANCELLED: 'Player cancelled the Android install dialog',
  NATIVE_UPDATE_FAILED_INSTALL_SESSION: 'Install session could not be created or committed',
  NATIVE_UPDATE_FAILED_INSTALL_BLOCKED: 'Android blocked the update install',
  NATIVE_UPDATE_FAILED_INSTALL_CONFLICT: 'Update conflicts with the installed package',
  NATIVE_UPDATE_FAILED_INSTALL_INCOMPATIBLE: 'Update is incompatible with the device',
  NATIVE_UPDATE_FAILED_INSTALL_INVALID: 'Android found the update file invalid',
  NATIVE_UPDATE_FAILED_INSTALL_STORAGE: 'Android had no space to install the update',
  NATIVE_UPDATE_FAILED_INSTALL_TIMEOUT: 'Android timed out installing the update',
};

/** Funnel markers and the player's own choices: kept for adoption counts, never paged as errors. */
const NATIVE_INFORMATIONAL_CODES: ReadonlySet<string> = new Set([
  'NATIVE_UPDATE_OFFERED', 'NATIVE_UPDATE_DOWNLOADED', 'NATIVE_UPDATE_VERIFIED', 'NATIVE_UPDATE_INSTALLED',
  'NATIVE_UPDATE_DECLINED', 'NATIVE_UPDATE_INSTALL_CANCELLED',
]);

function relayNativeClientError(report: ClientErrorReport): void {
  const context = sanitizeNativeTelemetryContext(report.context);
  const gitSha = String(context['gitSha'] ?? 'unknown').slice(0, 7);
  const code = report.code && Object.hasOwn(NATIVE_ERROR_MESSAGES, report.code) ? report.code : 'NATIVE_ERROR';
  const message = NATIVE_ERROR_MESSAGES[code]!;
  // Native codes identify the subsystem. Even a plausible source filename can
  // contain private data; no source, stack, exception name or User-Agent travels.
  const pseudonym = /^[a-f0-9]{16}$/.test(report.pseudonym) ? report.pseudonym
    : 'anon:unknown';
  const count = Number.isSafeInteger(report.count) && Number(report.count) >= 1 && Number(report.count) <= 1_000_000 ? report.count : undefined;
  // Seeker incident 2026-09-18: every payment failed for three releases and the only record of
  // the branch was in Sentry, which the on-call agent cannot read. The closed-vocabulary code and
  // the build are safe to keep in the API log; the wallet, the transaction and wallet text never travel.
  if (code.startsWith('NATIVE_WALLET_')) {
    console.warn('[native-wallet]', { code, buildVersion: context['buildVersion'] ?? 'unknown', gitSha, ...(count !== undefined ? { count } : {}) });
  }
  // Sentry 2026-09-27: an update install failure was only in Sentry, which the on-call agent cannot read.
  if (code.startsWith('NATIVE_UPDATE_FAILED_')) {
    console.warn('[native-update]', { code, buildVersion: context['buildVersion'] ?? 'unknown', gitSha, ...(count !== undefined ? { count } : {}) });
  }
  const informational = code.startsWith('NATIVE_WALLET_FALLBACK_USED') || NATIVE_INFORMATIONAL_CODES.has(code);
  postSentry({
    event_id: sentryEventId(), timestamp: new Date().toISOString(), message, level: informational ? 'info' : 'error',
    platform: 'java', logger: 'pkw-native',
    // Sentry rejects ':' in dist; retain the exact version:code in tags/extra.
    release: `pkw-native@${gitSha}`, ...(context['buildVersion'] ? { dist: String(context['buildVersion']).replace(':', '-') } : {}),
    environment: environment(), user: { id: pseudonym },
    tags: { source: 'android-native', kind: report.kind, platform: 'android-native',
      solanaMobile: String(context['solanaMobile'] === true), buildVersion: String(context['buildVersion'] ?? 'unknown'), code },
    exception: { values: [{ type: 'NativeClientError', value: message }] },
    fingerprint: [report.kind, code],
    extra: { ...context, ...(count !== undefined ? { count } : {}) },
  });
}

/**
 * Client reliability events → Sentry. Only name/message/coarse source strings
 * travel — the client shim already enforces that (apps/web/src/lib/analytics.ts).
 *
 * Carries what "resolve in the next release" needs (audit SENTRY-01):
 * `release` is `pkw-web@<gitSha7>` from the CLIENT context — the bundle that
 * actually threw, which is not the API's sha and not `buildVersion` (that only
 * changes for Android shell releases) — so an old phone on a stale bundle is
 * filed under the old release instead of re-opening a fixed issue.
 */
export function relayClientError(report: ClientErrorReport): void {
  try {
    if (!sentryTarget()) return;
    if (report.context['platform'] === 'android-native') { relayNativeClientError(report); return; }
    const ctx = report.context;
    const str = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : String(v).slice(0, 200));
    const gitSha = (str(ctx['gitSha']) ?? 'unknown').slice(0, 7);
    const buildVersion = str(ctx['buildVersion']);
    const message = report.message.slice(0, 500);
    const source = normalizeSource(report.source);
    const tags: Record<string, string> = {
      source: 'web-client',
      kind: report.kind,
      platform: str(ctx['platform']) ?? 'unknown',
      solanaMobile: String(ctx['solanaMobile'] === true),
      buildVersion: buildVersion ?? 'unknown',
      ...(report.code ? { code: report.code.slice(0, 64) } : {}),
    };
    postSentry({
      event_id: sentryEventId(),
      timestamp: new Date().toISOString(),
      message,
      level: 'error',
      platform: 'javascript',
      logger: 'pkw-client',
      culprit: source || undefined,
      release: `pkw-web@${gitSha}`,
      ...(buildVersion ? { dist: buildVersion } : {}),
      environment: environment(),
      user: { id: report.pseudonym },
      tags,
      ...(report.name ? { exception: { values: [{ type: report.name.slice(0, 64), value: message }] } } : {}),
      ...(report.userAgent ? { request: { headers: { 'User-Agent': report.userAgent.slice(0, 300) } } } : {}),
      fingerprint: [report.kind, normalizeMessage(message), source],
      extra: {
        ...ctx,
        ...(report.source ? { rawSource: report.source.slice(0, 200) } : {}),
        ...(report.count !== undefined ? { count: report.count } : {}),
      },
    });
  } catch { /* never break the caller */ }
}

export interface ServerErrorInfo {
  /** Route PATTERN (`/raids/:id`), never the concrete URL. */
  route?: string | undefined;
  method?: string | undefined;
  statusCode?: number | undefined;
  reqId?: string | undefined;
  wallet?: string | null | undefined;
  logger?: 'pkw-api' | 'pkw-worker' | undefined;
  /** Internal verifier metadata; still runtime-allowlisted before relaying. */
  mintInventory?: unknown;
}

/** Deliberately reconstruct metadata: an Error/cause or RPC response is never
 * spread into logs or Sentry, even when an upstream caller attaches extras. */
export function sanitizeMintInventoryDiagnostics(value: unknown): Record<string, string | number | Record<string, string | number>[]> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>, safe: Record<string, string | number | Record<string, string | number>[]> = {};
  const reasons = ['context_lag', 'collection_changed', 'inventory_incomplete', 'collection_unavailable', 'collection_invalid',
    'rpc_rate_limit', 'rpc_unavailable', 'upstream_unknown', 'cluster_unavailable', 'cluster_mismatch', 'transport', 'rpc_error', 'deadline', 'proof_unresolved'];
  if (typeof input['reason'] === 'string' && reasons.includes(input['reason'])) safe['reason'] = input['reason'];
  if (typeof input['stage'] === 'string' && ['cluster', 'collection_before', 'assets', 'collection_after'].includes(input['stage'])) safe['stage'] = input['stage'];
  for (const key of ['attempts', 'contextRetries', 'rpcCode', 'httpStatus', 'beforeSlot', 'inventorySlot', 'afterSlot',
    'beforeMinted', 'beforeSize', 'afterMinted', 'afterSize', 'assetCount']) {
    const number = input[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && (key === 'rpcCode' || number >= 0)) safe[key] = number;
  }
  if (Array.isArray(input['attemptLog'])) {
    safe['attemptLog'] = input['attemptLog'].slice(0, 3).flatMap((value: unknown) => {
      if (!value || typeof value !== 'object') return [];
      const row = value as Record<string, unknown>, entry: Record<string, string | number> = {};
      if (typeof row['reason'] === 'string' && [...reasons, 'complete'].includes(row['reason'])) entry['reason'] = row['reason'];
      if (typeof row['stage'] === 'string' && ['cluster', 'collection_before', 'assets', 'collection_after'].includes(row['stage'])) entry['stage'] = row['stage'];
      for (const key of ['attempt', 'durationMs', 'rpcCode', 'httpStatus', 'requestedContextSlot', 'returnedContextSlot']) {
        const number = row[key];
        if (typeof number === 'number' && Number.isSafeInteger(number) && (key === 'rpcCode' || number >= 0)) entry[key] = number;
      }
      return Object.keys(entry).length ? [entry] : [];
    });
  }
  return Object.keys(safe).length ? safe : undefined;
}

interface SentryFrame { filename: string; lineno: number; colno: number; function?: string }

/** First `max` `file:line:col` frames of a V8 stack, oldest-call first as
 *  Sentry expects. Paths only — no locals, no arguments. */
export function parseStackFrames(stack: string | undefined, max = 10): SentryFrame[] {
  if (!stack) return [];
  const frames: SentryFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(?:async )?(.*?) \()?(?:async )?(.+?):(\d+):(\d+)\)?\s*$/.exec(line);
    if (!m) continue;
    const [, fn, filename, lineno, colno] = m;
    frames.push({
      filename: (filename ?? '').slice(0, 200),
      lineno: Number(lineno),
      colno: Number(colno),
      ...(fn ? { function: fn.slice(0, 120) } : {}),
    });
    if (frames.length >= max) break;
  }
  return frames.reverse();
}

function takeErrorToken(now = Date.now()): boolean {
  const elapsedMin = (now - errorTokensAt) / 60_000;
  if (elapsedMin > 0) {
    errorTokens = Math.min(SERVER_ERROR_TOKENS_PER_MIN, errorTokens + elapsedMin * SERVER_ERROR_TOKENS_PER_MIN);
    errorTokensAt = now;
  }
  if (errorTokens < 1) return false;
  errorTokens -= 1;
  return true;
}

/**
 * This process's own failures → Sentry: the API's opaque 500s and the
 * worker's failed BullMQ jobs. Before this the only trace of a server error
 * was a pino line on the box (audit SENTRY-02; K-079 claimed otherwise).
 *
 * Fire-and-forget and rate-limited: it never throws, and the only cost on the
 * error path is building the payload — a crash loop spends its 10 tokens a
 * minute and is then silent until the bucket refills.
 */
export function relayServerError(err: unknown, info: ServerErrorInfo = {}): void {
  try {
    if (!sentryTarget()) return;
    if (!takeErrorToken()) return;
    const e = err instanceof Error ? err : new Error(String(err));
    const logger = info.logger ?? 'pkw-api';
    const tags: Record<string, string> = {
      source: logger,
      ...(info.route ? { route: info.route.slice(0, 200) } : {}),
      ...(info.method ? { method: info.method } : {}),
      ...(info.statusCode !== undefined ? { statusCode: String(info.statusCode) } : {}),
    };
    const frames = parseStackFrames(e.stack);
    const mintInventory = sanitizeMintInventoryDiagnostics(info.mintInventory);
    const extra = { ...(info.reqId ? { reqId: String(info.reqId).slice(0, 64) } : {}), ...(mintInventory ? { mintInventory } : {}) };
    postSentry({
      event_id: sentryEventId(),
      timestamp: new Date().toISOString(),
      level: 'error',
      platform: 'node',
      logger,
      release: `pkw-api@${BUILD.gitSha.slice(0, 7)}`,
      environment: environment(),
      exception: {
        values: [{
          type: (e.name || 'Error').slice(0, 64),
          value: (e.message || '').slice(0, 500),
          ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
        }],
      },
      ...(info.wallet ? { user: { id: analyticsId(info.wallet) } } : {}),
      tags,
      ...(Object.keys(extra).length ? { extra } : {}),
    });
  } catch { /* never break the caller — this IS the error path */ }
}

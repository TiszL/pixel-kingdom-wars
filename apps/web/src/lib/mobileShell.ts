/**
 * Solana-Mobile shell integration (owner 2026-08-16: "game should feel like
 * real game" — fullscreen APK, landscape option in settings, good haptics,
 * upgrade-finished notifications).
 *
 * Everything here degrades silently outside the installed shell: a plain
 * browser tab refuses orientation locks and may refuse notifications, and
 * neither failure is worth a toast — the settings rows surface state instead.
 */
import { SOLANA_MOBILE_MARKER_KEY } from './assetPack';
import { EVENTS, track } from './analytics';

export const LANDSCAPE_KEY = 'skp_landscape';

/** True when running as the Solana-Mobile TWA (start URL marker, persisted by
 * the asset-pack gate on first launch). */
export function isSolanaMobileClient(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get('client') === 'solana-mobile'
    || localStorage.getItem(SOLANA_MOBILE_MARKER_KEY) != null;
}

export function landscapePref(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(LANDSCAPE_KEY) === '1';
}

/** Apply the stored orientation preference. Lock succeeds only in an
 * installed fullscreen/standalone context (the APK); browsers reject it and
 * we deliberately swallow that — the toggle still records intent, and the
 * next launch inside the shell honors it. */
export function applyLandscapePref(): void {
  const so = typeof screen !== 'undefined' ? screen.orientation : undefined;
  if (!so) return;
  type Lockable = ScreenOrientation & { lock?: (o: string) => Promise<void> };
  const lock = (so as Lockable).lock?.bind(so);
  if (landscapePref()) {
    if (lock) lock('landscape').catch(() => null);
  } else {
    // unlock() is synchronous and throws outside fullscreen — same swallow.
    try { so.unlock(); } catch { /* not locked / not allowed */ }
  }
}

export function setLandscapePref(on: boolean): void {
  localStorage.setItem(LANDSCAPE_KEY, on ? '1' : '0');
  track(EVENTS.LANDSCAPE_PREF, { on });
  applyLandscapePref();
}

// ---------------------------------------------------------------------------
// Local notifications — upgrade/build finished while the app is backgrounded.
// The APK ships notification delegation (twa.config enableNotifications), so
// these render as real Android notifications inside the shell. Server push
// (D-101, lib/pushSubscription.ts) covers the app-closed case; while a push
// subscription is live this local notifier stands down, because the server
// fires the same completion and two notifications for one job is a bug.
// ---------------------------------------------------------------------------

/** The single NOTIFICATIONS toggle (D-101): '1' once the player opted in.
 * Owned here, next to the permission, so pushSubscription.ts depends on this
 * module and not the other way round. */
export const PUSH_FLAG_KEY = 'skp_push';
/** The endpoint the server last acknowledged; the next sync sends it as
 * `previousEndpoint` so a rotated subscription retires its predecessor. */
export const PUSH_ENDPOINT_KEY = 'skp_push_endpoint';

export function pushOptedIn(): boolean {
  try { return localStorage.getItem(PUSH_FLAG_KEY) === '1'; } catch { return false; }
}

/** True when the server holds a live subscription for this device: opted in,
 * permission granted, and an endpoint acknowledged by a successful sync. */
export function pushSubscriptionActive(): boolean {
  if (!pushOptedIn() || !notificationsGranted()) return false;
  try { return !!localStorage.getItem(PUSH_ENDPOINT_KEY); } catch { return false; }
}

/** The legacy hidden-tab completion path exists only as an opted-in fallback.
 * Browser permission is not preference: OFF must stay silent after the OS has
 * already granted permission, and an acknowledged push owns delivery when ON. */
export function localCompletionFallbackEnabled(): boolean {
  return pushOptedIn() && !pushSubscriptionActive();
}

export function notificationsGranted(): boolean {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export function notificationsSupported(): boolean {
  return typeof Notification !== 'undefined';
}

export async function requestNotifications(): Promise<boolean> {
  if (!notificationsSupported()) return false;
  const r = await Notification.requestPermission().catch(() => 'denied' as const);
  track(EVENTS.NOTIFICATIONS_PERMISSION, { result: r });
  return r === 'granted';
}

async function showLocal(title: string, body: string): Promise<void> {
  if (!notificationsGranted()) return;
  try {
    // Through the SW registration when available (required inside the TWA);
    // constructor fallback for plain secure contexts.
    const reg = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration() : undefined;
    if (reg) await reg.showNotification(title, { body, icon: '/icons/icon-192.png' });
    else new Notification(title, { body, icon: '/icons/icon-192.png' });
  } catch { /* notification loss is never worth breaking the game loop */ }
}

/** Builder-job completion watcher. Feed it the CURRENT job list on every base
 * refresh; when a known job's finishesAt passes while the player is away from
 * the tab, one notification fires (per job id, session-deduped). */
const notified = new Set<string>();
let watched: Array<{ id: string; kind: string; finishesAt: number }> = [];
let timer: ReturnType<typeof setInterval> | null = null;

function builderCompletion(kind: string, inApp: boolean): string | null {
  const suffix = inApp ? ' — YOUR BUILDER IS FREE' : ' — your builder is free.';
  switch (kind) {
    case 'build': return `CONSTRUCTION COMPLETE${suffix}`;
    case 'upgrade': return `UPGRADE COMPLETE${suffix}`;
    case 'repair': return `REPAIR COMPLETE${suffix}`;
    case 'clear_obstacle': return `OBSTACLE CLEARED${suffix}`;
    default: return null;
  }
}

export function watchJobsForNotifications(
  jobs: Array<{ id: string; kind: string; finishesAt: string }>,
): void {
  watched = jobs.map((j) => ({ id: j.id, kind: j.kind, finishesAt: Date.parse(j.finishesAt) }));
  if (timer === null && typeof setInterval !== 'undefined') {
    timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') return;
      // OFF means OFF even when permission remains granted from an earlier
      // opt-in. With opt-in ON, a live server subscription owns the completion;
      // without one, this hidden-tab fallback covers transient push outages.
      if (!localCompletionFallbackEnabled()) return;
      const now = Date.now();
      for (const j of watched) {
        const label = builderCompletion(j.kind, false);
        if (label && Number.isFinite(j.finishesAt) && j.finishesAt <= now && !notified.has(j.id)) {
          notified.add(j.id);
          void showLocal('Pixel Kingdom Wars', label);
        }
      }
    }, 15_000);
  }
}

// ---------------------------------------------------------------------------
// In-app counterparts of the build/training pushes (D-101): with the app OPEN
// the platform suppresses or buries the push, so the /base refetch that lands
// at the deadline is the moment to say it. Only NATURAL completions toast —
// a job that vanished before its deadline was cancelled or paid off, and those
// flows carry their own feedback (FINISH ALL toasts in screens/army.tsx).
// ---------------------------------------------------------------------------

interface CompletionSnapshot {
  baseId?: string | null | undefined;
  player: { wallet: string };
  jobs: Array<{ id: string; kind: string; finishesAt: string }>;
  armyStatus?: { trainingTroopCount: number; nextReadyAt: string | null } | undefined;
}

export function naturalCompletionToasts(
  previous: CompletionSnapshot | null,
  next: CompletionSnapshot | null,
  nowMs: number,
): string[] {
  if (!previous || !next || previous.baseId !== next.baseId
    || previous.player.wallet !== next.player.wallet) return [];
  const remaining = new Set(next.jobs.map((job) => job.id));
  const messages: string[] = [];
  for (const job of previous.jobs) {
    const finishMs = Date.parse(job.finishesAt);
    const message = builderCompletion(job.kind, true);
    if (!message || remaining.has(job.id) || !Number.isFinite(finishMs) || finishMs > nowMs) continue;
    messages.push(message);
  }
  const wasTraining = previous.armyStatus?.trainingTroopCount ?? 0;
  const readyAt = previous.armyStatus?.nextReadyAt ? Date.parse(previous.armyStatus.nextReadyAt) : NaN;
  if (wasTraining > 0 && Number.isFinite(readyAt) && readyAt <= nowMs
    && (next.armyStatus?.trainingTroopCount ?? 0) < wasTraining) {
    messages.push('TRAINING COMPLETE — TROOPS IN CAMP');
  }
  return messages;
}

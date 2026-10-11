/**
 * Web Push subscription lifecycle (D-101). Dependency-free: the VAPID key
 * decode and the three route calls are a few lines, and a push library would
 * be a first-paint dependency for a feature most sessions never touch.
 *
 * Every failure is swallowed, the same rule as mobileShell.ts — a push
 * subscription is never worth breaking the game loop, and the Settings row
 * surfaces the resulting state instead.
 *
 * Re-synced on EVERY boot: UPDATE NOW unregisters every service-worker
 * registration, which destroys the PushSubscription with it; the server row
 * for that endpoint would then wait out its failure budget in silence.
 */
import { api, ApiError } from './api';
import {
  notificationsGranted, PUSH_ENDPOINT_KEY, PUSH_FLAG_KEY, pushOptedIn, requestNotifications,
} from './mobileShell';
import { EVENTS, track } from './analytics';

// Cache Storage is shared by the page and its worker, unlike localStorage.
// This marker prevents a browser-generated `pushsubscriptionchange` from
// resurrecting a subscription after logout/UNLINK or while the toggle is OFF.
const PUSH_SESSION_CACHE = 'pkw-push-session-v1';
const PUSH_SESSION_SUSPENDED_PATH = '/_pkw-push/session-suspended';
const PUSH_SESSION_RESUMED_PATH = '/_pkw-push/session-resumed';
const PUSH_SESSION_SUSPENDED_MESSAGE = 'push-session-suspended';
const PUSH_SESSION_RESUMED_MESSAGE = 'push-session-resumed';
const PUSH_SESSION_RESULT_MESSAGE = 'push-session-result';
const PUSH_SESSION_LOCK = 'pkw-push-session-v1';
const WORKER_RESUME_TIMEOUT_MS = 5_000;
const PUSH_RETIRE_GRACE_MS = 1_000;
/** Shared by every page realm. A suspension rotates this synchronously before
 * any async teardown, so work already running in another tab becomes stale. */
export const PUSH_SESSION_FENCE_KEY = 'skp_push_session_fence_v1';

/** The url-safe base64 VAPID public key as the raw bytes pushManager wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function readEndpoint(): string | null {
  try { return localStorage.getItem(PUSH_ENDPOINT_KEY); } catch { return null; }
}

function writeEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(PUSH_ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(PUSH_ENDPOINT_KEY);
  } catch { /* storage-less contexts keep the server row; the next sync re-sends */ }
}

function setOptedIn(on: boolean): void {
  try {
    if (on) localStorage.setItem(PUSH_FLAG_KEY, '1');
    else localStorage.removeItem(PUSH_FLAG_KEY);
  } catch { /* see writeEndpoint */ }
}

/** Notification permission alone is not Web Push support (Safari tabs and
 * embedded browsers can expose `Notification` without PushManager). Keep the
 * single toggle honest and never strand it waiting on serviceWorker.ready in
 * a context that cannot subscribe. */
export function pushNotificationsSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && typeof PushManager !== 'undefined';
}

async function pushManager(): Promise<PushManager | null> {
  if (!pushNotificationsSupported()) return null;
  // `serviceWorker.ready` can remain pending forever after a blocked/failed
  // registration, which would leave the Settings switch stuck on SYNCING.
  // Existing opted-in installs already have a registration; first installs
  // retry from App's controllerchange listener when the worker takes control.
  const reg = await navigator.serviceWorker.getRegistration();
  return reg?.pushManager ?? null;
}

// Auth restore, service-worker takeover and the Settings switch can all ask for
// a sync in the same tick. Serialize them: PushManager and the globally-unique
// server endpoint are idempotent, but subscribe racing unsubscribe is not.
let pushOperationTail: Promise<void> = Promise.resolve();
let workerFenceTail: Promise<void> = Promise.resolve();
let pushSessionEpoch = 0;
let pushSessionSuspended = false;
const pendingSessionWaitCancellations = new Set<() => void>();
const PUSH_SESSION_WAIT_CANCELLED = Symbol('push-session-wait-cancelled');

interface PushSessionClaim {
  epoch: number;
  /** Shared logout/OFF generation; distinct from one activation transaction. */
  sharedFence: string | null;
}

function enqueuePushOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = pushOperationTail.then(operation, operation);
  pushOperationTail = result.then(() => undefined, () => undefined);
  return result;
}

function cancelPendingSessionWaits(): void {
  for (const cancel of pendingSessionWaitCancellations) cancel();
  pendingSessionWaitCancellations.clear();
}

/** Release the serialized lifecycle queue as soon as this page suspends. The
 * underlying browser/network promise is still observed and its own post-await
 * generation checks perform compensation if it eventually settles. */
function waitUntilSessionSuspends<T>(work: Promise<T>): Promise<T | typeof PUSH_SESSION_WAIT_CANCELLED> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: T | typeof PUSH_SESSION_WAIT_CANCELLED, error?: unknown): void => {
      if (settled) return;
      settled = true;
      pendingSessionWaitCancellations.delete(cancel);
      if (error !== undefined) reject(error);
      else resolve(value);
    };
    const cancel = (): void => finish(PUSH_SESSION_WAIT_CANCELLED);
    pendingSessionWaitCancellations.add(cancel);
    work.then((value) => finish(value), (error) => finish(PUSH_SESSION_WAIT_CANCELLED, error));
  });
}

async function waitForRetirementGrace(work: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, PUSH_RETIRE_GRACE_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    // Keep observing a best-effort retirement that outlives the cookie grace.
    void work.catch(() => undefined);
  }
}

function readSharedFence(): string | null | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    return localStorage.getItem(PUSH_SESSION_FENCE_KEY);
  } catch {
    // A realm unable to observe other tabs' logout/OFF generation may tear
    // down, but must never activate delivery.
    return undefined;
  }
}

function newSharedFence(): string {
  try { return crypto.randomUUID(); } catch {
    const bytes = new Uint32Array(4);
    try { crypto.getRandomValues(bytes); } catch {
      // This fallback is only an availability aid for unusual test/legacy
      // contexts. Cache Storage and the immediate worker message remain the
      // two delivery fences.
      return `${Date.now()}-${Math.random()}`;
    }
    return [...bytes].map((part) => part.toString(16).padStart(8, '0')).join('');
  }
}

function rotateSharedFence(): string {
  const fence = newSharedFence();
  try { localStorage.setItem(PUSH_SESSION_FENCE_KEY, fence); } catch {
    // The nonce still travels to Cache Storage and the live worker. A tab that
    // cannot share localStorage is never allowed to complete a later resume.
  }
  return fence;
}

function claimForEpoch(epoch: number): PushSessionClaim | null {
  const sharedFence = readSharedFence();
  return sharedFence === undefined ? null : {
    epoch,
    sharedFence,
  };
}

function sessionIsCurrent(claim: PushSessionClaim): boolean {
  return !pushSessionSuspended
    && claim.epoch === pushSessionEpoch
    && pushOptedIn()
    && readSharedFence() === claim.sharedFence;
}

function pushOwnershipLockSupported(): boolean {
  return typeof navigator !== 'undefined'
    && 'locks' in navigator && typeof navigator.locks?.request === 'function';
}

function postWorkerSessionSuspended(fenceNonce: string): void {
  const message = { type: PUSH_SESSION_SUSPENDED_MESSAGE, fenceNonce };
  try {
    const controller = navigator.serviceWorker.controller;
    if (controller) {
      controller.postMessage(message);
      return;
    }
    // Do not make the durable write wait for registration discovery. The
    // active worker is still messaged best-effort when there is no controller.
    void navigator.serviceWorker.getRegistration()
      .then((registration) => registration?.active?.postMessage(message))
      .catch(() => undefined);
  } catch { /* Cache Storage remains the restart-safe authority. */ }
}

function queueWorkerSessionSuspended(fenceNonce: string): Promise<boolean> {
  const result = workerFenceTail.then(
    () => persistWorkerSessionSuspended(fenceNonce),
    () => persistWorkerSessionSuspended(fenceNonce),
  );
  workerFenceTail = result.then(() => undefined, () => undefined);
  return result;
}

async function persistWorkerSessionSuspended(fenceNonce: string): Promise<boolean> {
  try {
    if (typeof caches === 'undefined') return false;
    const cache = await caches.open(PUSH_SESSION_CACHE);
    const origin = typeof location !== 'undefined' && location.origin
      ? location.origin : 'https://play.pixelkingdomwars.com';
    const markerUrl = new URL(PUSH_SESSION_SUSPENDED_PATH, origin).href;
    const previousMarker = await cache.match(markerUrl);
    const previousNonce = previousMarker ? await previousMarker.text() : null;
    if (previousNonce) {
      const previousAck = new URL(PUSH_SESSION_RESUMED_PATH, origin);
      previousAck.searchParams.set('fence', previousNonce);
      await cache.delete(previousAck.href);
      if (await cache.match(previousAck.href)) return false;
    }

    // A different realm published a newer suspension while the exact old ACK
    // was being invalidated. It owns the marker; never overwrite its nonce.
    const currentMarker = await cache.match(markerUrl);
    const currentNonce = currentMarker ? await currentMarker.text() : null;
    if (currentNonce !== previousNonce) {
      if (currentNonce !== fenceNonce) return false;
      const currentAck = new URL(PUSH_SESSION_RESUMED_PATH, origin);
      currentAck.searchParams.set('fence', currentNonce);
      await cache.delete(currentAck.href);
      if (await cache.match(currentAck.href)) return false;
      const stillCurrent = await cache.match(markerUrl);
      return !!stillCurrent && await stillCurrent.text() === fenceNonce;
    }

    await cache.put(markerUrl, new Response(fenceNonce, {
      headers: { 'cache-control': 'no-store' },
    }));
    const persisted = await cache.match(markerUrl);
    if (!persisted || await persisted.text() !== fenceNonce) return false;
    const replacementAck = new URL(PUSH_SESSION_RESUMED_PATH, origin);
    replacementAck.searchParams.set('fence', fenceNonce);
    if (await cache.match(replacementAck.href)) return false;
    const stillCurrent = await cache.match(markerUrl);
    return !!stillCurrent && await stillCurrent.text() === fenceNonce;
  } catch {
    // The old generation's ACK is invalidated before the replacement write.
    // Therefore a failed put still restarts suspended; the live worker was
    // also messaged before any Cache work and performs the same transaction.
    return false;
  }
}

async function requestWorkerSessionResume(
  fenceNonce: string,
  claim: PushSessionClaim,
): Promise<boolean> {
  if (!sessionIsCurrent(claim) || typeof MessageChannel === 'undefined') return false;
  try {
    const controller = navigator.serviceWorker.controller;
    const registration = controller ? null : await navigator.serviceWorker.getRegistration();
    if (!sessionIsCurrent(claim)) return false;
    const worker = controller ?? registration?.active;
    if (!worker) return false;
    const channel = new MessageChannel();
    try {
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (active: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(active);
        };
        const timer = setTimeout(() => finish(false), WORKER_RESUME_TIMEOUT_MS);
        channel.port1.onmessage = (event: MessageEvent<unknown>) => {
          const answer = event.data as {
            type?: unknown; fenceNonce?: unknown; active?: unknown;
          } | null;
          if (answer?.type !== PUSH_SESSION_RESULT_MESSAGE
            || answer.fenceNonce !== fenceNonce) return;
          finish(answer.active === true && sessionIsCurrent(claim));
        };
        try {
          worker.postMessage({ type: PUSH_SESSION_RESUMED_MESSAGE, fenceNonce }, [channel.port2]);
        } catch { finish(false); }
      });
    } finally {
      channel.port1.close();
    }
  } catch { return false; }
}

async function reinforceWorkerSuspension(): Promise<void> {
  pushSessionSuspended = true;
  pushSessionEpoch += 1;
  const fenceNonce = newSharedFence();
  postWorkerSessionSuspended(fenceNonce);
  await queueWorkerSessionSuspended(fenceNonce);
}

async function withCrossRealmPushLock(operation: () => Promise<boolean>): Promise<boolean> {
  try {
    // Web Locks is available in the target Android Chrome/TWA. Without a
    // cross-realm mutex, two tabs can both own the same opaque PushSubscription
    // and one realm's compensation can destroy the other's endpoint. Keep the
    // durable fence and use the in-app completion fallback instead.
    if (!pushOwnershipLockSupported()) return false;
    return await navigator.locks.request(PUSH_SESSION_LOCK, { mode: 'exclusive' }, operation);
  } catch {
    // A broken lock implementation must not fall back to an overlapping sync.
    return false;
  }
}

async function createBrowserSubscription(manager: PushManager): Promise<PushSubscription | null> {
  const { publicKey } = await api.get<{ publicKey: string | null }>('/notifications/vapid');
  if (!publicKey) return null;
  return manager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
  });
}

/** Ensure the server holds this device's live subscription. Returns true when
 * a subscription is registered after the call. */
async function syncPushSubscriptionOnce(claim: PushSessionClaim): Promise<boolean> {
  try {
    if (!sessionIsCurrent(claim) || !notificationsGranted()) return false;
    const manager = await pushManager();
    if (!manager || !sessionIsCurrent(claim)) return false;
    const previousEndpoint = readEndpoint();
    let sub = await manager.getSubscription();
    if (!sessionIsCurrent(claim)) {
      await sub?.unsubscribe().catch(() => false);
      return false;
    }
    if (!sub) {
      // UPDATE NOW unregisters the old worker and therefore its browser
      // subscription. The remembered endpoint is still needed below to retire
      // the server row, but it no longer proves a live delivery path: clear the
      // acknowledgement now so the in-app completion fallback remains armed if
      // this recovery is interrupted or offline.
      writeEndpoint(null);
      // Push disabled server-side (no VAPID keys): nothing to subscribe to, and
      // nothing to tell the player — the toggle simply has no effect yet.
      sub = await createBrowserSubscription(manager);
      if (!sub) return false;
    }
    // Logout/switch may have happened while permission, VAPID or PushManager
    // was pending. Never register the just-created endpoint for the old wallet.
    if (!sessionIsCurrent(claim)) {
      await sub.unsubscribe().catch(() => false);
      return false;
    }
    const json = sub.toJSON();
    const p256dh = json.keys?.['p256dh'];
    const auth = json.keys?.['auth'];
    if (!json.endpoint || !p256dh || !auth) {
      writeEndpoint(null);
      return false;
    }
    // A rotated/unacknowledged browser endpoint cannot suppress the fallback.
    // Conversely, preserve an exact prior acknowledgement through an ordinary
    // transient network failure: the server row is still live, and enabling the
    // local notifier too would duplicate a completion.
    if (previousEndpoint !== json.endpoint) writeEndpoint(null);
    // postRaw: the route body is exactly the shared contract (no idempotency
    // key) — a subscribe is naturally idempotent on its endpoint.
    try {
      await api.postRaw('/notifications/subscribe', {
        endpoint: json.endpoint,
        keys: { p256dh, auth },
        ...(previousEndpoint && previousEndpoint !== json.endpoint ? { previousEndpoint } : {}),
        ...(typeof navigator !== 'undefined' && navigator.userAgent ? { userAgent: navigator.userAgent } : {}),
      });
    } catch (error) {
      // PUSH_DISABLED is authoritative: no server delivery can happen, so arm
      // the opted-in hidden-tab fallback. Network failure is not that fact.
      if (error instanceof ApiError && error.status === 503 && error.code === 'PUSH_DISABLED') {
        writeEndpoint(null);
      }
      if (error instanceof ApiError && error.status === 409 && error.code === 'PUSH_ENDPOINT_OWNED'
        && sessionIsCurrent(claim)) {
        // The endpoint is an opaque capability, not transferable identity. A
        // shared browser profile may expose wallet A's live subscription to
        // wallet B. Delivery was fenced before this POST; keep it fenced until
        // PushManager really releases the capability and a later sync safely
        // registers a distinct endpoint. Current-wallet DELETE cannot remove
        // wallet A's row, so it is only best-effort cleanup.
        writeEndpoint(null);
        await sub.unsubscribe().catch(() => false);
        await api.delRaw('/notifications/subscribe', { endpoint: json.endpoint }).catch(() => null);
        return false;
      }
      if (!sessionIsCurrent(claim)) {
        // A rejected transport can still hide a committed POST. A cross-tab
        // logout/OFF generation therefore owns the same compensation as a
        // successful response observed just before the fence changed.
        await sub.unsubscribe().catch(() => false);
        await api.delRaw('/notifications/subscribe', { endpoint: json.endpoint }).catch(() => null);
      }
      return false;
    }
    if (!sessionIsCurrent(claim)) {
      // The POST may have committed immediately before session detach. Undo it
      // while the old cookie is still usable; the queued detach is the second
      // best-effort retirement fence.
      await sub.unsubscribe().catch(() => false);
      await api.delRaw('/notifications/subscribe', { endpoint: json.endpoint }).catch(() => null);
      return false;
    }
    writeEndpoint(json.endpoint);
    return true;
  } catch {
    return false;
  }
}

async function retirePushSubscription(initialEndpoint: string | null): Promise<void> {
  const endpoints = new Set<string>();
  if (initialEndpoint) endpoints.add(initialEndpoint);
  const lateAcknowledged = readEndpoint();
  if (lateAcknowledged) endpoints.add(lateAcknowledged);
  writeEndpoint(null);
  try {
    const manager = await pushManager();
    const sub = await manager?.getSubscription();
    if (sub?.endpoint) endpoints.add(sub.endpoint);
    await sub?.unsubscribe().catch(() => false);
  } catch {
    // Browser teardown failure must not block server-side retirement below.
  }
  for (const endpoint of endpoints) {
    try { await api.delRaw('/notifications/subscribe', { endpoint }); } catch {
      // An expired/offline cookie cannot authorize DELETE. The local browser
      // is already fenced; the sender disables an unreachable row on failure.
    }
  }
  writeEndpoint(null);
}

/** Start a newly authenticated notification session. A prior logout leaves a
 * durable worker fence behind. Every ownership sync starts a fresh suspended
 * transaction; only the worker may acknowledge it after shade cleanup. */
export function resumePushSessionAndSync(): Promise<boolean> {
  // An authenticated boot with the preference OFF is also a teardown retry:
  // persist its worker fence immediately instead of waiting behind a stale
  // network sync from the previous page/session.
  const canActivateNow = readSharedFence() !== undefined
    && pushOptedIn() && notificationsGranted() && pushNotificationsSupported()
    && pushOwnershipLockSupported();
  const inactiveNonce = canActivateNow ? null : rotateSharedFence();
  if (inactiveNonce) {
    pushSessionSuspended = true;
    pushSessionEpoch += 1;
    postWorkerSessionSuspended(inactiveNonce);
  }
  const inactiveFence = inactiveNonce
    ? queueWorkerSessionSuspended(inactiveNonce) : null;
  return enqueuePushOperation(async () => {
    if (!canActivateNow) {
      if (inactiveFence) await inactiveFence;
      return false;
    }
    return withCrossRealmPushLock(async () => {
      const sharedFence = readSharedFence();
      const canActivate = sharedFence !== undefined
        && pushOptedIn() && notificationsGranted() && pushNotificationsSupported()
        && pushOwnershipLockSupported();
      pushSessionSuspended = !canActivate;
      const epoch = ++pushSessionEpoch;
      const claim = claimForEpoch(epoch);
      if (!canActivate || !claim || !sessionIsCurrent(claim)) return false;

      // Ownership is unresolved until POST accepts this opaque capability.
      // Fence before touching PushManager or the network so a 409 endpoint can
      // never display prior-wallet bytes while unsubscribe/DELETE struggle.
      const activationFence = newSharedFence();
      postWorkerSessionSuspended(activationFence);
      const durableFence = await queueWorkerSessionSuspended(activationFence);
      if (!durableFence || !sessionIsCurrent(claim)) return false;

      const registered = await waitUntilSessionSuspends(syncPushSubscriptionOnce(claim));
      if (registered === PUSH_SESSION_WAIT_CANCELLED) return false;
      if (!registered || !sessionIsCurrent(claim)) {
        if (!sessionIsCurrent(claim)) await retirePushSubscription(readEndpoint());
        else writeEndpoint(null);
        return false;
      }
      const activated = await waitUntilSessionSuspends(
        requestWorkerSessionResume(activationFence, claim),
      );
      if (activated === PUSH_SESSION_WAIT_CANCELLED) return false;
      if (!activated || !sessionIsCurrent(claim)) {
        if (!sessionIsCurrent(claim)) {
          await retirePushSubscription(readEndpoint());
        } else {
          // A lost MessageChannel reply can race an otherwise successful SW
          // commit. Rotate back to an unacknowledged generation so timeout or
          // worker replacement always converges to fail-closed delivery.
          await reinforceWorkerSuspension();
          writeEndpoint(null);
        }
        return false;
      }
      return true;
    });
  });
}

/** Controller takeover uses the same fenced ownership transaction as auth. */
export function syncPushSubscription(): Promise<boolean> {
  return resumePushSessionAndSync();
}

/** Detach Web Push from the CURRENT authenticated wallet without changing the
 * player's preference. Called before every auth-null/logout path. The epoch is
 * bumped synchronously so an in-flight sync can never publish after detach. */
export function suspendPushSession(): Promise<void> {
  pushSessionSuspended = true;
  pushSessionEpoch += 1;
  cancelPendingSessionWaits();
  const fenceNonce = rotateSharedFence();
  // This is deliberately before Cache Storage: quota/transient persistence
  // failure must still synchronously invalidate the live worker's generation.
  postWorkerSessionSuspended(fenceNonce);
  const initiallyAcknowledged = readEndpoint();
  writeEndpoint(null);
  // Cache-only and safe to start outside the PushManager queue: close the SW's
  // delivery/rotation paths at once even if an older network sync is settling.
  // Fence writes have their own queue so a prior resume cannot clear this one
  // after it lands.
  const immediateWorkerFence = queueWorkerSessionSuspended(fenceNonce);
  const retirement = enqueuePushOperation(async () => {
    await immediateWorkerFence;
    await retirePushSubscription(initiallyAcknowledged);
  });
  return (async () => {
    // Cache Storage is the restart boundary and must land before the server
    // session is revoked. Browser/server endpoint retirement gets a bounded
    // cookie-authenticated grace, then continues best-effort in the background
    // so a wedged push service can never block /auth/logout indefinitely.
    await immediateWorkerFence;
    await waitForRetirementGrace(retirement);
  })();
}

/** The Settings toggle ON: permission, then flag, then sync. Returns false
 * when the permission was refused, so the row can say so. */
export async function enablePush(): Promise<boolean> {
  try {
    if (!pushNotificationsSupported() || !(await requestNotifications())) {
      await disablePush();
      return false;
    }
    setOptedIn(true);
    const registered = await resumePushSessionAndSync();
    track(EVENTS.PUSH_ENABLED, { registered });
    // Permission is the user's choice; an offline/disabled server is transient.
    // Preserve the opt-in and let every later authenticated boot retry.
    return true;
  } catch {
    return false;
  }
}

/** The Settings toggle OFF: unsubscribe, retire the server row, clear. The
 * flag clears FIRST so a boot racing this call cannot re-subscribe. */
export async function disablePush(): Promise<void> {
  setOptedIn(false);
  await suspendPushSession();
  track(EVENTS.PUSH_DISABLED);
}

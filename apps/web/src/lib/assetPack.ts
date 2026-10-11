/**
 * Solana Mobile first-launch asset pack.
 *
 * A TWA cannot execute while Android is installing its APK. Its earliest safe
 * download point is therefore first launch (and the first launch of each new web
 * build). Ordinary browser tabs keep the existing on-demand path and never call
 * this module's downloader.
 */
import { ASSET_PACK_TRANSFER } from '@shardkeep/shared';

export const ASSET_PACK_CACHE = 'pkw-asset-pack-v1';
/** Exact-build worker bypass used by the installer. It keeps the canonical
 * runtime URL so Chromium can reuse BootScene's HTTP-cache entry, while only
 * the page performs this installer's integrity hash and cache write. */
export const ASSET_PACK_DOWNLOAD_HEADER = 'x-pkw-pack-download';
export const SOLANA_MOBILE_MARKER_KEY = 'pkw:solana-mobile-client';
const CURRENT_PATH = '/_pkw-pack/current.json';
const CORE_PATH = '/_pkw-pack/core.json';
const PREVIOUS_PATH = '/_pkw-pack/previous.json';
const INSTALLING_PATH = '/_pkw-pack/installing.json';
const DEPLOYMENT_CURRENT_PATH = '/_pkw-pack/deployment-current.json';
const DEPLOYMENT_PREVIOUS_PATH = '/_pkw-pack/deployment-previous.json';
const ALLOWED_PATH = /^\/(assets|atlas|audio|brand|icons)\//;
const HASH = /^[0-9a-f]{64}$/;
// Shared protocol with scripts/emit-asset-pack.mjs. An allowed MIME is not
// enough: it must be the one pinned for this logical path, otherwise a poisoned
// manifest could make the service worker replay bytes under another type.
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.woff2', 'font/woff2'],
]);
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_INVENTORY_CONCURRENCY = 12;
const DEFAULT_OBJECT_TIMEOUT_MS = 60_000;
const MIN_HEADROOM_BYTES = 8 * 1024 * 1024;
const WORKER_ACK_TIMEOUT_MS = 2_000;

export interface AssetPackFile {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string;
  /** `core` is installed atomically before the optional remainder (D-101). */
  tier: 'core' | 'full';
}

export interface AssetPackManifest {
  schema: 2;
  build: string;
  totalBytes: number;
  files: AssetPackFile[];
}

export type AssetPackProgress =
  | { kind: 'checking' }
  | { kind: 'preparing'; totalBytes: number; totalFiles: number; cachedBytes: number; cachedFiles: number }
  | {
    kind: 'downloading'; totalBytes: number; totalFiles: number;
    downloadedBytes: number; downloadedFiles: number;
  }
  | { kind: 'ready'; totalBytes: number; totalFiles: number };

export type AssetPackGateState = AssetPackProgress
  | { kind: 'not-required' }
  | { kind: 'error'; message: string; code: AssetPackErrorCode };

export type AssetPackErrorCode =
  | 'unsupported' | 'manifest' | 'build-mismatch'
  | 'quota' | 'network' | 'integrity' | 'service-worker' | 'aborted';

export class AssetPackError extends Error {
  constructor(public readonly code: AssetPackErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'AssetPackError';
  }
}

export interface AssetPackEnvironment {
  build: string;
  origin?: string;
  fetch?: typeof fetch;
  cacheStorage?: CacheStorage;
  crypto?: Crypto;
  storage?: Pick<StorageManager, 'estimate' | 'persist' | 'persisted'>;
  serviceWorker?: Pick<ServiceWorkerContainer, 'controller' | 'ready' | 'register' | 'addEventListener' | 'removeEventListener'>;
  requireController?: boolean;
  controllerTimeoutMs?: number;
  objectTimeoutMs?: number;
  concurrency?: number;
  inventoryConcurrency?: number;
  /** Monotonic clock override used to test download-progress publication. */
  progressNow?: () => number;
  signal?: AbortSignal;
  onProgress?: (progress: AssetPackProgress) => void;
}

/** Query marker from the Android TWA is sticky so internal navigation/reloads
 * cannot accidentally fall back to the ordinary browser path. */
export function isSolanaMobileAssetPackClient(
  search = typeof location === 'undefined' ? '' : location.search,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = typeof localStorage === 'undefined' ? null : localStorage,
): boolean {
  const marked = new URLSearchParams(search).get('client') === 'solana-mobile';
  if (marked) {
    try { storage?.setItem(SOLANA_MOBILE_MARKER_KEY, '1'); } catch { /* private mode: query remains authoritative */ }
    return true;
  }
  try { return storage?.getItem(SOLANA_MOBILE_MARKER_KEY) === '1'; } catch { return false; }
}

function internalUrl(origin: string, path: string): string {
  return new URL(path, origin).href;
}

function contentPath(hash: string): string {
  return `/_pkw-pack/content/${hash}`;
}

function manifestPath(build: string): string {
  return `/_pkw-pack/manifest/${encodeURIComponent(build)}.json`;
}

function abortError(): AssetPackError {
  return new AssetPackError('aborted', 'Game download cancelled');
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

async function mapLimit<T, U>(
  values: readonly T[], limit: number, fn: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await fn(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, worker));
  return results;
}

function boundedConcurrency(value: number | undefined, fallback: number, maximum: number): number {
  const configured = value ?? fallback;
  return Number.isFinite(configured)
    ? Math.min(maximum, Math.max(1, Math.floor(configured)))
    : fallback;
}

export function serviceWorkerControlsAssetPackBuild(
  controller: ServiceWorker | null | undefined,
  build: string,
): boolean {
  if (!controller?.scriptURL) return false;
  try {
    const base = typeof location === 'undefined' ? 'https://play.pixelkingdomwars.com' : location.origin;
    const script = new URL(controller.scriptURL, base);
    return script.pathname === '/sw.js' && script.searchParams.get('v') === build;
  } catch { return false; }
}

export function validateAssetPackManifest(value: unknown, expectedBuild: string): AssetPackManifest {
  if (!value || typeof value !== 'object') throw new AssetPackError('manifest', 'Game download manifest is invalid');
  const candidate = value as Partial<AssetPackManifest>;
  if (candidate.schema !== 2 || typeof candidate.build !== 'string' || !Array.isArray(candidate.files)
    || !Number.isSafeInteger(candidate.totalBytes) || candidate.totalBytes! < 0) {
    throw new AssetPackError('manifest', 'Game download manifest is invalid');
  }
  if (candidate.build !== expectedBuild) {
    throw new AssetPackError('build-mismatch', 'A newer game build is deploying. Retry in a moment.');
  }
  let total = 0;
  const digestSizes = new Map<string, number>();
  let previous = '';
  const seen = new Set<string>();
  for (const file of candidate.files as AssetPackFile[]) {
    const path = file && typeof file.path === 'string' ? file.path : '';
    const dot = path.lastIndexOf('.');
    const expectedType = CONTENT_TYPES.get(dot < 0 ? '' : path.slice(dot).toLowerCase());
    if (!file || typeof file.path !== 'string' || !ALLOWED_PATH.test(file.path)
      || file.path.includes('?') || file.path.includes('#') || file.path.includes('..')
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !HASH.test(file.sha256)
      || typeof file.contentType !== 'string' || file.contentType !== expectedType
      || (file.tier !== 'core' && file.tier !== 'full')) {
      throw new AssetPackError('manifest', 'Game download manifest contains an unsafe asset');
    }
    if (seen.has(file.path) || (previous && previous >= file.path)) {
      throw new AssetPackError('manifest', 'Game download manifest is not uniquely sorted');
    }
    seen.add(file.path);
    previous = file.path;
    const digestSize = digestSizes.get(file.sha256);
    if (digestSize !== undefined && digestSize !== file.bytes) {
      throw new AssetPackError('manifest', 'Game download manifest has inconsistent content hashes');
    }
    if (digestSize === undefined) {
      digestSizes.set(file.sha256, file.bytes);
      total += file.bytes;
    }
    if (!Number.isSafeInteger(total)) throw new AssetPackError('manifest', 'Game download size is invalid');
  }
  if (candidate.files.length === 0 || !candidate.files.some((file) => file.tier === 'core')
    || total !== candidate.totalBytes) {
    throw new AssetPackError('manifest', 'Game download manifest total does not match its assets');
  }
  return candidate as AssetPackManifest;
}

async function responseJson<T>(response: Response): Promise<T | null> {
  try { return await response.json() as T; } catch { return null; }
}

async function readPointer(cache: Cache, origin: string, path: string): Promise<AssetPackManifest | null> {
  const response = await cache.match(internalUrl(origin, path));
  return response ? responseJson<AssetPackManifest>(response) : null;
}

function tierManifest(manifest: AssetPackManifest, tier: AssetPackFile['tier']): AssetPackManifest {
  const files = manifest.files.filter((file) => file.tier === tier);
  const unique = new Map(files.map((file) => [file.sha256, file.bytes]));
  return {
    schema: 2,
    build: manifest.build,
    totalBytes: [...unique.values()].reduce((sum, bytes) => sum + bytes, 0),
    files,
  };
}

async function commitCorePointer(cache: Cache, origin: string, manifest: AssetPackManifest): Promise<void> {
  // This pointer means every core object is durable; unlike CURRENT_PATH it
  // deliberately makes no claim about the remainder of the offline pack.
  await cache.put(internalUrl(origin, CORE_PATH), manifestResponse(tierManifest(manifest, 'core')));
}

function manifestResponse(manifest: AssetPackManifest): Response {
  return new Response(JSON.stringify(manifest), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function requestPersistentStorage(storage: AssetPackEnvironment['storage']): Promise<void> {
  if (!storage?.persisted || !storage.persist) return;
  try {
    if (await storage.persisted()) return;
    await storage.persist();
  } catch {
    // Chromium may deny or reject this discretionary request on a fresh origin.
    // Cache Storage still works; quota and every downloaded byte remain verified.
  }
}

async function requireQuota(storage: AssetPackEnvironment['storage'], missingBytes: number): Promise<void> {
  if (missingBytes === 0 || !storage?.estimate) return;
  let estimate: StorageEstimate;
  try { estimate = await storage.estimate(); } catch { return; }
  if (estimate.quota === undefined || estimate.usage === undefined) return;
  const available = Math.max(0, estimate.quota - estimate.usage);
  const required = missingBytes + Math.max(MIN_HEADROOM_BYTES, Math.ceil(missingBytes * 0.05));
  if (available < required) {
    throw new AssetPackError(
      'quota',
      `Not enough phone storage: ${Math.ceil(required / 1048576)} MB required, ${Math.floor(available / 1048576)} MB available`,
    );
  }
}

function fetchPath(path: string, build: string): string {
  // Vite assets already carry a content hash. Stable public roots use the same
  // build query as BootScene/audio/brand callers, allowing an uncontrolled
  // first paint's HTTP-cache bytes to be reused after the worker takes control.
  return path.startsWith('/assets/')
    ? path
    : `${path}?v=${encodeURIComponent(build)}`;
}

async function awaitServiceWorkerController(
  serviceWorker: AssetPackEnvironment['serviceWorker'],
  registration: ServiceWorkerRegistration,
  build: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  if (!serviceWorker) throw new AssetPackError('service-worker', 'Offline game storage is unavailable on this phone');
  assertNotAborted(signal);
  const promoteWaiting = (): void => { registration.waiting?.postMessage('skip-waiting'); };
  const watchInstalling = (): void => {
    promoteWaiting();
    registration.installing?.addEventListener('statechange', promoteWaiting);
  };
  registration.addEventListener?.('updatefound', watchInstalling);
  watchInstalling();
  const startedAt = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const done = (cause?: unknown): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', aborted);
        if (cause) reject(cause); else resolve();
      };
      const aborted = (): void => done(abortError());
      const timer = setTimeout(() => done(), timeoutMs);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      void serviceWorker.ready.then(
        () => done(),
        (cause: unknown) => done(cause),
      );
    });
  } catch (cause) {
    if (cause instanceof AssetPackError && cause.code === 'aborted') throw cause;
    throw new AssetPackError('service-worker', 'Offline game storage could not start', { cause });
  }
  const controlsBuild = (): boolean => serviceWorkerControlsAssetPackBuild(serviceWorker.controller, build);
  if (controlsBuild()) return true;

  assertNotAborted(signal);
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      serviceWorker.removeEventListener('controllerchange', changed);
      signal?.removeEventListener('abort', aborted);
    };
    const aborted = (): void => { cleanup(); reject(abortError()); };
    const changed = (): void => {
      if (!controlsBuild()) return;
      cleanup();
      resolve();
    };
    serviceWorker.addEventListener('controllerchange', changed);
    signal?.addEventListener('abort', aborted, { once: true });
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, Math.max(0, timeoutMs - (Date.now() - startedAt)));
    if (signal?.aborted) aborted();
  });
  if (controlsBuild()) return true;

  // The verified pack is optional background work. Reloading the whole TWA to
  // gain first-page control interrupts wallet/onboarding and shows Android's
  // native splash again. Defer this installer attempt as an ordinary online
  // mode outcome. The caller can retry on a later controllerchange or launch.
  return false;
}

async function notifyPackCommitted(
  serviceWorker: AssetPackEnvironment['serviceWorker'],
  build: string,
  requireAck: boolean,
): Promise<void> {
  const controller = serviceWorker?.controller;
  if (!controller || !serviceWorkerControlsAssetPackBuild(controller, build)) {
    if (requireAck) throw new AssetPackError('service-worker', 'Offline game storage lost control');
    return;
  }
  const payload = { type: 'asset-pack-committed', build };
  if (!requireAck) {
    controller.postMessage(payload);
    return;
  }
  if (typeof MessageChannel === 'undefined') {
    throw new AssetPackError('service-worker', 'Offline game storage cannot activate on this phone');
  }
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new AssetPackError(
        'service-worker', 'Offline game storage did not activate the downloaded pack',
      )), WORKER_ACK_TIMEOUT_MS);
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const answer = event.data as { type?: string; build?: string } | null;
        if (answer?.type !== 'asset-pack-ready' || answer.build !== build) return;
        clearTimeout(timer);
        resolve();
      };
      controller.postMessage(payload, [channel.port2]);
    });
  } finally {
    channel.port1.close();
  }
}

/** Wait for the finite snapshot of runtime hash writes already in flight in
 * the exact-build worker. This closes the race where BootScene's response is
 * still hashing while the page inventories content-addressed objects. The
 * transfer starts after boot and may wait indefinitely, but its existing abort
 * signal cancels the barrier when gameplay or visibility takes priority. */
async function flushWorkerInventory(
  serviceWorker: AssetPackEnvironment['serviceWorker'],
  build: string,
  signal: AbortSignal | undefined,
): Promise<void> {
  const controller = serviceWorker?.controller;
  if (!controller || !serviceWorkerControlsAssetPackBuild(controller, build)
    || typeof MessageChannel === 'undefined') return;
  assertNotAborted(signal);
  const channel = new MessageChannel();
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (cause?: unknown): void => {
        channel.port1.onmessage = null;
        signal?.removeEventListener('abort', aborted);
        if (cause === undefined) resolve(); else reject(cause);
      };
      const aborted = (): void => finish(abortError());
      channel.port1.onmessage = (event: MessageEvent<unknown>) => {
        const answer = event.data as { type?: string; build?: string } | null;
        if (answer?.type !== 'asset-pack-inventory-ready' || answer.build !== build) return;
        finish();
      };
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) {
        aborted();
        return;
      }
      controller.postMessage({ type: 'asset-pack-inventory-flush', build }, [channel.port2]);
    });
  } finally {
    channel.port1.close();
  }
}

async function readAndVerify(
  response: Response,
  file: AssetPackFile,
  cryptoImpl: Crypto,
  signal: AbortSignal | undefined,
  onBytes: (bytes: number) => void,
): Promise<Uint8Array> {
  if (!response.ok) throw new AssetPackError('network', `Download failed (${response.status}): ${file.path}`);
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      assertNotAborted(signal);
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      received += result.value.byteLength;
      onBytes(result.value.byteLength);
      if (received > file.bytes) {
        await reader.cancel();
        throw new AssetPackError('integrity', `Downloaded asset has the wrong size: ${file.path}`);
      }
    }
  } else {
    const bytes = new Uint8Array(await response.arrayBuffer());
    chunks.push(bytes);
    received = bytes.byteLength;
    onBytes(received);
  }
  if (received !== file.bytes) throw new AssetPackError('integrity', `Downloaded asset has the wrong size: ${file.path}`);

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', body));
  const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actual !== file.sha256) throw new AssetPackError('integrity', `Downloaded asset failed verification: ${file.path}`);
  return body;
}

async function fetchAndVerifyObject(
  fetchImpl: typeof fetch,
  file: AssetPackFile,
  build: string,
  cryptoImpl: Crypto,
  signal: AbortSignal,
  timeoutMs: number,
  onBytes: (bytes: number) => void,
  cache: 'force-cache' | 'reload',
): Promise<{ response: Response; body: Uint8Array }> {
  assertNotAborted(signal);
  const requestController = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;
  let timedOut = false;
  const timeoutError = (cause?: unknown): AssetPackError => new AssetPackError(
    'network', `Download timed out: ${file.path}`, cause === undefined ? undefined : { cause },
  );

  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      requestController.abort();
      reject(timeoutError());
    }, timeoutMs);
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const abort = (): void => {
      requestController.abort();
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', abort);
    if (signal.aborted) abort();
  });
  const requestPromise = (async (): Promise<{ response: Response; body: Uint8Array }> => {
    try {
      const response = await fetchImpl(fetchPath(file.path, build), {
        cache,
        credentials: 'same-origin',
        headers: { [ASSET_PACK_DOWNLOAD_HEADER]: build },
        signal: requestController.signal,
      });
      const body = await readAndVerify(response, file, cryptoImpl, requestController.signal, onBytes);
      assertNotAborted(requestController.signal);
      return { response, body };
    } catch (cause) {
      if (signal.aborted) throw abortError();
      if (timedOut) throw timeoutError(cause);
      if (cause instanceof AssetPackError) throw cause;
      throw new AssetPackError('network', `Could not download ${file.path}`, { cause });
    }
  })();

  try {
    return await Promise.race([requestPromise, timeoutPromise, abortPromise]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    removeAbortListener?.();
  }
}

async function collectRetainedHashes(cache: Cache, origin: string): Promise<Set<string>> {
  const retained = new Set<string>();
  for (const path of [
    CURRENT_PATH, CORE_PATH, PREVIOUS_PATH, INSTALLING_PATH,
    DEPLOYMENT_CURRENT_PATH, DEPLOYMENT_PREVIOUS_PATH,
  ]) {
    const manifest = await readPointer(cache, origin, path);
    for (const file of manifest?.files ?? []) retained.add(file.sha256);
  }
  return retained;
}

async function garbageCollect(cache: Cache, origin: string): Promise<void> {
  const retained = await collectRetainedHashes(cache, origin);
  const current = await readPointer(cache, origin, CURRENT_PATH);
  const previous = await readPointer(cache, origin, PREVIOUS_PATH);
  const retainedManifests = new Set([current?.build, previous?.build].filter(Boolean));
  const keys = await cache.keys();
  await Promise.all(keys.map(async (request) => {
    const path = new URL(request.url).pathname;
    if ([
      CURRENT_PATH, CORE_PATH, PREVIOUS_PATH, INSTALLING_PATH,
      DEPLOYMENT_CURRENT_PATH, DEPLOYMENT_PREVIOUS_PATH,
    ].includes(path)) return;
    if (path.startsWith('/_pkw-pack/content/')) {
      const hash = path.slice('/_pkw-pack/content/'.length);
      if (!retained.has(hash)) await cache.delete(request);
      return;
    }
    if (path.startsWith('/_pkw-pack/manifest/')) {
      const encoded = path.slice('/_pkw-pack/manifest/'.length, -'.json'.length);
      if (!retainedManifests.has(decodeURIComponent(encoded))) await cache.delete(request);
    }
  }));
}

/** Download/resume, verify, then atomically move the `current` pointer.
 * Returns null when first-page worker control is deferred and online play
 * should continue without starting the optional transfer. */
export async function ensureAssetPack(environment: AssetPackEnvironment): Promise<AssetPackManifest | null> {
  const fetchImpl = environment.fetch ?? globalThis.fetch;
  const cacheStorage = environment.cacheStorage ?? globalThis.caches;
  const cryptoImpl = environment.crypto ?? globalThis.crypto;
  const origin = environment.origin ?? (typeof location === 'undefined' ? 'https://play.pixelkingdomwars.com' : location.origin);
  const storage = environment.storage ?? (typeof navigator === 'undefined' ? undefined : navigator.storage);
  const serviceWorker = environment.serviceWorker ?? (typeof navigator === 'undefined' ? undefined : navigator.serviceWorker);
  const requireController = environment.requireController ?? typeof window !== 'undefined';
  const concurrency = boundedConcurrency(environment.concurrency, DEFAULT_CONCURRENCY, 6);
  const inventoryConcurrency = boundedConcurrency(
    environment.inventoryConcurrency, DEFAULT_INVENTORY_CONCURRENCY, 16,
  );
  const configuredObjectTimeoutMs = environment.objectTimeoutMs ?? DEFAULT_OBJECT_TIMEOUT_MS;
  const objectTimeoutMs = Number.isFinite(configuredObjectTimeoutMs)
    ? Math.max(1, Math.floor(configuredObjectTimeoutMs))
    : DEFAULT_OBJECT_TIMEOUT_MS;
  const progress = environment.onProgress ?? (() => undefined);
  const progressNow = environment.progressNow ?? (() => globalThis.performance?.now() ?? Date.now());
  if (!fetchImpl || !cacheStorage || !cryptoImpl?.subtle) {
    throw new AssetPackError('unsupported', 'This phone cannot store the offline game pack');
  }
  assertNotAborted(environment.signal);
  // Start installation before the large transfer so skipWaiting/clients.claim
  // normally controls this very first page long before the pack completes.
  if (requireController) {
    if (!serviceWorker) throw new AssetPackError('service-worker', 'Offline game storage is unavailable on this phone');
    const workerRegistration = await serviceWorker
      .register(`/sw.js?v=${encodeURIComponent(environment.build)}`, { scope: '/' })
      .catch((cause) => { throw new AssetPackError('service-worker', 'Offline game storage could not start', { cause }); });
    // This precedes the 200+ MB transfer deliberately. An older controller does
    // not know the exact-build installer bypass protocol and could duplicate
    // responses in its stale per-build shell cache before replacement.
    const controlsPage = await awaitServiceWorkerController(
      serviceWorker, workerRegistration, environment.build,
      environment.controllerTimeoutMs ?? 10_000, environment.signal,
    );
    // A clean install may activate its worker without controlling the already
    // open TWA page. The game remains fully usable online; do not start a large
    // transfer that this page cannot safely consume and do not surface an error.
    if (!controlsPage) return null;
  }
  assertNotAborted(environment.signal);
  progress({ kind: 'checking' });

  const cache = await cacheStorage.open(ASSET_PACK_CACHE);
  await flushWorkerInventory(serviceWorker, environment.build, environment.signal);
  // Offline relaunch is a first-class path. The current pointer is written only
  // after every object was verified, but still check every immutable cache entry
  // and its provenance headers so manual eviction/corruption resumes instead of
  // mounting Phaser into a partial world.
  const committed = await readPointer(cache, origin, CURRENT_PATH);
  if (committed) {
    try {
      const current = validateAssetPackManifest(committed, environment.build);
      const uniqueFiles = [...new Map(current.files.map((file) => [file.sha256, file])).values()];
      const complete = (await mapLimit(uniqueFiles, inventoryConcurrency, async (file) => {
        assertNotAborted(environment.signal);
        const hit = await cache.match(internalUrl(origin, contentPath(file.sha256)));
        return !!hit && hit.headers.get('x-pkw-sha256') === file.sha256
          && hit.headers.get('x-pkw-bytes') === String(file.bytes);
      })).every(Boolean);
      if (complete) {
        await cache.delete(internalUrl(origin, INSTALLING_PATH));
        await commitCorePointer(cache, origin, current);
        progress({
          kind: 'preparing', totalBytes: current.totalBytes, totalFiles: current.files.length,
          cachedBytes: current.totalBytes, cachedFiles: current.files.length,
        });
        await notifyPackCommitted(serviceWorker, current.build, requireController);
        progress({ kind: 'ready', totalBytes: current.totalBytes, totalFiles: current.files.length });
        return current;
      }
    } catch (cause) {
      // A different build or malformed pointer is not authoritative. Fetch the
      // exact current manifest and reuse any valid content hashes below.
      if (cause instanceof AssetPackError && cause.code === 'aborted') throw cause;
    }
  }

  let response: Response;
  try {
    response = await fetchImpl(`/asset-pack.json?v=${encodeURIComponent(environment.build)}`, {
      cache: 'no-store', credentials: 'same-origin',
      ...(environment.signal ? { signal: environment.signal } : {}),
    });
  } catch (cause) {
    if (environment.signal?.aborted) throw abortError();
    throw new AssetPackError('network', 'Could not reach the game download server', { cause });
  }
  if (!response.ok) throw new AssetPackError('network', `Game download manifest failed (${response.status})`);
  const manifest = validateAssetPackManifest(await responseJson(response), environment.build);
  // Retain resumable objects while a new build is being verified. This pointer
  // is never served as a complete pack; CURRENT_PATH remains the atomic gate.
  await cache.put(internalUrl(origin, INSTALLING_PATH), manifestResponse(manifest));

  const groups = new Map<string, { file: AssetPackFile; paths: number; tier: AssetPackFile['tier'] }>();
  for (const file of manifest.files) {
    const group = groups.get(file.sha256);
    if (group) {
      group.paths += 1;
      // Identical bytes used by both tiers are core: one verified object serves
      // both logical paths, and the full tier must never delay core readiness.
      if (group.tier === 'full' && file.tier === 'core') { group.file = file; group.tier = 'core'; }
    } else groups.set(file.sha256, { file, paths: 1, tier: file.tier });
  }
  const grouped = [...groups.values()].sort((a, b) => (
    a.tier === b.tier ? 0 : a.tier === 'core' ? -1 : 1
  ));
  const cached = new Set<string>();
  let cachedBytes = 0;
  let cachedFiles = 0;
  const inventory = await mapLimit(grouped, inventoryConcurrency, async ({ file }) => {
    assertNotAborted(environment.signal);
    const hit = await cache.match(internalUrl(origin, contentPath(file.sha256)));
    return !!hit && hit.headers.get('x-pkw-sha256') === file.sha256
      && hit.headers.get('x-pkw-bytes') === String(file.bytes);
  });
  for (let index = 0; index < grouped.length; index += 1) {
    const { file, paths } = grouped[index]!;
    if (inventory[index]) {
      cached.add(file.sha256);
      cachedBytes += file.bytes;
      cachedFiles += paths;
    }
  }
  progress({
    kind: 'preparing', totalBytes: manifest.totalBytes, totalFiles: manifest.files.length,
    cachedBytes, cachedFiles,
  });
  const missing = grouped.filter(({ file }) => !cached.has(file.sha256));
  let verifiedBytes = cachedBytes;
  let verifiedFiles = cachedFiles;
  const inFlight = new Map<string, number>();
  let lastDownloadProgressAt = Number.NEGATIVE_INFINITY;
  const reportDownload = (force = false): void => {
    const now = progressNow();
    // D-101: React learns about progress at most once per publish interval —
    // every publish is a store write and a re-render of the pack surfaces.
    if (!force && now - lastDownloadProgressAt < ASSET_PACK_TRANSFER.progressPublishMs) return;
    lastDownloadProgressAt = now;
    progress({
      kind: 'downloading', totalBytes: manifest.totalBytes, totalFiles: manifest.files.length,
      downloadedBytes: Math.min(manifest.totalBytes, verifiedBytes + [...inFlight.values()].reduce((a, b) => a + b, 0)),
      downloadedFiles: verifiedFiles,
    });
  };
  reportDownload(true);

  const transferController = new AbortController();
  const cancelTransfer = (): void => transferController.abort();
  environment.signal?.addEventListener('abort', cancelTransfer, { once: true });
  if (environment.signal?.aborted) transferController.abort();
  const transfer = async (batch: typeof missing): Promise<void> => {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < batch.length) {
        const group = batch[cursor++]!;
        const file = group.file;
        assertNotAborted(transferController.signal);
        inFlight.set(file.path, 0);
        reportDownload();
        const fetchVerified = (cacheMode: 'force-cache' | 'reload') => fetchAndVerifyObject(
          fetchImpl, file, manifest.build, cryptoImpl, transferController.signal, objectTimeoutMs, (bytes) => {
            inFlight.set(file.path, (inFlight.get(file.path) ?? 0) + bytes);
            reportDownload();
          }, cacheMode,
        );
        let downloaded: Awaited<ReturnType<typeof fetchVerified>>;
        try {
          downloaded = await fetchVerified('force-cache');
        } catch (cause) {
          if (!(cause instanceof AssetPackError) || cause.code !== 'integrity') throw cause;
          // A stale/corrupt HTTP-cache entry cannot wedge this build forever.
          // Reset transient progress before one network-revalidated attempt.
          inFlight.set(file.path, 0);
          reportDownload();
          downloaded = await fetchVerified('reload');
        }
        const { response: assetResponse, body } = downloaded;
        const headers = new Headers();
        const contentType = assetResponse.headers.get('content-type');
        if (contentType) headers.set('content-type', contentType);
        headers.set('cache-control', 'public, max-age=31536000, immutable');
        headers.set('x-pkw-sha256', file.sha256);
        headers.set('x-pkw-bytes', String(file.bytes));
        try {
          await cache.put(
            internalUrl(origin, contentPath(file.sha256)),
            new Response(body.buffer as ArrayBuffer, { status: 200, headers }),
          );
        } catch (cause) {
          throw new AssetPackError('quota', 'Phone storage filled while downloading the game', { cause });
        }
        inFlight.delete(file.path);
        verifiedBytes += file.bytes;
        verifiedFiles += group.paths;
        reportDownload();
      }
    };
    let firstFailure: unknown;
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, batch.length)) }, () => (
      worker().catch((cause: unknown) => {
        if (firstFailure === undefined) firstFailure = cause;
        transferController.abort();
        throw cause;
      })
    ));
    const results = await Promise.allSettled(workers);
    if (results.some((result) => result.status === 'rejected')) throw firstFailure;
  };

  try {
    await requestPersistentStorage(storage);
    const missingCore = missing.filter((group) => group.tier === 'core');
    const missingFull = missing.filter((group) => group.tier === 'full');
    await requireQuota(storage, missingCore.reduce((sum, group) => sum + group.file.bytes, 0));
    await transfer(missingCore);
    assertNotAborted(environment.signal);
    // Strict phase boundary: no full-tier request can begin until this atomic
    // core marker exists. A pause/failure afterwards still leaves a playable
    // hosted bootstrap for the next launch.
    await commitCorePointer(cache, origin, manifest);
    await requireQuota(storage, missingFull.reduce((sum, group) => sum + group.file.bytes, 0));
    await transfer(missingFull);
  } finally {
    environment.signal?.removeEventListener('abort', cancelTransfer);
  }
  assertNotAborted(environment.signal);
  // Chunk reads can arrive thousands of times per second. Force one exact
  // terminal snapshot without scheduling a callback that could outlive an
  // aborted/failed install.
  reportDownload(true);

  // Commit order is load-bearing: content + versioned manifest first, then the
  // one small current pointer. A failed download can never expose a partial pack.
  const previous = await readPointer(cache, origin, CURRENT_PATH);
  await cache.put(internalUrl(origin, manifestPath(manifest.build)), manifestResponse(manifest));
  if (previous && previous.build !== manifest.build) {
    await cache.put(internalUrl(origin, PREVIOUS_PATH), new Response(JSON.stringify(previous), {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    }));
  }
  await cache.put(internalUrl(origin, CURRENT_PATH), manifestResponse(manifest));
  await cache.delete(internalUrl(origin, INSTALLING_PATH));
  await garbageCollect(cache, origin);
  await notifyPackCommitted(serviceWorker, manifest.build, requireController);
  progress({ kind: 'ready', totalBytes: manifest.totalBytes, totalFiles: manifest.files.length });
  return manifest;
}

export function assetPackErrorMessage(error: unknown): string {
  if (error instanceof AssetPackError) return error.message.toUpperCase();
  return 'GAME DOWNLOAD FAILED — RETRY';
}

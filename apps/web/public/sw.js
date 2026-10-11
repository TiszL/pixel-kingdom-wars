/**
 * Service worker — offline shell, fast repeat loads, and updates that actually
 * arrive.
 *
 * Written by hand rather than generated. The dependency-free version is about
 * eighty lines, and every one of the decisions below is a decision I want
 * visible in the repo rather than buried in a plugin's defaults — this is the
 * component that decides whether a player ever receives a bug fix.
 *
 * VERSIONING. This file is registered as `/sw.js?v=<gitSha>`. Two consequences,
 * both deliberate:
 *   - the browser sees a byte-different script URL on every deploy, which is
 *     what makes it re-install at all;
 *   - the shell cache name is derived from that `v`, so a new build writes to a
 *     NEW cache. `activate` retains only pointer-backed generations and deletes
 *     unrelated older shells. Updates are atomic — you never end up with half
 *     of build A and half of build B, which is the failure mode that produces
 *     bugs nobody can reproduce.
 *
 * CACHING STRATEGY, and why it is not "precache everything". The production dist
 * is well over 175 MB once generated atlases and on-demand audio are included.
 * Ordinary browser tabs cache on demand into the same verified,
 * content-addressed PACK_CACHE. The Solana Mobile TWA can additionally fill the
 * complete pack in the background. That cache is deliberately NOT tied to a
 * shell build: unchanged objects survive updates and only a fully verified full
 * manifest can become current. So:
 *
 *   navigation  → NETWORK FIRST. The HTML names the content-hashed JS/CSS, so
 *                 fetching it fresh is what makes a deploy reach the player at
 *                 all. Falls back to the cached shell when offline or when a
 *                 repeat-launch update check exceeds its bounded deadline.
 *   /assets/*   → CACHE FIRST, permanently. Vite content-hashes these filenames,
 *                 so a given URL's bytes never change. A cache hit is always
 *                 correct and a miss is always a genuinely new file.
 *   atlas,audio → HASH CACHE FIRST, on demand. Big, stable URLs are resolved
 *   brand,icons   through the current build's hash-pinned deployment inventory.
 *   everything  → straight to network. API calls in particular must never be
 *   else          served from a cache — a stale base state is a wrong game.
 */

const BUILD = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = `pkw-shell-${BUILD}`;
// Shared protocol with src/lib/assetPack.ts. Never rename one without the other.
const PACK_CACHE = 'pkw-asset-pack-v1';
const PUSH_SESSION_CACHE = 'pkw-push-session-v1';
const PUSH_SESSION_SUSPENDED = '/_pkw-push/session-suspended';
const PUSH_SESSION_RESUMED = '/_pkw-push/session-resumed';
const PUSH_SESSION_SUSPENDED_MESSAGE = 'push-session-suspended';
const PUSH_SESSION_RESUMED_MESSAGE = 'push-session-resumed';
const PUSH_SESSION_RESULT_MESSAGE = 'push-session-result';
const PACK_CURRENT = '/_pkw-pack/current.json';
const PACK_CORE = '/_pkw-pack/core.json';
const PACK_PREVIOUS = '/_pkw-pack/previous.json';
const PACK_INSTALLING = '/_pkw-pack/installing.json';
const PACK_DEPLOYMENT_CURRENT = '/_pkw-pack/deployment-current.json';
const PACK_DEPLOYMENT_PREVIOUS = '/_pkw-pack/deployment-previous.json';
const PACK_POINTERS = [
  PACK_CURRENT, PACK_CORE, PACK_PREVIOUS, PACK_INSTALLING,
  PACK_DEPLOYMENT_CURRENT, PACK_DEPLOYMENT_PREVIOUS,
];
const PACK_INDEX_POINTERS = [
  PACK_CURRENT, PACK_PREVIOUS,
  PACK_DEPLOYMENT_CURRENT, PACK_DEPLOYMENT_PREVIOUS,
  // Last: a core pointer is intentionally only a subset. Prefer the complete
  // deployment index whenever it exists so full-tier misses are still pinned
  // and hash-verified instead of falling through as unknown paths.
  PACK_CORE,
];
const PACK_PATH = /^\/(assets|atlas|audio|brand|icons)\//;
const PACK_HASH = /^[0-9a-f]{64}$/;
// The origin retains immutable snapshots only for complete release identities.
const RELEASE_BUILD = /^[0-9a-f]{40}$/;
// Only the terrain loader verifies network bytes before decode and owns bounded
// resumable transfers. Other atlas consumers still receive verified full bodies.
const GROUND_STREAM_HEADER = 'x-pkw-ground-stream';
const GROUND_STREAM_PATH = /^\/atlas\/fantasy\/ground(?:-v[234])?\/[a-z][a-z0-9-]*\.(?:png|webp)$/;
const GLOBE_STREAM_PATH = /^\/atlas\/fantasy\/globe\/(?:generated\/)?[a-z][a-z0-9-]*\.png$/;
const LAYERED_GROUND_STREAM_PATH = /^\/atlas\/fantasy\/layered-ground\/(?:([0-9a-f]{64})\/manifest\.json|assets\/([0-9a-f]{64})\.(?:png|webp))$/;
const PACK_MANIFEST_TIMEOUT_MS = 8_000;
// index.html owns this fixed icon/manifest revision. Runtime atlas, audio,
// brand and MWA icon URLs carry BUILD; notification icons carry no v.
const SHELL_STATIC_REVISION = 'c0137365';
const BUILD_BOUND_STABLE_PATH = /^\/(atlas|audio|brand)\//;
const PACK_CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.mp3', 'audio/mpeg'],
  ['.png', 'image/png'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'], ['.wav', 'audio/wav'],
  ['.woff2', 'font/woff2'],
]);
// Android keeps the native TWA splash visible until its first navigation
// produces HTML. Weak connectivity can leave fetch() pending indefinitely, so
// once a verified shell already exists, bound the update check and paint that
// shell instead. A first install with no fallback keeps the normal, unbounded
// network request rather than turning a merely slow first visit into an error.
const NAVIGATION_NETWORK_TIMEOUT_MS = 8_000;

/** The minimum needed to render something. Everything else arrives on demand. */
const SHELL = [
  '/',
  '/index.html',
  `/manifest.webmanifest?v=${SHELL_STATIC_REVISION}`,
  `/icons/icon-192.png?v=${SHELL_STATIC_REVISION}`,
];

function isExplicitBuildBoundAsset(url) {
  const version = url.searchParams.get('v');
  if (!version) return false;
  if (BUILD_BOUND_STABLE_PATH.test(url.pathname)) return true;
  return url.pathname.startsWith('/icons/') && version !== SHELL_STATIC_REVISION;
}

function validPackManifest(value, expectedBuild = BUILD) {
  // Schema 1 is the rolling-deploy predecessor: its files had no tier and are
  // treated as the legacy full pack. Schema 2 makes every tier explicit so a
  // partially installed core pointer cannot smuggle an unclassified object.
  const legacy = value?.schema === 1;
  const tiered = value?.schema === 2;
  if ((!legacy && !tiered) || value.build !== expectedBuild || !Array.isArray(value.files)) return null;
  const paths = new Map();
  const digests = new Map();
  for (const file of value.files) {
    const dot = typeof file?.path === 'string' ? file.path.lastIndexOf('.') : -1;
    const expectedType = PACK_CONTENT_TYPES.get(dot < 0 ? '' : file.path.slice(dot).toLowerCase());
    if (!PACK_PATH.test(file?.path) || !PACK_HASH.test(file?.sha256)
      || file.path.includes('?') || file.path.includes('#') || file.path.includes('..')
      || !Number.isSafeInteger(file?.bytes) || file.bytes < 0
      || file?.contentType !== expectedType || paths.has(file.path)
      || (legacy ? file?.tier !== undefined : !['core', 'full'].includes(file?.tier))
      || (digests.has(file.sha256) && digests.get(file.sha256) !== file.bytes)) return null;
    paths.set(file.path, file);
    digests.set(file.sha256, file.bytes);
  }
  return paths.size > 0 ? { build: value.build, files: value.files, paths } : null;
}

async function readPackPointer(cache, path) {
  const response = await cache.match(new URL(path, self.location.origin).href);
  if (!response) return null;
  try { return await response.json(); } catch { return null; }
}

function packPointerResponse(manifest) {
  return new Response(JSON.stringify(manifest), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

async function refreshDeploymentIndex() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PACK_MANIFEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`/asset-pack.json?v=${encodeURIComponent(BUILD)}`, {
      cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) return null;
  let manifest;
  try { manifest = await response.json(); } catch { return null; }
  const manifestBuild = typeof manifest?.build === 'string' ? manifest.build : '';
  if (!manifestBuild || !validPackManifest(manifest, manifestBuild)) return null;
  // A browser may auto-update the registered /sw.js?v=A URL after B deploys.
  // The fetched script bytes are then B but self.location still says A. Reject
  // before either generation's cache or control state can be mutated.
  if (manifestBuild !== BUILD) return manifestBuild;
  const cache = await caches.open(PACK_CACHE);
  const previous = await readPackPointer(cache, PACK_DEPLOYMENT_CURRENT);
  if (previous?.build && previous.build !== BUILD) {
    await cache.put(
      new URL(PACK_DEPLOYMENT_PREVIOUS, self.location.origin).href,
      packPointerResponse(previous),
    );
  }
  // This pointer is only a path-to-hash inventory. Unlike PACK_CURRENT it does
  // not claim that every object is present, so the TWA's atomic full-pack gate
  // remains untouched.
  await cache.put(
    new URL(PACK_DEPLOYMENT_CURRENT, self.location.origin).href,
    packPointerResponse(manifest),
  );
  packIndexPromises.clear();
  return manifestBuild;
}

async function garbageCollectPack() {
  const cache = await caches.open(PACK_CACHE);
  const retained = new Set();
  for (const pointer of PACK_POINTERS) {
    const manifest = await readPackPointer(cache, pointer);
    for (const file of manifest?.files ?? []) {
      if (PACK_HASH.test(file?.sha256)) retained.add(file.sha256);
    }
  }
  for (const request of await cache.keys()) {
    const pathname = new URL(request.url).pathname;
    if (!pathname.startsWith('/_pkw-pack/content/')) continue;
    const hash = pathname.slice('/_pkw-pack/content/'.length);
    if (!retained.has(hash)) await cache.delete(request);
  }
}

async function retainedShellCacheNames() {
  const retained = new Set([CACHE]);
  const cache = await caches.open(PACK_CACHE);
  for (const pointerPath of PACK_INDEX_POINTERS) {
    const manifest = await readPackPointer(cache, pointerPath);
    const build = typeof manifest?.build === 'string' ? manifest.build : '';
    if (build && validPackManifest(manifest, build)) retained.add(`pkw-shell-${build}`);
  }
  return retained;
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const deployedBuild = await refreshDeploymentIndex().catch(() => null);
    if (deployedBuild && deployedBuild !== BUILD) {
      throw new Error('stale service-worker registration');
    }
    const cache = await caches.open(CACHE);
    // Individually, not addAll: addAll is atomic, so one 404 on any entry throws
    // away the whole install and the worker never activates. A missing icon must
    // not cost the player their offline shell.
    await Promise.all(SHELL.map((url) => cache.add(url).catch(() => undefined)));
    // Take over as soon as installed. Normally you would wait, but the whole
    // point here is that a stale client stops being stale promptly, and the
    // per-build cache means there is no half-updated state to fear.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    const retainedShells = await retainedShellCacheNames().catch(() => new Set([CACHE]));
    await Promise.all(
      names
        .filter((n) => (n.startsWith('pkw-shell-')
          || (n.startsWith('pkw-') && n !== PACK_CACHE && n !== PUSH_SESSION_CACHE))
          && !retainedShells.has(n))
        .map((n) => caches.delete(n)),
    );
    await garbageCollectPack().catch(() => undefined);
    await self.clients.claim();
  })());
});

/** Big immutable static directories — worth keeping, never worth revalidating. */
const CACHEABLE = /^\/(assets|atlas|audio|brand|icons)\//;
// These are authoritative/live even when a reverse proxy puts them on the game
// origin. In particular, a top-level navigation must never overwrite the
// offline HTML fallback with an API/auth/RPC response.
const NEVER_CACHE = /^\/(api|auth|rpc)(?:\/|$)/;

const packIndexPromises = new Map();
// Normal runtime misses are hash-verified in the event lifetime. The pack page
// asks for a snapshot flush before inventory so it cannot race one of these
// writes and hash/fetch the same Boot object a second time.
const packObjectWrites = new Set();

function trackPackObjectWrite(work) {
  packObjectWrites.add(work);
  void work.then(
    () => packObjectWrites.delete(work),
    () => packObjectWrites.delete(work),
  );
  return work;
}

async function loadPackIndex(requestedBuild) {
  const expectedBuild = requestedBuild || BUILD;
  const existing = packIndexPromises.get(expectedBuild);
  if (existing) return existing;
  const indexPromise = (async () => {
    const cache = await caches.open(PACK_CACHE);
    for (const pointerPath of PACK_INDEX_POINTERS) {
      const manifest = await readPackPointer(cache, pointerPath);
      const index = validPackManifest(manifest, expectedBuild);
      if (index) return index;
    }
    return null;
  })();
  packIndexPromises.set(expectedBuild, indexPromise);
  let index;
  try {
    index = await indexPromise;
  } catch (error) {
    // A transient storage failure must not poison Boot's next bounded attempt.
    // An inventory refresh may already have installed a different lookup.
    if (packIndexPromises.get(expectedBuild) === indexPromise) {
      packIndexPromises.delete(expectedBuild);
    }
    throw error;
  }
  // Only the worker build and the retained pointer builds are worth memoizing;
  // arbitrary `?v=` values must not grow this long-lived worker's memory.
  if (!index && packIndexPromises.get(expectedBuild) === indexPromise) {
    packIndexPromises.delete(expectedBuild);
  }
  return index;
}

async function matchPack(file, verifyBody = false) {
  if (!file) return null;
  const cache = await caches.open(PACK_CACHE);
  const key = new URL(`/_pkw-pack/content/${file.sha256}`, self.location.origin).href;
  const hit = await cache.match(key);
  if (!hit) return null;
  if (hit.headers.get('x-pkw-sha256') !== file.sha256
    || hit.headers.get('x-pkw-bytes') !== String(file.bytes)) {
    if (verifyBody || isAtlasFile(file)) await cache.delete(key);
    return null;
  }
  if (verifyBody || isAtlasFile(file)) return verifiedPackHit(cache, key, file, hit);
  const headers = new Headers(hit.headers);
  if (file.contentType) headers.set('content-type', file.contentType);
  return new Response(hit.body, { status: hit.status, statusText: hit.statusText, headers });
}

async function matchBuildShell(request, build, file, verifyBody = false) {
  const cache = await caches.open(`pkw-shell-${build}`);
  const hit = await cache.match(request);
  return hit && (verifyBody || isAtlasFile(file)) ? verifiedPackHit(cache, request, file, hit) : hit;
}

const isAtlasFile = (file) => file?.path.startsWith('/atlas/');

// Atlas decoders and previous-generation recovery must verify the actual
// object, not saved headers. Current non-atlas assets keep their streaming path.
async function verifiedPackBytes(file, response) {
  if (response.status !== 200 || response.type === 'opaque') return null;
  try {
    const bytes = await response.arrayBuffer();
    return bytes.byteLength > 0 && bytes.byteLength === file.bytes
      && await sha256(bytes) === file.sha256 ? bytes : null;
  } catch { return null; }
}

// Generic atlas consumers cannot decode before integrity verification. Watch
// the upstream bytes here, where progress remains visible despite that buffer.
// Boot owns the finite overall foreground budget and its single retry.
async function fetchVerifiedAtlas(request, file, clientId) {
  const controller = new AbortController();
  const pollMs = 1_000, lookupMs = 250, idleLimitMs = 20_000;
  let reader, timer, visibilityTimer;
  let finished = false, idleMs = 0, lastSample = performance.now(), wasHidden = false;
  let rejectStopped;
  const stopped = new Promise((_, reject) => { rejectStopped = reject; });
  const cancelReader = () => { if (reader) void reader.cancel().catch(() => undefined); };
  const stop = () => {
    controller.abort(); cancelReader();
    rejectStopped(new Error('Atlas transfer stopped'));
  };
  const progress = () => { idleMs = 0; lastSample = performance.now(); };
  const sampleVisibility = async () => {
    let hidden = false;
    if (clientId && self.clients.get) {
      // An unavailable client lookup must not become another unbounded wait.
      const client = await Promise.race([
        Promise.resolve().then(() => self.clients.get(clientId)).catch(() => null),
        new Promise(resolve => { visibilityTimer = setTimeout(() => resolve(null), lookupMs); }),
      ]);
      clearTimeout(visibilityTimer);
      hidden = client?.visibilityState === 'hidden';
    }
    if (finished) return;
    const now = performance.now();
    // Do not charge a suspended interval or grant a fresh budget on return.
    // A suspended worker cannot sample the page while it is hidden. Charge
    // only the scheduled interval when callbacks resume, not an unobserved
    // scheduler gap. Boot's independent overall active ceiling still applies.
    if (!hidden && !wasHidden) idleMs += Math.min(pollMs + lookupMs, Math.max(0, now - lastSample));
    lastSample = now; wasHidden = hidden;
    if (idleMs >= idleLimitMs) stop();
    else timer = setTimeout(sampleVisibility, Math.min(pollMs, idleLimitMs - idleMs));
  };
  request.signal.addEventListener('abort', stop, { once: true });
  const work = (async () => {
    if (request.signal.aborted) { stop(); return null; }
    void sampleVisibility();
    const response = await fetch(new Request(request, { signal: controller.signal }));
    if (controller.signal.aborted) return null;
    if (response.status !== 200 || response.type === 'opaque') return { response, bytes: null };
    progress();
    if (!response.body) return null;
    const bytes = new Uint8Array(file.bytes);
    let received = 0;
    reader = response.body.getReader();
    while (!controller.signal.aborted) {
      const chunk = await reader.read();
      if (controller.signal.aborted) return null;
      if (chunk.done) break;
      if (chunk.value.byteLength > bytes.byteLength - received) return null;
      if (chunk.value.byteLength) {
        bytes.set(chunk.value, received); received += chunk.value.byteLength; progress();
      }
    }
    if (received === 0 || received !== file.bytes || await sha256(bytes) !== file.sha256
      || controller.signal.aborted) return null;
    return { response, bytes };
  })();
  let result;
  try { result = await Promise.race([work, stopped]); }
  catch { result = null; }
  finally {
    finished = true; clearTimeout(timer); clearTimeout(visibilityTimer);
    request.signal.removeEventListener('abort', stop);
    // Failures must stop the underlying transfer, even when it ignores abort.
    if (!result) { controller.abort(); cancelReader(); }
    if (reader) { try { reader.releaseLock(); } catch { /* Cancellation must retain the retryable response. */ } }
  }
  return result;
}

async function verifiedPackHit(cache, key, file, hit) {
  const bytes = await verifiedPackBytes(file, hit);
  if (!bytes) {
    await cache.delete(key);
    return null;
  }
  return new Response(bytes, { headers: { 'content-type': file.contentType } });
}

function unavailableGenerationResponse() {
  return new Response('Asset generation unavailable', {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function cacheableNavigationResponse(response) {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (response.status !== 200 || contentType !== 'text/html') return false;
  if (!response.url) return true;
  try { return new URL(response.url).origin === self.location.origin; } catch { return false; }
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function storePackObject(file, response) {
  if (!file || response.status !== 200 || response.type === 'opaque') return;
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== file.bytes || await sha256(bytes) !== file.sha256) return;
  await storePackBytes(file, bytes);
}

async function storeGroundStream(file, response, signal) {
  if (signal.aborted || !response.body) return;
  const reader = response.body.getReader();
  // Do not use arrayBuffer on an untrusted streaming miss: an oversized body
  // must not keep growing a second, worker-owned copy after the page aborts.
  const bytes = new Uint8Array(file.bytes);
  let received = 0;
  let complete = false;
  // A cloned response is a tee. Cancelling this branch must not wait for the
  // page's branch to finish before the worker can release its event lifetime.
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (signal.aborted || value.byteLength > bytes.byteLength - received) return;
      bytes.set(value, received);
      received += value.byteLength;
    }
    if (signal.aborted || !complete || received === 0 || received !== file.bytes) return;
    if (await sha256(bytes) !== file.sha256 || signal.aborted) return;
    await storePackBytes(file, bytes, signal);
  } finally {
    signal.removeEventListener('abort', cancel);
    if (!complete) cancel();
  }
}

async function storePackBytes(file, bytes, signal) {
  const headers = new Headers({
    'content-type': file.contentType,
    'cache-control': 'public, max-age=31536000, immutable',
    'x-pkw-sha256': file.sha256,
    'x-pkw-bytes': String(file.bytes),
  });
  const cache = await caches.open(PACK_CACHE);
  if (signal?.aborted) return;
  await cache.put(
    new URL(`/_pkw-pack/content/${file.sha256}`, self.location.origin).href,
    new Response(bytes, { status: 200, headers }),
  );
}

function rangedResponse(full, rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  return (async () => {
    const bytes = new Uint8Array(await full.arrayBuffer());
    const size = bytes.byteLength;
    if (size === 0) return new Response(null, {
      status: 416, headers: { 'content-range': 'bytes */0' },
    });
    let start;
    let end;
    if (match[1] === '') {
      const suffix = Number(match[2]);
      if (!Number.isSafeInteger(suffix) || suffix <= 0) return new Response(null, {
        status: 416, headers: { 'content-range': `bytes */${size}` },
      });
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
        return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      }
    }
    const headers = new Headers(full.headers);
    headers.delete('content-encoding');
    headers.delete('x-pkw-sha256');
    headers.delete('x-pkw-bytes');
    headers.set('accept-ranges', 'bytes');
    headers.set('content-range', `bytes ${start}-${end}/${size}`);
    headers.set('content-length', String(end - start + 1));
    return new Response(bytes.slice(start, end + 1), { status: 206, headers });
  })();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Same-origin only. Cross-origin means the API, the RPC or a wallet; caching
  // any of those would serve a stale world or, worse, a stale balance.
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.test(url.pathname)) return;

  if (req.mode === 'navigate') {
    let backgroundWork = Promise.resolve();
    const responseWork = (async () => {
      const currentCache = await caches.open(CACHE);
      // Activation keeps one pointer-backed rollback shell for already-open
      // pages, but a new navigation must prefer this worker's own HTML.
      const cachedShell = await currentCache.match('/index.html')
        || await caches.match('/index.html');
      if (!cachedShell) return fetch(req);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), NAVIGATION_NETWORK_TIMEOUT_MS);
      try {
        const fresh = await fetch(req, { signal: controller.signal });
        if (cacheableNavigationResponse(fresh)) {
          backgroundWork = currentCache.put('/index.html', fresh.clone()).catch(() => undefined);
        }
        return fresh;
      } catch {
        // Offline or too slow to dismiss the native TWA splash. Serve the last
        // shell we saw; the app's own version check sorts itself out when
        // connectivity returns.
        return cachedShell;
      } finally {
        clearTimeout(timeout);
      }
    })();
    event.respondWith(responseWork);
    event.waitUntil(responseWork.then(() => backgroundWork).catch(() => undefined));
    return;
  }

  if (!CACHEABLE.test(url.pathname)) return;
  const requestedBuild = url.searchParams.get('v');
  const staleBuildBound = isExplicitBuildBoundAsset(url) && requestedBuild !== BUILD;
  const groundStream = req.headers.has(GROUND_STREAM_HEADER);

  // The first-launch pack downloader deliberately requests the SAME logical
  // URL Boot/Phaser already used, so the browser HTTP cache can reuse those
  // bytes. It verifies and writes the content-addressed object itself. Letting
  // the worker also hash/store this response duplicates the largest main-thread
  // work on the exact devices the core tier protects. The build value is the
  // authorization boundary: a stale page cannot bypass this worker's pinned
  // generation routing by merely sending the header.
  if (!groundStream && !staleBuildBound && req.headers.get('x-pkw-pack-download') === BUILD) {
    event.respondWith(fetch(req));
    return;
  }

  let backgroundWork = Promise.resolve();
  const responseWork = (async () => {
    // The first-launch downloader must see deployment bytes, never the previous
    // pack's object at the same stable path. It verifies and stores the response
    // itself; caching it here would also duplicate the complete 200+ MB pack in
    // the per-build shell cache.
    if (!groundStream && !staleBuildBound && url.searchParams.get('pack')) return fetch(req);
    // The installed pack stores complete verified objects. Satisfy media Range
    // requests from that full object; never cache a network 206 response.
    const index = await loadPackIndex(requestedBuild);
    const file = index?.paths.get(url.pathname) ?? null;
    // Layered manifests and textures are content-addressed, but still require
    // this build's published inventory. A hash-shaped path alone admits nothing.
    const layeredStream = LAYERED_GROUND_STREAM_PATH.exec(url.pathname);
    const layeredStreamFile = layeredStream && (layeredStream[1] || layeredStream[2]) === file?.sha256;
    if (groundStream && (!RELEASE_BUILD.test(requestedBuild)
      || req.headers.get(GROUND_STREAM_HEADER) !== requestedBuild
      || url.searchParams.size !== 1 || (!GROUND_STREAM_PATH.test(url.pathname) && !GLOBE_STREAM_PATH.test(url.pathname) && !layeredStreamFile)
      || req.headers.has('x-pkw-pack-download') || index?.build !== requestedBuild || !file)) {
      return unavailableGenerationResponse();
    }
    const pinnedPrevious = !!requestedBuild && requestedBuild !== BUILD
      && index?.build === requestedBuild;
    const packHit = await matchPack(file, staleBuildBound);
    const previousShellHit = !packHit && pinnedPrevious && (!staleBuildBound || file)
      ? await matchBuildShell(req, requestedBuild, file, staleBuildBound)
      : null;
    if (groundStream) {
      // A verified cache object has no origin validator. A full 200 lets the
      // resumable loader discard its prefix; inventing a 206 could splice two
      // representations together. Preserve ordinary media Range behavior below.
      const hit = packHit || previousShellHit
        || (!pinnedPrevious && await matchBuildShell(req, requestedBuild, file, true));
      if (hit) return hit;
      let res;
      try {
        res = await fetch(new Request(req, { cache: 'reload', redirect: 'error' }));
      } catch { return unavailableGenerationResponse(); }
      if (res.type === 'opaque' || (res.status !== 200 && res.status !== 206)) {
        return unavailableGenerationResponse();
      }
      // The page verifies the assembled body before decode. Deliver headers and
      // bytes immediately so its progress deadline and Range recovery can work.
      // A partial response never becomes a full offline pack object.
      if (res.status === 200) {
        backgroundWork = trackPackObjectWrite(storeGroundStream(file, res.clone(), req.signal))
          .catch(() => undefined);
      }
      return res;
    }
    if (req.headers.has('range')) {
      if (packHit || previousShellHit) {
        const ranged = rangedResponse(packHit || previousShellHit, req.headers.get('range'));
        if (ranged) return ranged;
      }
      if (!staleBuildBound && !isAtlasFile(file)) return fetch(req);
    }
    if (packHit) return packHit;
    if (previousShellHit) return previousShellHit;
    if (staleBuildBound) {
      // A missing old object can be recovered only from its immutable release
      // URL against an already-retained, validated inventory. Never discover a
      // new manifest or trust a path-only shell hit to authorize old bytes.
      if (!pinnedPrevious || !file || !RELEASE_BUILD.test(requestedBuild)) {
        return unavailableGenerationResponse();
      }
      const headers = new Headers(req.headers);
      headers.delete('range');
      const request = new Request(req, { headers, cache: 'reload', redirect: 'error' });
      let bytes;
      if (isAtlasFile(file)) bytes = (await fetchVerifiedAtlas(request, file, event.clientId))?.bytes;
      else {
        let res;
        try { res = await fetch(request); } catch { return unavailableGenerationResponse(); }
        bytes = await verifiedPackBytes(file, res);
      }
      if (!bytes) return unavailableGenerationResponse();
      backgroundWork = trackPackObjectWrite(storePackBytes(file, bytes)).catch(() => undefined);
      const verified = new Response(bytes, { headers: { 'content-type': file.contentType } });
      // Ignore unsupported multipart/malformed Range syntax with a verified
      // full 200; never pass the unverified network range through instead.
      return req.headers.has('range')
        ? await rangedResponse(verified, req.headers.get('range')) || verified
        : verified;
    }
    const hit = isAtlasFile(file)
      ? await matchBuildShell(req, requestedBuild || BUILD, file)
      : await caches.match(req);
    if (hit) {
      return req.headers.has('range') ? await rangedResponse(hit, req.headers.get('range')) || hit : hit;
    }
    if (isAtlasFile(file)) {
      // One generation-safe network recovery also bypasses a bad HTTP-cache
      // entry. Validate a complete object before serving a requested range.
      const headers = new Headers(req.headers);
      headers.delete('range');
      const result = await fetchVerifiedAtlas(new Request(req, { headers, cache: 'reload' }), file, event.clientId);
      if (!result) return unavailableGenerationResponse();
      if (result.response.status !== 200) return result.response;
      const bytes = result.bytes;
      if (!bytes) return unavailableGenerationResponse();
      backgroundWork = trackPackObjectWrite(storePackBytes(file, bytes)).catch(() => undefined);
      const verified = new Response(bytes, { headers: { 'content-type': file.contentType } });
      return req.headers.has('range')
        ? await rangedResponse(verified, req.headers.get('range')) || verified
        : verified;
    }
    const res = await fetch(req);
    if (file && res.status === 200 && res.type !== 'opaque') {
      // Paint immediately; hash verification and content-addressed storage run
      // in the fetch event's lifetime. A bad/truncated response is simply not
      // reusable and can never poison the logical path.
      backgroundWork = trackPackObjectWrite(storePackObject(file, res.clone())).catch(() => undefined);
      return res;
    }
    // Only cache real successes. Storing an opaque or error response poisons the
    // cache for the lifetime of the build, and the player cannot clear it.
    if (res.status === 200 && res.type === 'basic') {
      const cache = await caches.open(CACHE);
      await cache.put(req, res.clone());
    }
    return res;
  })();
  event.respondWith(responseWork);
  // Extend the event synchronously, as required by the service-worker lifecycle.
  // The response still resolves as soon as the network bytes are available;
  // only the verified content-addressed write remains in backgroundWork.
  event.waitUntil(responseWork.then(() => backgroundWork).catch(() => undefined));
});

// A Cache Storage marker survives worker replacement; this generation closes
// the smaller in-process race where an event read the old marker and then a
// logout/OFF message arrived while showNotification/subscribe/fetch was
// pending. Every state message invalidates old work synchronously. Resume stays
// locally suspended until the already-updated durable marker is revalidated.
let pushSessionGeneration = 0;
let pushSessionLocallySuspended = false;
let pushSessionFenceNonce = null;
let pushShadeCleanupTail = Promise.resolve();
let pushFencePersistenceTail = Promise.resolve();

function newWorkerPushFence() {
  try { return crypto.randomUUID(); } catch {
    const bytes = new Uint32Array(4);
    try {
      crypto.getRandomValues(bytes);
      return `worker-${Array.from(bytes, (part) => part.toString(16).padStart(8, '0')).join('')}`;
    } catch {
      // Uniqueness is sufficient for the compatibility fence; it is not a
      // secret. Never let a broken legacy crypto surface skip suspension.
      return `worker-${Date.now()}-${Math.random()}`;
    }
  }
}

function queuePushSuspensionFence(fenceNonce) {
  const result = pushFencePersistenceTail.then(async () => {
    const cache = await caches.open(PUSH_SESSION_CACHE);
    const markerUrl = new URL(PUSH_SESSION_SUSPENDED, self.location.origin).href;
    const previousMarker = await cache.match(markerUrl);
    const previousNonce = previousMarker ? await previousMarker.text() : null;
    if (previousNonce) {
      const previousAck = resumedFenceUrl(previousNonce);
      await cache.delete(previousAck);
      if (await cache.match(previousAck)) throw new Error('push acknowledgement survived suspension');
    }

    // Another message may have advanced the durable generation while the
    // exact old ACK was being removed. Never replace that newer nonce.
    const currentMarker = await cache.match(markerUrl);
    const currentNonce = currentMarker ? await currentMarker.text() : null;
    if (currentNonce !== previousNonce) {
      if (currentNonce !== fenceNonce) return false;
      const currentAck = resumedFenceUrl(currentNonce);
      await cache.delete(currentAck);
      if (await cache.match(currentAck)) throw new Error('push acknowledgement survived suspension');
      return cacheMarkerMatches(cache, fenceNonce);
    }

    await cache.put(
      markerUrl,
      new Response(fenceNonce, { headers: { 'cache-control': 'no-store' } }),
    );
    if (!await cacheMarkerMatches(cache, fenceNonce)) return false;
    if (await cache.match(resumedFenceUrl(fenceNonce))) return false;
    return cacheMarkerMatches(cache, fenceNonce);
  });
  pushFencePersistenceTail = result.catch(() => undefined);
  return result;
}

function queuePushShadeCleanup() {
  const result = pushShadeCleanupTail.then(closeAllPushNotifications, closeAllPushNotifications);
  pushShadeCleanupTail = result.catch(() => false);
  return result;
}

function resumedFenceUrl(fenceNonce) {
  const key = new URL(PUSH_SESSION_RESUMED, self.location.origin);
  key.searchParams.set('fence', fenceNonce);
  return key.href;
}

async function cacheMarkerMatches(cache, fenceNonce) {
  const marker = await cache.match(new URL(PUSH_SESSION_SUSPENDED, self.location.origin).href);
  return !!marker && await marker.text() === fenceNonce;
}

function localFenceMatches(generation, fenceNonce) {
  return generation === pushSessionGeneration
    && pushSessionLocallySuspended
    && (!pushSessionFenceNonce || pushSessionFenceNonce === fenceNonce);
}

async function commitPushSessionResume(fenceNonce, generation, cleanup, durableFence) {
  const [cleanupComplete] = await Promise.all([cleanup, durableFence]);
  if (!cleanupComplete || !localFenceMatches(generation, fenceNonce)) return false;
  const cache = await caches.open(PUSH_SESSION_CACHE);
  if (!await cacheMarkerMatches(cache, fenceNonce)
    || !localFenceMatches(generation, fenceNonce)) return false;

  // Snapshot before this generation writes its immutable acknowledgement.
  // A later generation's key cannot be in this set, so stale GC can never
  // delete a newer activation even if it resumes while deletion is pending.
  const resumedPath = new URL(PUSH_SESSION_RESUMED, self.location.origin).pathname;
  const currentAck = resumedFenceUrl(fenceNonce);
  const staleAcks = (await cache.keys()).filter((request) => {
    try {
      const candidate = new URL(request.url);
      return candidate.origin === self.location.origin
        && candidate.pathname === resumedPath
        && candidate.href !== currentAck;
    } catch { return false; }
  });
  if (!await cacheMarkerMatches(cache, fenceNonce)
    || !localFenceMatches(generation, fenceNonce)) return false;
  await Promise.all(staleAcks.map((request) => cache.delete(request)));
  if (!await cacheMarkerMatches(cache, fenceNonce)
    || !localFenceMatches(generation, fenceNonce)) return false;

  await cache.put(currentAck, new Response(fenceNonce, {
    headers: { 'cache-control': 'no-store' },
  }));
  const [markerStillCurrent, ack] = await Promise.all([
    cacheMarkerMatches(cache, fenceNonce), cache.match(currentAck),
  ]);
  if (!markerStillCurrent || !ack || await ack.text() !== fenceNonce
    || !localFenceMatches(generation, fenceNonce)) return false;
  pushSessionFenceNonce = fenceNonce;
  pushSessionLocallySuspended = false;
  return true;
}

/** Lets the page force an immediate takeover (the UPDATE NOW button). */
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') void self.skipWaiting();
  if (event.data?.type === PUSH_SESSION_SUSPENDED_MESSAGE
    || event.data?.type === PUSH_SESSION_RESUMED_MESSAGE) {
    const messageSuspends = event.data.type === PUSH_SESSION_SUSPENDED_MESSAGE;
    const suppliedFence = typeof event.data.fenceNonce === 'string' && event.data.fenceNonce
      ? event.data.fenceNonce : null;
    // Old open pages did not include a nonce. Give their suspension a unique
    // worker-owned generation so a later fixed-value resume cannot match it.
    const messageFence = suppliedFence || (messageSuspends ? newWorkerPushFence() : null);
    const generation = ++pushSessionGeneration;
    // Synchronous on purpose: an already-running push/rotation sees either a
    // changed generation or local suspension before it can cross this message.
    pushSessionLocallySuspended = true;
    if (messageSuspends && messageFence) pushSessionFenceNonce = messageFence;
    // Every activation performs its own cleanup. This is intentionally not
    // just a wait on an earlier promise: after a worker restart, memory cannot
    // prove whether the prior worker finished closing wallet A's shade.
    const shadeCleanup = queuePushShadeCleanup();
    const durableFence = messageSuspends && messageFence
      ? queuePushSuspensionFence(messageFence)
      : pushFencePersistenceTail;
    event.waitUntil((async () => {
      let active = false;
      try {
        if (messageSuspends) {
          await Promise.all([shadeCleanup, durableFence]);
          return;
        }
        if (!messageFence) return;
        active = await commitPushSessionResume(
          messageFence, generation, shadeCleanup, durableFence,
        );
      } catch { /* the durable push fence remains authoritative */ }
      finally {
        try {
          event.ports?.[0]?.postMessage({
            type: PUSH_SESSION_RESULT_MESSAGE, fenceNonce: messageFence, active,
          });
        } catch { /* the page times out and leaves delivery fenced */ }
      }
    })());
  }
  if (event.data?.type === 'asset-pack-inventory-flush' && event.data.build === BUILD) {
    // Snapshot, do not await future requests: all fetch handlers that resolved
    // before this message registered their write synchronously above.
    const pending = [...packObjectWrites];
    event.waitUntil(Promise.allSettled(pending).then(() => {
      event.ports?.[0]?.postMessage({ type: 'asset-pack-inventory-ready', build: BUILD });
    }));
  }
  if (event.data?.type === 'asset-pack-committed' && event.data.build === BUILD) {
    packIndexPromises.clear();
    event.ports?.[0]?.postMessage({ type: 'asset-pack-ready', build: event.data.build });
  }
});

// ---------------------------------------------------------------------------
// Web Push (D-101). The payload is server-authored JSON
// `{ kind, title, body, tag, url }`; every field is optional here because a
// push with no data (some services deliver a bare wake-up) must still show
// SOMETHING — a push subscription whose worker shows nothing gets revoked.
//
// The icon carries no `?v`: the platform fetches it while it paints the shade,
// possibly days after the deploy that queued this worker, and a build-bound
// icon URL from a superseded generation answers 503 (see
// isExplicitBuildBoundAsset). The bare path is plainly cacheable instead.
// ---------------------------------------------------------------------------
// Production is deliberately one origin (ARCHITECTURE §10): the worker must
// never send a session cookie to a configurable or payload-authored host.
const NOTIFICATIONS_API = '/api/notifications';
const PUSH_ICON = '/icons/icon-192.png';
const PUSH_DEFAULT_TITLE = 'Pixel Kingdom Wars';
const PUSH_SCREENS = new Set(['raidlog', 'mail', 'base', 'bases']);

async function readPushSessionState() {
  try {
    const cache = await caches.open(PUSH_SESSION_CACHE);
    const marker = await cache.match(new URL(PUSH_SESSION_SUSPENDED, self.location.origin).href);
    // Cache eviction/corruption is indistinguishable from an interrupted
    // logout. A foreground authenticated sync is the only path that may create
    // a marker and ask this worker to acknowledge it after shade cleanup.
    if (!marker) return { suspended: true, fenceNonce: null };
    const fenceNonce = await marker.text();
    if (!fenceNonce) return { suspended: true, fenceNonce: null };
    const resumedKey = new URL(PUSH_SESSION_RESUMED, self.location.origin);
    resumedKey.searchParams.set('fence', fenceNonce);
    const resumed = await cache.match(resumedKey.href);
    const resumedNonce = resumed ? await resumed.text() : null;
    return { suspended: resumedNonce !== fenceNonce, fenceNonce };
  } catch {
    // Fail closed. The next authenticated foreground boot clears the marker
    // state and performs the authoritative subscription sync.
    return { suspended: true, fenceNonce: null };
  }
}

async function pushSessionIsSuspended() {
  return (await readPushSessionState()).suspended;
}

/** Snapshot + durable check. The final local comparison is load-bearing: a
 * suspension message can arrive while Cache Storage is resolving. */
async function pushSessionIsCurrent(generation) {
  if (generation !== pushSessionGeneration || pushSessionLocallySuspended) return false;
  if (await pushSessionIsSuspended()) return false;
  return generation === pushSessionGeneration && !pushSessionLocallySuspended;
}

async function closeAllPushNotifications() {
  if (typeof self.registration.getNotifications !== 'function') return false;
  try {
    const notifications = await self.registration.getNotifications();
    let complete = true;
    for (const notification of notifications) {
      try { notification.close(); } catch { complete = false; }
    }
    return complete;
  } catch {
    // The fence stays suspended. Activation must never claim cleanup happened
    // when Android's shade could still hold prior-wallet content.
    return false;
  }
}

async function closePushGeneration(generation, tag) {
  if (typeof self.registration.getNotifications !== 'function') return;
  try {
    const notifications = await self.registration.getNotifications({ tag });
    for (const notification of notifications) {
      if (notification.data?.pushSessionGeneration !== generation) continue;
      try { notification.close(); } catch { /* continue closing the rest */ }
    }
  } catch { /* a later suspension message still performs the broad cleanup */ }
}

async function retireRotatedSubscription(subscription) {
  if (!subscription) return;
  let endpoint = typeof subscription.endpoint === 'string' ? subscription.endpoint : '';
  if (!endpoint) {
    try { endpoint = subscription.toJSON()?.endpoint || ''; } catch { endpoint = ''; }
  }
  try { await subscription.unsubscribe(); } catch { /* server retirement still runs */ }
  if (!endpoint) return;
  try {
    await fetch(`${NOTIFICATIONS_API}/subscribe`, {
      method: 'DELETE', cache: 'no-store', credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch { /* browser unsubscribe + the durable fence remain fail-closed */ }
}

async function pendingFenceIsCurrent(generation, fenceNonce) {
  if (!localFenceMatches(generation, fenceNonce)) return false;
  try {
    const cache = await caches.open(PUSH_SESSION_CACHE);
    if (!await cacheMarkerMatches(cache, fenceNonce)) return false;
    return localFenceMatches(generation, fenceNonce);
  } catch { return false; }
}

async function keepPendingFenceOrRetire(generation, fenceNonce, subscription) {
  if (await pendingFenceIsCurrent(generation, fenceNonce)) return true;
  await retireRotatedSubscription(subscription);
  return false;
}

function beginWorkerOwnershipFence(expectedGeneration, fenceNonce) {
  // Reading the prior durable state yields. A logout/OFF/resume message that
  // arrives in that gap owns the worker; never alter its newer marker. Reuse
  // the active generation's nonce and remove only its immutable ack. This
  // makes suspension monotonic: a cross-realm logout marker can never be
  // overwritten by a browser-generated rotation, even if worker messaging
  // failed and Cache Storage is the only surviving fence.
  if (expectedGeneration !== pushSessionGeneration || !fenceNonce) return null;
  const generation = expectedGeneration;
  pushSessionFenceNonce = fenceNonce;
  const cleanup = queuePushShadeCleanup();
  const durable = pushFencePersistenceTail.then(async () => {
    if (!localFenceMatches(generation, fenceNonce)) return false;
    const cache = await caches.open(PUSH_SESSION_CACHE);
    if (!await cacheMarkerMatches(cache, fenceNonce)
      || !localFenceMatches(generation, fenceNonce)) return false;
    await cache.delete(resumedFenceUrl(fenceNonce));
    if (!await cacheMarkerMatches(cache, fenceNonce)
      || !localFenceMatches(generation, fenceNonce)) return false;
    const ack = await cache.match(resumedFenceUrl(fenceNonce));
    return !ack && localFenceMatches(generation, fenceNonce);
  });
  pushFencePersistenceTail = durable.then(() => undefined, () => undefined);
  const ready = Promise.all([cleanup, durable]).then(
    ([cleanupComplete, durablySuspended]) => cleanupComplete
      && durablySuspended && pendingFenceIsCurrent(generation, fenceNonce),
    () => false,
  );
  return { fenceNonce, generation, ready, durable };
}

/** Canonicalise the only server-authored deep links. Validate both when
 * receiving and when clicking: an old notification may outlive the worker that
 * created it, and URL backslashes can otherwise turn an apparently relative
 * path into a different origin when `new URL()` normalises it. */
function safePushTarget(value) {
  try {
    const target = new URL(typeof value === 'string' && value ? value : '/', self.location.origin);
    if (target.origin !== self.location.origin || target.pathname !== '/') return { url: '/', screen: null };
    const screen = target.searchParams.get('screen');
    if (screen === null && target.search === '' && target.hash === '') return { url: '/', screen: null };
    if (!PUSH_SCREENS.has(screen)) return { url: '/', screen: null };
    return { url: `/?screen=${encodeURIComponent(screen)}`, screen };
  } catch {
    return { url: '/', screen: null };
  }
}

function readPushPayload(data) {
  let payload = null;
  try { payload = data ? data.json() : null; } catch { payload = null; }
  const text = (value) => (typeof value === 'string' && value ? value : null);
  const kind = text(payload?.kind) || 'generic';
  const target = safePushTarget(text(payload?.url));
  return {
    kind,
    title: text(payload?.title) || PUSH_DEFAULT_TITLE,
    body: text(payload?.body) || '',
    tag: text(payload?.tag) || `pkw-${kind}`,
    url: target.url,
  };
}

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    // Logout can be offline, so browser unsubscribe and server DELETE are both
    // best effort. The durable fence is the final privacy boundary: an old
    // endpoint may receive bytes, but it must never disclose wallet A's event
    // after the session has detached or the player switched notifications OFF.
    const generation = pushSessionGeneration;
    if (!await pushSessionIsCurrent(generation)) return;
    const payload = readPushPayload(event.data);
    // Revalidate immediately around the platform call. If suspension arrives
    // while showNotification is pending, the post-check removes only this old
    // generation; the synchronous message generation prevents the old event
    // from painting after the message's broad shade cleanup already ran.
    if (!await pushSessionIsCurrent(generation)) return;
    await self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: PUSH_ICON,
      badge: PUSH_ICON,
      tag: payload.tag,
      // A second raid while the first notification is still on the shade must
      // buzz again; a build/mail collapse into the same tag quietly.
      renotify: payload.kind === 'raided',
      data: { url: payload.url, kind: payload.kind, pushSessionGeneration: generation },
    });
    if (!await pushSessionIsCurrent(generation)) {
      await closePushGeneration(generation, payload.tag);
      return;
    }
    // A visible app still needs its MAIL badge to catch up. The page deliberately
    // handles this as a narrow mail refresh rather than reloading the whole base.
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .catch(() => []);
    if (!await pushSessionIsCurrent(generation)) {
      await closePushGeneration(generation, payload.tag);
      return;
    }
    for (const client of windows) client.postMessage({ type: 'notification-received', kind: payload.kind });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = safePushTarget(event.notification.data?.url);
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      // An open game keeps its state: focus it and let the page route, rather
      // than reloading a hydrated base through a fresh navigation.
      if (typeof existing.focus === 'function') await existing.focus().catch(() => undefined);
      if (target.screen) existing.postMessage({ type: 'open-screen', screen: target.screen });
      return;
    }
    await self.clients.openWindow(`${self.location.origin}${target.url}`);
  })().catch(() => undefined));
});

// The push service rotated or expired the subscription. Re-subscribe with the
// same VAPID key and tell the server which endpoint this replaces, so the old
// row retires instead of accumulating as a dead sender.
self.addEventListener('pushsubscriptionchange', (event) => {
  const previous = event.oldSubscription;
  // Fence this worker synchronously, then inspect the pre-existing durable
  // state before replacing it. A missing acknowledgement means explicit
  // logout/OFF (or an interrupted cleanup) and must never be overwritten by a
  // browser-generated rotation. The generation check below prevents this
  // yielded read from clobbering a newer page message.
  const probeGeneration = ++pushSessionGeneration;
  pushSessionLocallySuspended = true;
  event.waitUntil((async () => {
    let next = event.newSubscription;
    try {
      const priorState = await readPushSessionState();
      if (priorState.suspended || !priorState.fenceNonce
        || probeGeneration !== pushSessionGeneration) {
        await retireRotatedSubscription(next);
        return;
      }
      // The replacement endpoint has no proven wallet owner until the API
      // accepts it. Remove the currently active nonce's acknowledgement before
      // VAPID lookup, subscribe or POST; leave the marker itself monotonic.
      const ownership = beginWorkerOwnershipFence(probeGeneration, priorState.fenceNonce);
      if (!ownership) {
        await retireRotatedSubscription(next);
        return;
      }
      if (!await ownership.ready) {
        await retireRotatedSubscription(next);
        return;
      }
      if (!next) {
        let applicationServerKey = previous?.options?.applicationServerKey;
        // Some push services omit oldSubscription. Recover the public key from
        // the authenticated same-origin endpoint instead of silently losing the
        // device until its next foreground boot.
        if (!applicationServerKey) {
          const response = await fetch(`${NOTIFICATIONS_API}/vapid`, {
            cache: 'no-store', credentials: 'include',
          });
          if (!await keepPendingFenceOrRetire(
            ownership.generation, ownership.fenceNonce, next,
          )) return;
          if (!response.ok) return;
          const body = await response.json().catch(() => null);
          if (!await keepPendingFenceOrRetire(
            ownership.generation, ownership.fenceNonce, next,
          )) return;
          if (typeof body?.publicKey !== 'string' || !body.publicKey) return;
          const padded = body.publicKey + '='.repeat((4 - (body.publicKey.length % 4)) % 4);
          const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
          applicationServerKey = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        }
        if (!await keepPendingFenceOrRetire(
          ownership.generation, ownership.fenceNonce, next,
        )) return;
        next = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
        if (!await keepPendingFenceOrRetire(
          ownership.generation, ownership.fenceNonce, next,
        )) return;
      }
      const json = next.toJSON();
      if (typeof json.endpoint !== 'string' || !json.endpoint
        || typeof json.keys?.p256dh !== 'string' || !json.keys.p256dh
        || typeof json.keys?.auth !== 'string' || !json.keys.auth) {
        await retireRotatedSubscription(next);
        return;
      }
      if (!await keepPendingFenceOrRetire(
        ownership.generation, ownership.fenceNonce, next,
      )) return;
      const response = await fetch(`${NOTIFICATIONS_API}/subscribe`, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
          ...(previous?.endpoint && previous.endpoint !== json.endpoint
            ? { previousEndpoint: previous.endpoint } : {}),
          ...(self.navigator?.userAgent ? { userAgent: self.navigator.userAgent } : {}),
        }),
      });
      if (!await keepPendingFenceOrRetire(
        ownership.generation, ownership.fenceNonce, next,
      )) return;
      if (!response.ok) {
        // 409 can belong to another wallet, whose row current credentials are
        // unable to delete. The durable unacknowledged fence remains the real
        // privacy boundary even when unsubscribe returns false or rejects.
        await retireRotatedSubscription(next);
        return;
      }
      const activated = await commitPushSessionResume(
        ownership.fenceNonce,
        ownership.generation,
        queuePushShadeCleanup(),
        ownership.durable,
      );
      if (!activated) await retireRotatedSubscription(next);
    } catch {
      // A transport rejection can hide a committed POST. Delivery stays
      // durably fenced and the opaque browser capability is retired best-effort.
      await retireRotatedSubscription(next);
    }
  })());
});

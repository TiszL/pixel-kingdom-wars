import { BUILD } from '../../lib/version';

import type { GroundLoadReason, GroundProtocol } from '../../lib/events';
export interface GroundTransferProgress {
  completed: number; total: number; loadAttempt: number; loadReason: GroundLoadReason; loadProtocol: GroundProtocol;
}
export class GroundLoadError extends Error {
  constructor(readonly reason: GroundLoadReason) { super(`Realm artwork: ${reason}`); }
}

/** Visible time is consumed, never replenished by hiding the page. */
export class VisibleTimeout {
  private remaining: number;
  private armedAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private page = typeof document === 'undefined' ? undefined : document;
  private change = (): void => { this.pause(); this.arm(); };
  constructor(private limit: number, private expired: () => void) {
    this.remaining = limit;
    this.page?.addEventListener('visibilitychange', this.change);
    this.arm();
  }
  get elapsed(): number { return this.limit - this.remaining + (this.armedAt === undefined ? 0 : Math.max(0, performance.now() - this.armedAt)); }
  reset(): void { this.pause(); this.remaining = this.limit; this.arm(); }
  private pause(): void {
    clearTimeout(this.timer);
    if (this.armedAt !== undefined) this.remaining -= Math.max(0, performance.now() - this.armedAt);
    this.armedAt = undefined;
  }
  private arm(): void {
    if (this.page?.hidden) return;
    this.armedAt = performance.now();
    this.timer = setTimeout(this.expired, Math.max(0, this.remaining));
  }
  stop(): void { this.pause(); this.page?.removeEventListener('visibilitychange', this.change); }
}

// Current encoded sources are below 5 MiB. Bound hostile headers and streams
// independently of the decoded 18 MiB cache budget; never allocate from a header.
export const MAX_GROUND_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const strongEtag = (value: string | null): string | null => value && /^"[^"\r\n]+"$/.test(value) ? value : null;
const identity = (response: Response): boolean => !response.headers.get('content-encoding')
  || response.headers.get('content-encoding') === 'identity';

function protocolSince(url: string, started: number): GroundProtocol {
  try {
    const absolute = new URL(url, typeof location === 'undefined' ? 'http://localhost' : location.href).href;
    const entries = performance.getEntriesByName(absolute, 'resource') as PerformanceResourceTiming[];
    const protocol = entries.filter(entry => entry.startTime >= started).at(-1)?.nextHopProtocol;
    return protocol === 'h2' || protocol === 'h3' ? protocol : protocol === 'http/1.1' ? 'h1' : 'unknown';
  } catch { return 'unknown'; } // Resource timing can be absent, especially through a worker.
}

function retryDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cleanup = (): void => { timer.stop(); signal.removeEventListener('abort', abort); };
    const abort = (): void => { cleanup(); reject(signal.reason); };
    const timer = new VisibleTimeout(ms, () => { cleanup(); resolve(); });
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The shared lease owns the episode deadline. This loop alone owns automatic
 * attempts; prefixes are ephemeral and only resumed with a strong validator. */
export async function downloadGround(url: string, signal: AbortSignal,
  report: (progress: GroundTransferProgress) => void,
  options: { maxBytes?: number; cache?: 'default' | 'reload' } = {}): Promise<Uint8Array<ArrayBuffer>> {
  // Only trusted callers choose this ceiling; never derive it from HTTP input.
  // Globe detail PNGs are larger than base ground. Base callers retain 8 MiB.
  const maxBytes = options.maxBytes ?? MAX_GROUND_DOWNLOAD_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new GroundLoadError('size');
  let chunks: Uint8Array[] = [], received = 0, total = 0, validator: string | null = null;
  const clear = (): void => { chunks = []; received = 0; total = 0; validator = null; };
  let lastReason: GroundLoadReason = 'network';
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal.throwIfAborted();
    const request = new AbortController();
    const abort = (): void => request.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    const idle = new VisibleTimeout(20_000, () => request.abort(new GroundLoadError('idle-timeout')));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    let loadProtocol: GroundProtocol = 'unknown';
    const started = performance.now();
    const cancel = (): void => { void reader?.cancel().catch(() => {}); };
    request.signal.addEventListener('abort', cancel, { once: true });
    const publish = (loadReason: GroundLoadReason): void => report({ completed: received, total, loadAttempt: attempt, loadReason, loadProtocol });
    try {
      if (!validator) clear();
      const offset = received;
      const headers: Record<string, string> = { 'x-pkw-ground-stream': BUILD.gitSha };
      if (offset && validator) { headers.Range = `bytes=${offset}-`; headers['If-Range'] = validator; }
      publish(lastReason);
      const response = await fetch(url, { signal: request.signal, headers, redirect: 'error',
        ...(options.cache ? { cache: options.cache } : {}) });
      request.signal.throwIfAborted();
      const responseValidator = strongEtag(response.headers.get('etag'));
      let expectedResponseBytes: number | null = null;
      const length = response.headers.get('content-length');
      if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
        void response.body?.cancel().catch(() => {}); throw new GroundLoadError('size');
      }
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (!offset || !validator || responseValidator !== validator || !identity(response) || !range
          || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[3]) <= Number(range[2])
          || Number(range[3]) > maxBytes || (total && Number(range[3]) !== total)
          || response.headers.get('content-type')?.toLowerCase().startsWith('multipart/')) {
          void response.body?.cancel().catch(() => {}); clear(); throw new GroundLoadError('range');
        }
        total = Number(range[3]); expectedResponseBytes = Number(range[2]) - offset + 1;
        if (length !== null && Number(length) !== expectedResponseBytes) {
          void response.body?.cancel().catch(() => {}); clear(); throw new GroundLoadError('range');
        }
      } else if (response.status === 200) {
        // If-Range may legitimately return a new full representation. Never
        // append it to an old prefix, even if its validator appears unchanged.
        clear();
        if (identity(response)) {
          validator = responseValidator;
          total = length === null ? 0 : Number(length);
          expectedResponseBytes = length === null ? null : Number(length);
        }
      } else {
        void response.body?.cancel().catch(() => {});
        if (response.status === 416) clear();
        if (response.status !== 408 && response.status !== 429 && response.status < 500 && response.status !== 416) {
          throw new GroundLoadError('http');
        }
        throw new GroundLoadError('network');
      }
      if (!response.body) throw new GroundLoadError('network');
      // Accepted headers begin the body phase; a slow header response must not
      // leave its first byte with only the header phase's remaining allowance.
      idle.reset();
      reader = response.body.getReader();
      let responseBytes = 0;
      while (true) {
        const chunk = await reader.read();
        request.signal.throwIfAborted();
        if (chunk.done) break;
        if (!chunk.value.byteLength) continue;
        if (received + chunk.value.byteLength > maxBytes
          || (total > 0 && received + chunk.value.byteLength > total)
          || (expectedResponseBytes !== null && responseBytes + chunk.value.byteLength > expectedResponseBytes)) {
          clear(); throw new GroundLoadError('size');
        }
        chunks.push(chunk.value); received += chunk.value.byteLength; responseBytes += chunk.value.byteLength;
        idle.reset(); publish('complete');
      }
      if (!received || (expectedResponseBytes !== null && responseBytes !== expectedResponseBytes) || (total && received !== total)) {
        throw new GroundLoadError('network');
      }
      const bytes = new Uint8Array(received);
      let at = 0;
      for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
      chunks = []; total = received; loadProtocol = protocolSince(url, started); publish('complete'); complete = true;
      return bytes;
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const failure = request.signal.aborted ? request.signal.reason : error;
      lastReason = failure instanceof GroundLoadError ? failure.reason : 'network';
      loadProtocol = protocolSince(url, started);
      publish(lastReason);
      if (['size', 'http'].includes(lastReason) || attempt === 3) throw new GroundLoadError(lastReason);
      // Give transient connectivity a chance to recover. Backoff is cancellable
      // and consumes the same shared visible episode, never a fresh budget.
      idle.stop(); request.abort();
      await retryDelay(attempt * 1_000, signal);
    } finally {
      idle.stop(); cancel();
      // A completed200 may still be hashing in the worker's bounded cache
      // branch. Do not abort that verified offline-cache write on success.
      if (!complete) request.abort();
      signal.removeEventListener('abort', abort);
      request.signal.removeEventListener('abort', cancel);
    }
  }
  throw new GroundLoadError(lastReason);
}

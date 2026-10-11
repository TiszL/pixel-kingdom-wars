import { BUILD } from '../../lib/version';
import manifest from './art-manifest.json';
import { downloadGround, VisibleTimeout } from '../../game/world/groundDownload';

export interface FantasyPixels {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

// Match the base loader's finite visible episode, with useful-byte idle
// deadlines inside downloadGround and separate verification/decode bounds.
export const FANTASY_ART_TIMEOUT_MS = 120_000;
export const MAX_FANTASY_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const FANTASY_ART_PHASE_TIMEOUT_MS = 20_000;

const entries = new Map(manifest.files.map((file) => [file.path, file]));

/** Decode only bytes matching this client's approved generation. The normal
 * service-worker atlas cache remains shared, but can never supply mixed masks. */
export async function loadFantasyPixels(path: string, signal?: AbortSignal): Promise<FantasyPixels> {
  const controller = new AbortController();
  const deadline = new VisibleTimeout(FANTASY_ART_TIMEOUT_MS,
    () => controller.abort(new Error('Terrain preparation timed out')));
  let stageDeadline: VisibleTimeout | undefined;
  const phase = (stage: 'download' | 'verify' | 'decode'): void => {
    stageDeadline?.stop(); stageDeadline = undefined;
    if (stage !== 'download') stageDeadline = new VisibleTimeout(FANTASY_ART_PHASE_TIMEOUT_MS,
      () => controller.abort(new Error(`Terrain ${stage} timed out`)));
  };
  const abort = (): void => { controller.abort(signal?.reason); };
  let rejectAbort: (reason: unknown) => void;
  const interrupted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const interruptedByAbort = (): void => { rejectAbort(controller.signal.reason); };
  controller.signal.addEventListener('abort', interruptedByAbort, { once: true });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  try { return await Promise.race([decodeFantasyPixels(path, controller.signal, phase), interrupted]); }
  finally {
    deadline.stop(); stageDeadline?.stop();
    signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', interruptedByAbort);
  }
}

async function decodeFantasyPixels(path: string, signal: AbortSignal,
  phase: (stage: 'download' | 'verify' | 'decode') => void): Promise<FantasyPixels> {
  signal.throwIfAborted();
  const spec = entries.get(path);
  if (!spec) throw new Error(`Unknown fantasy terrain asset: ${path}`);
  const url = `/atlas/fantasy/globe/${path}?v=${encodeURIComponent(BUILD.gitSha)}`;
  let bytes: ArrayBuffer | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    phase('download');
    const next = await downloadGround(url, signal, () => {}, {
      maxBytes: MAX_FANTASY_DOWNLOAD_BYTES, cache: attempt === 0 ? 'default' : 'reload',
    });
    signal.throwIfAborted();
    phase('verify');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', next))]
      .map((value) => value.toString(16).padStart(2, '0')).join('');
    signal.throwIfAborted();
    if (hash === spec.sha256) { bytes = next.buffer; break; }
  }
  if (!bytes) throw new Error(`Terrain integrity check failed: ${path}`);
  signal.throwIfAborted();
  phase('decode');
  const image = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
  try {
    signal.throwIfAborted();
    if (image.width !== spec.width || image.height !== spec.height) {
      throw new Error(`Terrain dimensions changed: ${path}`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas terrain decoding unavailable');
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, image.width, image.height);
    canvas.width = canvas.height = 1;
    return { width: image.width, height: image.height, data: pixels.data };
  } finally { image.close(); }
}

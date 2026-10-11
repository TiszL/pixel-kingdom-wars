/** Private screenshot bytes only. Routes own reporter/admin authorization and
 * DB reservations/tombstones; this module never publishes an object URL. */
import { createHash, randomUUID } from 'node:crypto';
import { FEEDBACK_SCREENSHOTS as LIMIT } from '@shardkeep/shared/feedback';
import { AwsClient } from 'aws4fetch';
import sharp from 'sharp';

export class FeedbackImageError extends Error {}
export class FeedbackStorageBusyError extends Error {}
export interface FeedbackR2Config {
  accountId: string; bucket: string; accessKeyId: string; secretAccessKey: string;
}
export function feedbackR2ConfigFromEnv(env = process.env): FeedbackR2Config | null {
  const values = ['FEEDBACK_R2_ACCOUNT_ID', 'FEEDBACK_R2_BUCKET', 'FEEDBACK_R2_ACCESS_KEY_ID', 'FEEDBACK_R2_SECRET_ACCESS_KEY'].map((key) => env[key]);
  if (values.every((value) => !value)) return null;
  const [accountId, bucket, accessKeyId, secretAccessKey] = values;
  if (!accountId || !bucket || !accessKeyId || !secretAccessKey
    || !/^[a-f0-9]{32}$/.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)
    || bucket === env['R2_BUCKET']) throw new Error('Private feedback R2 configuration is incomplete or unsafe');
  return { accountId, bucket, accessKeyId, secretAccessKey };
}
const KEY = /^feedback\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{64}\.webp$/;
export function assertFeedbackObjectKey(key: string): string {
  if (!KEY.test(key)) throw new Error('Invalid private screenshot object key');
  return key;
}
export function feedbackObjectKey(hash: string, generation = randomUUID()): string {
  return assertFeedbackObjectKey(`feedback/${generation}/${hash}.webp`);
}
const counts = { raw: 0, normalize: 0, read: 0, mutate: 0 };
type Permit = keyof typeof counts;
const caps = { raw: LIMIT.maxConcurrentRawUploads, normalize: LIMIT.maxConcurrentNormalizations,
  read: LIMIT.maxConcurrentReads, mutate: LIMIT.maxConcurrentMutations };
/** Route acquires raw permit AFTER authentication but BEFORE body parsing;
 * release from response/error/abort is idempotent. No unbounded wait queue. */
export function acquireFeedbackPermit(kind: Permit): () => void {
  if (counts[kind] >= caps[kind]) throw new FeedbackStorageBusyError('Private screenshot processing is busy; try again');
  counts[kind]++;
  let released = false;
  return () => { if (!released) { released = true; counts[kind]--; } };
}
export interface NormalizedFeedbackScreenshot {
  bytes: Buffer; sha256: string; width: number; height: number; contentType: 'image/webp';
}
export async function normalizeFeedbackScreenshot(input: Buffer, contentType: string): Promise<NormalizedFeedbackScreenshot> {
  const expected = ({ 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' } as Record<string, string>)[contentType.toLowerCase()];
  if (!expected || !input.length || input.length > LIMIT.maxUploadBytes) throw new FeedbackImageError('Screenshot must be a nonempty PNG, JPEG or WebP within the upload limit');
  const release = acquireFeedbackPermit('normalize');
  try {
    const options = { animated: true, failOn: 'warning' as const, limitInputPixels: LIMIT.maxDecodedPixels };
    const meta = await sharp(input, options).metadata();
    if (meta.format !== expected || (meta.pages ?? 1) !== 1 || !meta.width || !meta.height
      || meta.width > LIMIT.maxInputEdge || meta.height > LIMIT.maxInputEdge
      || meta.width * meta.height > LIMIT.maxDecodedPixels) throw new FeedbackImageError('Screenshot type, dimensions or animation is not supported');
    const output = await sharp(input, { ...options, animated: false }).rotate()
      .resize(LIMIT.maxOutputEdge, LIMIT.maxOutputEdge, { fit: 'inside', withoutEnlargement: true })
      .toColourspace('srgb').webp({ lossless: true, effort: LIMIT.webpEffort }).toBuffer({ resolveWithObject: true });
    if (output.data.length > LIMIT.maxNormalizedBytes) throw new FeedbackImageError('Normalized screenshot exceeds the storage limit');
    return { bytes: output.data, sha256: createHash('sha256').update(output.data).digest('hex'),
      width: output.info.width, height: output.info.height, contentType: 'image/webp' };
  } catch (error) {
    if (error instanceof FeedbackImageError) throw error;
    throw new FeedbackImageError('Screenshot could not be decoded safely');
  } finally { release(); }
}
async function boundedRead(response: Response): Promise<Buffer | null> {
  if (response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') {
    await response.body?.cancel(); throw new Error('Private screenshot storage read failed');
  }
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/.test(length) || Number(length) > LIMIT.maxNormalizedBytes)) {
    await response.body?.cancel(); throw new Error('Private screenshot storage body exceeds limit');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Private screenshot storage returned no body');
  const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length;
      if (size > LIMIT.maxNormalizedBytes) throw new Error('Private screenshot storage body exceeds limit');
      chunks.push(Buffer.from(next.value));
    }
    if (!size || (length && size !== Number(length))) throw new Error('Private screenshot storage returned an incomplete body');
    return Buffer.concat(chunks, size);
  } finally { await reader.cancel().catch(() => undefined); }
}
/** Signal plus a promise deadline: even a transport ignoring abort cannot hold
 * the request open. DB callers must reconcile an ambiguous PUT by this same key. */
async function operation<T>(kind: 'read' | 'mutate', parent: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const release = acquireFeedbackPermit(kind); const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined; let abort: (() => void) | undefined;
  const pending = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return work(controller.signal); }).finally(release);
  try {
    return await Promise.race([new Promise<never>((_, reject) => {
      abort = () => { controller.abort(); reject(new Error('Private screenshot storage request aborted')); };
      parent?.addEventListener('abort', abort, { once: true });
      if (parent?.aborted) abort();
      timer = setTimeout(() => { controller.abort(); reject(new Error('Private screenshot storage request timed out')); }, LIMIT.storageTimeoutMs);
    }), pending]);
  } finally { clearTimeout(timer); if (abort) parent?.removeEventListener('abort', abort); }
}
export interface FeedbackScreenshotStorage {
  put(key: string, image: NormalizedFeedbackScreenshot, signal?: AbortSignal): Promise<'created' | 'exists'>;
  read(key: string, signal?: AbortSignal): Promise<Buffer | null>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
export function makeFeedbackScreenshotStorage(config: FeedbackR2Config): FeedbackScreenshotStorage {
  // Config passed directly by callers receives the same path validation as env.
  feedbackR2ConfigFromEnv({ FEEDBACK_R2_ACCOUNT_ID: config.accountId, FEEDBACK_R2_BUCKET: config.bucket,
    FEEDBACK_R2_ACCESS_KEY_ID: config.accessKeyId, FEEDBACK_R2_SECRET_ACCESS_KEY: config.secretAccessKey, R2_BUCKET: process.env['R2_BUCKET'] });
  const aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  const url = (key: string): string => `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${assertFeedbackObjectKey(key)}`;
  return {
    put: async (key, image, signal) => {
      const target = url(key);
      if (!image.bytes.length || image.bytes.length > LIMIT.maxNormalizedBytes
        || createHash('sha256').update(image.bytes).digest('hex') !== image.sha256
        || !key.endsWith(`/${image.sha256}.webp`)) throw new FeedbackImageError('Screenshot hash or size is invalid');
      return operation('mutate', signal, async (abortSignal) => {
        const response = await aws.fetch(target, { method: 'PUT', signal: abortSignal,
          headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store', 'if-none-match': '*' }, body: image.bytes });
        await response.body?.cancel();
        if (response.status === 412) return 'exists'; // never replace immutable bytes
        if (!response.ok) throw new Error('Private screenshot storage write failed');
        return 'created';
      });
    },
    read: (key, signal) => { const target = url(key); return operation('read', signal, async (abortSignal) => {
      const bytes = await boundedRead(await aws.fetch(target, { method: 'GET', signal: abortSignal, headers: { 'cache-control': 'no-store' } }));
      if (bytes && createHash('sha256').update(bytes).digest('hex') !== key.split('/')[2]!.slice(0, -5)) throw new Error('Private screenshot storage hash mismatch');
      return bytes;
    }); },
    delete: (key, signal) => { const target = url(key); return operation('mutate', signal, async (abortSignal) => {
      const response = await aws.fetch(target, { method: 'DELETE', signal: abortSignal }); await response.body?.cancel();
      if (!response.ok && response.status !== 404) throw new Error('Private screenshot storage deletion failed');
    }); },
  };
}

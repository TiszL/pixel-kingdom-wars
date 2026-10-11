import { createHash } from 'node:crypto';
import { FEEDBACK_SCREENSHOTS as LIMIT } from '@shardkeep/shared/feedback';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  acquireFeedbackPermit, assertFeedbackObjectKey, feedbackObjectKey,
  feedbackR2ConfigFromEnv, makeFeedbackScreenshotStorage, normalizeFeedbackScreenshot,
  type NormalizedFeedbackScreenshot,
} from '../src/game/feedbackStorage';

const { fetchObject } = vi.hoisted(() => ({ fetchObject: vi.fn() }));
vi.mock('aws4fetch', () => ({ AwsClient: class { fetch = fetchObject; } }));
const config = { accountId: 'a'.repeat(32), bucket: 'private-feedback', accessKeyId: 'test-only', secretAccessKey: 'test-only' };
const env = { FEEDBACK_R2_ACCOUNT_ID: config.accountId, FEEDBACK_R2_BUCKET: config.bucket,
  FEEDBACK_R2_ACCESS_KEY_ID: config.accessKeyId, FEEDBACK_R2_SECRET_ACCESS_KEY: config.secretAccessKey };
const bytes = Buffer.from('normalized-test-storage-bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
const key = feedbackObjectKey(hash);
const image: NormalizedFeedbackScreenshot = { bytes, sha256: hash, width: 1, height: 1, contentType: 'image/webp' };
beforeEach(() => { fetchObject.mockReset(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe('private screenshot boundary', () => {
  it('fails closed on partial configuration and public bucket reuse', () => {
    expect(feedbackR2ConfigFromEnv({})).toBeNull();
    expect(feedbackR2ConfigFromEnv(env)).toEqual(config);
    for (const bad of [{ ...env, FEEDBACK_R2_SECRET_ACCESS_KEY: '' }, { ...env, R2_BUCKET: config.bucket },
      { ...env, FEEDBACK_R2_ACCOUNT_ID: '../escape' }, { ...env, FEEDBACK_R2_BUCKET: 'private/path' }]) {
      expect(() => feedbackR2ConfigFromEnv(bad)).toThrow('incomplete or unsafe');
    }
    vi.stubEnv('R2_BUCKET', config.bucket);
    expect(() => makeFeedbackScreenshotStorage(config)).toThrow('incomplete or unsafe');
  });
  it('uses opaque generations and cannot address public assets or traverse keys', () => {
    expect(assertFeedbackObjectKey(key)).toBe(key);
    expect(feedbackObjectKey(hash)).not.toBe(key);
    for (const bad of ['../public.png', key + '?public=1', key.replace('feedback/', 'avatar/'),
      key.replace('feedback/', 'feedback/%2f'), key.toUpperCase(), key.replace(hash, 'wallet')]) {
      expect(() => assertFeedbackObjectKey(bad)).toThrow();
    }
  });
  it('bounds uploads before body buffering and makes permit release idempotent', () => {
    const releases = Array.from({ length: LIMIT.maxConcurrentRawUploads }, () => acquireFeedbackPermit('raw'));
    expect(() => acquireFeedbackPermit('raw')).toThrow('busy');
    releases.forEach((release) => { release(); release(); });
    acquireFeedbackPermit('raw')();
  });
  it.each(['png', 'jpeg', 'webp'] as const)('normalizes %s without metadata or aspect-ratio cropping', async (format) => {
    const input = await sharp({ create: { width: 320, height: 180, channels: 3, background: 'red' } })
      .withExif({ IFD0: { Artist: 'private-location-data' } }).toFormat(format).toBuffer();
    const result = await normalizeFeedbackScreenshot(input, `image/${format}`);
    const meta = await sharp(result.bytes).metadata();
    expect([result.width, result.height, meta.format, meta.exif]).toEqual([320, 180, 'webp', undefined]);
    expect(result.sha256).toBe(createHash('sha256').update(result.bytes).digest('hex'));
  });
  it('applies orientation before resizing and strips orientation metadata', async () => {
    const input = await sharp({ create: { width: 600, height: 300, channels: 3, background: 'red' } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await normalizeFeedbackScreenshot(input, 'image/jpeg');
    expect([result.width, result.height, (await sharp(result.bytes).metadata()).orientation]).toEqual([300, 600, undefined]);
  });
  it('rejects corrupt, mismatched, oversized and excessively decoded screenshots', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
    for (const [input, mime] of [[Buffer.alloc(0), 'image/png'], [Buffer.from('bad'), 'image/png'],
      [png, 'image/jpeg'], [png, 'image/svg+xml'], [png.subarray(0, 24), 'image/png'],
      [Buffer.alloc(LIMIT.maxUploadBytes + 1), 'image/png']] as const) {
      await expect(normalizeFeedbackScreenshot(input, mime)).rejects.toThrow();
    }
    const large = await sharp({ create: { width: 5000, height: 5000, channels: 3, background: 'red' } }).png().toBuffer();
    await expect(normalizeFeedbackScreenshot(large, 'image/png')).rejects.toThrow();
  });
});

describe('private R2 operations', () => {
  it('writes immutable, no-store objects and exposes no public URL', async () => {
    const storage = makeFeedbackScreenshotStorage(config);
    fetchObject.mockResolvedValue(new Response(null, { status: 200 }));
    expect(await storage.put(key, image)).toBe('created');
    expect(fetchObject.mock.calls[0]).toEqual([expect.stringContaining(`/private-feedback/${key}`), expect.objectContaining({
      method: 'PUT', headers: { 'content-type': 'image/webp', 'cache-control': 'private, no-store', 'if-none-match': '*' },
    })]);
    expect(storage).not.toHaveProperty('publicBaseUrl');
    fetchObject.mockResolvedValue(new Response(null, { status: 412 }));
    expect(await storage.put(key, image)).toBe('exists');
    await expect(storage.put(key, { ...image, bytes: Buffer.from('changed') })).rejects.toThrow('hash or size');
    expect(fetchObject).toHaveBeenCalledTimes(2);
  });
  it('reads only bounded hash-matching bytes without reusable caching', async () => {
    fetchObject.mockResolvedValue(new Response(bytes, { headers: { 'content-type': 'image/webp', 'content-length': String(bytes.length) } }));
    expect(await makeFeedbackScreenshotStorage(config).read(key)).toEqual(bytes);
    expect(fetchObject.mock.calls[0]?.[1].headers).toEqual({ 'cache-control': 'no-store' });
  });
  it('rejects empty, truncated, oversized, wrong-type and wrong-hash objects', async () => {
    const storage = makeFeedbackScreenshotStorage(config);
    for (const response of [new Response(null, { headers: { 'content-type': 'image/webp' } }),
      new Response(bytes, { headers: { 'content-type': 'image/png' } }),
      new Response(bytes, { headers: { 'content-type': 'image/webp', 'content-length': String(bytes.length + 1) } }),
      new Response(bytes, { headers: { 'content-type': 'image/webp', 'content-length': String(LIMIT.maxNormalizedBytes + 1) } }),
      new Response(Buffer.from('changed'), { headers: { 'content-type': 'image/webp' } }),
      new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(LIMIT.maxNormalizedBytes + 1)); c.close(); } }), { headers: { 'content-type': 'image/webp' } })]) {
      fetchObject.mockResolvedValueOnce(response);
      await expect(storage.read(key)).rejects.toThrow();
    }
  });
  it('makes missing reads/deletions recoverable without leaking upstream error bodies', async () => {
    const storage = makeFeedbackScreenshotStorage(config);
    fetchObject.mockImplementation(() => Promise.resolve(new Response('internal-provider-detail', { status: 404 })));
    expect(await storage.read(key)).toBeNull();
    await storage.delete(key);
    fetchObject.mockResolvedValue(new Response('internal-provider-detail', { status: 503 }));
    await expect(storage.delete(key)).rejects.toThrow('Private screenshot storage deletion failed');
  });
  it('deadlines uncooperative transport while retaining its physical resource permit', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: Response) => void> = [];
    fetchObject.mockImplementation(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    const storage = makeFeedbackScreenshotStorage(config);
    const pending = Array.from({ length: LIMIT.maxConcurrentMutations }, () => storage.put(key, image));
    const assertions = pending.map((p) => expect(p).rejects.toThrow('timed out'));
    await vi.advanceTimersByTimeAsync(LIMIT.storageTimeoutMs);
    await Promise.all(assertions);
    await expect(storage.put(key, image)).rejects.toThrow('busy');
    resolvers.forEach((resolve) => resolve(new Response(null)));
    await vi.advanceTimersByTimeAsync(0);
    fetchObject.mockResolvedValue(new Response(null));
    expect(await storage.put(key, image)).toBe('created');
  });
  it('does not send pre-aborted work', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(makeFeedbackScreenshotStorage(config).put(key, image, controller.signal)).rejects.toThrow('aborted');
    expect(fetchObject).not.toHaveBeenCalled();
  });
});

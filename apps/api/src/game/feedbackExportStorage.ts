/** Server-generated files only. No credentials/URLs enter export DTOs. A lost
 * PUT remains ambiguous: callers retain immutable reservations and tombstones. */
import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { feedbackR2ConfigFromEnv, type FeedbackR2Config } from './feedbackStorage';

const MIME = { txt: 'text/plain; charset=utf-8', json: 'application/json; charset=utf-8', zip: 'application/zip' } as const;
export type FeedbackExportContentType = typeof MIME[keyof typeof MIME];
const KEY = /^exports\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/([0-9a-f]{64})\.(txt|json|zip)$/;
function keyInfo(key: string) {
  const match = KEY.exec(key);
  if (!match) throw new Error('Invalid private export object key');
  return { sha256: match[1]!, contentType: MIME[match[2]! as keyof typeof MIME] };
}
export function feedbackExportObjectKey(jobId: string, sha256: string, extension: keyof typeof MIME) {
  const key = `exports/${jobId}/${sha256}.${extension}`; keyInfo(key); return key;
}
const counts = { read: 0, mutate: 0 };
function lease(kind: keyof typeof counts, parent?: AbortSignal) {
  const cap = kind === 'read' ? LIMIT.maxConcurrentReads : LIMIT.maxConcurrentMutations;
  if (counts[kind] >= cap) throw new Error('Private export storage is busy');
  counts[kind]++;
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('Private export storage request aborted'));
  let fail!: (error: Error) => void;
  const deadline = new Promise<never>((_, reject) => { fail = reject; });
  // This promise can reject after headers were returned, with no pull pending.
  void deadline.catch(() => undefined);
  controller.signal.addEventListener('abort', () => fail(controller.signal.reason as Error), { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Private export storage request timed out')), LIMIT.storageTimeoutMs);
  parent?.addEventListener('abort', stop, { once: true });
  if (parent?.aborted) stop();
  let ended = false;
  return { signal: controller.signal, guard: <T>(pending: Promise<T>) => Promise.race([pending, deadline]),
    finish() { if (!ended) { ended = true; counts[kind]--; clearTimeout(timer); parent?.removeEventListener('abort', stop); } },
  };
}
export interface FeedbackExportRead {
  body: ReadableStream<Uint8Array>; byteLength: number; contentType: FeedbackExportContentType; sha256: string;
}
export interface FeedbackExportStorage {
  putFile(key: string, absolutePath: string, expectedSha256: string, contentType: FeedbackExportContentType, signal?: AbortSignal): Promise<'created' | 'exists'>;
  read(key: string, signal?: AbortSignal): Promise<FeedbackExportRead | null>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
export function makeFeedbackExportStorage(config: FeedbackR2Config): FeedbackExportStorage {
  feedbackR2ConfigFromEnv({ FEEDBACK_R2_ACCOUNT_ID: config.accountId, FEEDBACK_R2_BUCKET: config.bucket,
    FEEDBACK_R2_ACCESS_KEY_ID: config.accessKeyId, FEEDBACK_R2_SECRET_ACCESS_KEY: config.secretAccessKey, R2_BUCKET: process.env['R2_BUCKET'] });
  const aws = new AwsClient({ accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey, service: 's3', region: 'auto', retries: 0 });
  const url = (key: string) => { keyInfo(key); return `https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`; };
  async function mutate<T>(signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>) {
    const slot = lease('mutate', signal);
    const pending = Promise.resolve().then(async () => {
      slot.signal.throwIfAborted();
      try { return await work(slot.signal); }
      catch { throw new Error('Private export storage mutation failed'); }
    }).finally(() => slot.finish());
    return slot.guard(pending);
  }
  return {
    async putFile(key, absolutePath, expectedSha256, contentType, signal) {
      const target = url(key), info = keyInfo(key);
      if (!isAbsolute(absolutePath) || expectedSha256 !== info.sha256 || contentType !== info.contentType) throw new Error('Invalid private export file metadata');
      return mutate(signal, async abort => {
        const stat = await lstat(absolutePath);
        if (!stat.isFile() || stat.size <= 0 || stat.size > LIMIT.maxBytes) throw new Error('Private export file exceeds bounds');
        // File-backed Blob checks for changes during reads. No whole-archive
        // buffer: aws4fetch accepts Blob unchanged when given the payload SHA.
        const body = await openAsBlob(absolutePath, { type: contentType });
        if (body.size !== stat.size) throw new Error('Private export file changed');
        abort.throwIfAborted();
        const response = await aws.fetch(target, { method: 'PUT', signal: abort, body,
          headers: { 'content-type': contentType, 'content-length': String(body.size), 'cache-control': 'private, no-store',
            'if-none-match': '*', 'x-amz-content-sha256': expectedSha256, 'x-amz-meta-sha256': expectedSha256 } });
        await response.body?.cancel();
        if (response.status === 412) return 'exists';
        if (!response.ok) throw new Error('Private export storage write failed');
        return 'created';
      });
    },
    async read(key, signal) {
      const target = url(key), info = keyInfo(key), slot = lease('read', signal);
      const pending = Promise.resolve().then(async () => {
        slot.signal.throwIfAborted();
        const response = await aws.fetch(target, { method: 'GET', signal: slot.signal, headers: { 'cache-control': 'no-store', 'accept-encoding': 'identity' } });
        try {
          slot.signal.throwIfAborted();
          if (response.status === 404) { await response.body?.cancel(); slot.finish(); return null; }
          const length = response.headers.get('content-length');
          if (!response.ok || !response.body || !length || !/^[1-9]\d*$/.test(length) || Number(length) > LIMIT.maxBytes
            || response.headers.get('content-type') !== info.contentType || response.headers.get('x-amz-meta-sha256') !== info.sha256
            || response.headers.has('content-encoding')) throw new Error('Private export storage metadata invalid');
          const reader = response.body.getReader(), hash = createHash('sha256'); let size = 0, ended = false;
          let pendingChunk: Uint8Array | null = null;
          let streamController: ReadableStreamDefaultController<Uint8Array>;
          const finish = async () => {
            if (ended) return; ended = true; pendingChunk = null;
            slot.signal.removeEventListener('abort', aborted);
            try { await reader.cancel(); }
            catch { throw new Error('Private export storage cancellation failed'); }
            finally { slot.finish(); }
          };
          const aborted = () => { if (!ended) { streamController.error(slot.signal.reason); void finish().catch(() => undefined); } };
          const body = new ReadableStream<Uint8Array>({
            start(controller) { streamController = controller; slot.signal.addEventListener('abort', aborted, { once: true }); },
            async pull(controller) {
              try {
                // Keep one chunk back until the next read. In particular the
                // final bytes cannot satisfy HTTP Content-Length before EOF
                // verifies the complete hash; corrupt downloads end short.
                for (;;) {
                  const chunk = await slot.guard(reader.read());
                  if (ended) return;
                  if (chunk.done) {
                    if (size !== Number(length) || hash.digest('hex') !== info.sha256) throw new Error('Private export storage body verification failed');
                    if (pendingChunk) controller.enqueue(pendingChunk);
                    pendingChunk = null; controller.close(); await finish(); return;
                  }
                  size += chunk.value.byteLength;
                  if (size > Number(length) || size > LIMIT.maxBytes) throw new Error('Private export storage body exceeds bounds');
                  hash.update(chunk.value);
                  const previous = pendingChunk; pendingChunk = chunk.value;
                  if (previous) { controller.enqueue(previous); return; }
                }
              } catch { if (!ended) controller.error(new Error('Private export storage body verification failed')); await finish(); }
            },
            cancel: finish,
          }, { highWaterMark: 0 });
          return { body, byteLength: Number(length), ...info };
        } catch (error) { await response.body?.cancel(); throw error; }
      }).catch(() => { slot.finish(); throw new Error('Private export storage read failed'); });
      return slot.guard(pending);
    },
    async delete(key, signal) {
      const target = url(key);
      return mutate(signal, async abort => {
        const response = await aws.fetch(target, { method: 'DELETE', signal: abort });
        await response.body?.cancel();
        if (!response.ok && response.status !== 404) throw new Error('Private export storage deletion failed');
      });
    },
  };
}

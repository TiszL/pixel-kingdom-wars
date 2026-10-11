import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { feedbackExportObjectKey, makeFeedbackExportStorage } from '../src/game/feedbackExportStorage';

const { fetchObject } = vi.hoisted(() => ({ fetchObject: vi.fn() }));
vi.mock('aws4fetch', () => ({ AwsClient: class { fetch = fetchObject; } }));
const config = { accountId: 'a'.repeat(32), bucket: 'private-feedback', accessKeyId: 'test-only', secretAccessKey: 'test-only' };
const bytes = Buffer.from('private generated export');
const hash = createHash('sha256').update(bytes).digest('hex');
const key = feedbackExportObjectKey(randomUUID(), hash, 'txt'), contentType = 'text/plain; charset=utf-8';
const storage = makeFeedbackExportStorage(config);
let dir: string, file: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'feedback-export-test-')); file = join(dir, 'export.txt'); await writeFile(file, bytes); });
beforeEach(() => { fetchObject.mockReset(); });
afterEach(() => { vi.useRealTimers(); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
function response(body: ConstructorParameters<typeof Response>[0] = bytes, headers: Record<string, string> = {}) {
  return new Response(body, { headers: { 'content-type': contentType, 'content-length': String(bytes.length), 'x-amz-meta-sha256': hash, ...headers } });
}
async function readBody() { const item = await storage.read(key); return new Response(item!.body).arrayBuffer(); }
it('sends a file-backed immutable PUT with an explicit signed payload hash and no public URL', async () => {
  fetchObject.mockResolvedValueOnce(new Response(null));
  expect(await storage.putFile(key, file, hash, contentType)).toBe('created');
  const [url, init] = fetchObject.mock.calls[0]!;
  expect(url).toBe(`https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${key}`);
  expect(init.body).toBeInstanceOf(Blob); expect(Buffer.from(await init.body.arrayBuffer())).toEqual(bytes);
  expect(init.headers).toEqual({ 'content-type': contentType, 'content-length': String(bytes.length),
    'cache-control': 'private, no-store', 'if-none-match': '*', 'x-amz-content-sha256': hash, 'x-amz-meta-sha256': hash });
  expect(storage).not.toHaveProperty('publicBaseUrl');
  fetchObject.mockResolvedValueOnce(new Response(null, { status: 412 }));
  expect(await storage.putFile(key, file, hash, contentType)).toBe('exists');
});
it('rejects traversal, wrong hash/type, relative paths, symlinks, empty and oversized files before network', async () => {
  for (const bad of [key + '?public=1', key.replace('exports/', 'feedback/'), key.replace('/' + hash, '/../' + hash), key.toUpperCase()]) {
    await expect(storage.putFile(bad, file, hash, contentType)).rejects.toThrow();
    await expect(storage.read(bad)).rejects.toThrow(); await expect(storage.delete(bad)).rejects.toThrow();
  }
  await expect(storage.putFile(key, file, 'b'.repeat(64), contentType)).rejects.toThrow();
  await expect(storage.putFile(key, file, hash, 'application/zip')).rejects.toThrow();
  await expect(storage.putFile(key, 'relative.txt', hash, contentType)).rejects.toThrow();
  const link = join(dir, 'symlink.txt'); await symlink(file, link);
  await expect(storage.putFile(key, link, hash, contentType)).rejects.toThrow();
  const large = join(dir, 'large'); await writeFile(large, '');
  await expect(storage.putFile(key, large, hash, contentType)).rejects.toThrow();
  await truncate(large, LIMIT.maxBytes + 1);
  await expect(storage.putFile(key, large, hash, contentType)).rejects.toThrow();
  expect(fetchObject).not.toHaveBeenCalled();
});
it('returns authenticated-route stream metadata and verifies bytes while consuming', async () => {
  fetchObject.mockResolvedValueOnce(response());
  const item = await storage.read(key);
  expect(item).toMatchObject({ byteLength: bytes.length, sha256: hash, contentType });
  expect(Buffer.from(await new Response(item!.body).arrayBuffer())).toEqual(bytes);
  expect(fetchObject.mock.calls[0]![1].headers).toEqual({ 'cache-control': 'no-store', 'accept-encoding': 'identity' });
});
it('rejects invalid metadata and corrupt/truncated/oversized stream bodies', async () => {
  for (const headers of [{ 'content-length': '0' }, { 'content-length': String(LIMIT.maxBytes + 1) },
    { 'content-length': 'wrong' }, { 'content-type': 'text/html' }, { 'x-amz-meta-sha256': 'b'.repeat(64) }, { 'content-encoding': 'gzip' }]) {
    fetchObject.mockResolvedValueOnce(response(bytes, headers)); await expect(storage.read(key)).rejects.toThrow();
  }
  for (const body of [Buffer.from('wrong'), Buffer.alloc(bytes.length), Buffer.alloc(bytes.length + 1)]) {
    fetchObject.mockResolvedValueOnce(response(body)); await expect(readBody()).rejects.toThrow('verification failed');
  }
});
it('keeps disappeared exports recoverable and provider failures sanitized', async () => {
  fetchObject.mockResolvedValueOnce(new Response('provider secret', { status: 404 })); expect(await storage.read(key)).toBeNull();
  fetchObject.mockResolvedValueOnce(new Response('provider secret', { status: 404 })); await storage.delete(key);
  fetchObject.mockResolvedValueOnce(new Response('provider secret', { status: 503 })); await expect(storage.delete(key)).rejects.toThrow('mutation failed');
  fetchObject.mockRejectedValueOnce(new Error('https://private-account/secret-key')); await expect(storage.delete(key)).rejects.toThrow('Private export storage mutation failed');
});
it('times out late PUTs while retaining their permits until the physical transport settles', async () => {
  vi.useFakeTimers(); const resolves: Array<(r: Response) => void> = [];
  fetchObject.mockImplementation(() => new Promise<Response>(resolve => resolves.push(resolve)));
  const pending = Array.from({ length: LIMIT.maxConcurrentMutations }, () => storage.putFile(key, file, hash, contentType));
  const assertions = pending.map(p => expect(p).rejects.toThrow('timed out'));
  // File-backed blob setup uses real filesystem I/O, so await arrival at fetch.
  await vi.waitFor(() => expect(resolves).toHaveLength(LIMIT.maxConcurrentMutations));
  await vi.advanceTimersByTimeAsync(LIMIT.storageTimeoutMs); await Promise.all(assertions);
  await expect(storage.delete(key)).rejects.toThrow('busy');
  resolves.forEach(resolve => resolve(new Response(null))); await vi.advanceTimersByTimeAsync(0);
  fetchObject.mockResolvedValueOnce(new Response(null)); await storage.delete(key);
});
it('retains download permits until cancellation and deadlines an unconsumed body', async () => {
  vi.useFakeTimers();
  fetchObject.mockImplementation(() => Promise.resolve(response(new ReadableStream({ pull() {} }))));
  const pending = await Promise.all(Array.from({ length: LIMIT.maxConcurrentReads }, () => storage.read(key)));
  await expect(storage.read(key)).rejects.toThrow('busy');
  const assertions = pending.map(item => expect(new Response(item!.body).arrayBuffer()).rejects.toThrow('timed out'));
  await vi.advanceTimersByTimeAsync(LIMIT.storageTimeoutMs); await Promise.all(assertions);
  fetchObject.mockResolvedValueOnce(response()); expect(Buffer.from(await readBody())).toEqual(bytes);
});
it('refuses pre-aborted work and aborts a download after headers', async () => {
  const controller = new AbortController(); controller.abort();
  await expect(storage.putFile(key, file, hash, contentType, controller.signal)).rejects.toThrow('aborted');
  expect(fetchObject).not.toHaveBeenCalled();
  const active = new AbortController(); fetchObject.mockResolvedValueOnce(response(new ReadableStream({ pull() {} })));
  const item = await storage.read(key, active.signal); const read = expect(new Response(item!.body).arrayBuffer()).rejects.toThrow('aborted');
  active.abort(); await read;
});
it('signs a Blob with the installed aws4fetch without converting the archive to an ArrayBuffer', async () => {
  const { AwsClient } = await vi.importActual<typeof import('aws4fetch')>('aws4fetch');
  const body = new Blob([bytes]);
  const arrayBuffer = vi.spyOn(body, 'arrayBuffer').mockRejectedValue(new Error('whole-file buffering forbidden'));
  const request = await new AwsClient({ ...config, service: 's3', region: 'auto', retries: 0 }).sign('https://example.invalid/private/export',
    { method: 'PUT', body, headers: { 'x-amz-content-sha256': hash, 'content-type': contentType } });
  expect(request.headers.get('x-amz-content-sha256')).toBe(hash);
  expect(request.headers.get('authorization')).toContain('x-amz-content-sha256');
  expect(arrayBuffer).not.toHaveBeenCalled(); await request.body?.cancel();
});
it('withholds final bytes until EOF integrity succeeds, including same-length corruption',async()=>{
 const first=bytes.subarray(0,5),last=bytes.subarray(5);let close!:()=>void;
 fetchObject.mockResolvedValueOnce(response(new ReadableStream<Uint8Array>({start(c){c.enqueue(first);c.enqueue(last);close=()=>c.close();}})));
 const item=await storage.read(key),reader=item!.body.getReader();expect((await reader.read()).value).toEqual(first);
 let done=false;const tail=reader.read().then(value=>{done=true;return value;});await Promise.resolve();expect(done).toBe(false);close();expect((await tail).value).toEqual(last);expect((await reader.read()).done).toBe(true);
 for(const chunks of [[Buffer.alloc(bytes.length)],[Buffer.alloc(5),Buffer.alloc(bytes.length-5)]]){
  fetchObject.mockResolvedValueOnce(response(new ReadableStream<Uint8Array>({start(c){chunks.forEach(chunk=>c.enqueue(chunk));c.close();}})));
  const corrupt=await storage.read(key),read=corrupt!.body.getReader();let received=0;
  await expect((async()=>{for(;;){const chunk=await read.read();if(chunk.done)return;received+=chunk.value.length;}})()).rejects.toThrow('verification failed');
  expect(received).toBeLessThan(bytes.length);
 }
});

it('requests identity encoding so R2 does not replace the verified length with transparent gzip transfer',async()=>{
 const calls:RequestInit[]=[];
 const storage=makeFeedbackExportStorage(config);
 fetchObject.mockImplementation(async(_input,init)=>{calls.push(init);return response();});
 const value=await storage.read(key);expect(value).not.toBeNull();await value!.body.cancel();
 expect(calls[0]!.headers).toMatchObject({'accept-encoding':'identity','cache-control':'no-store'});
});

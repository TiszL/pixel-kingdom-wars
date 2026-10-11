import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { FEEDBACK_EXPORTS } from '@shardkeep/shared/feedback';
import { writeFeedbackExport, type ExportReport, type ExportMessage } from '../src/game/feedbackExportFormat.js';

const folders: string[] = [];
const io = vi.hoisted(() => ({ readers: [] as import('node:fs').ReadStream[], failWrite: false, beforeOutput: null as (() => void) | null }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const { Writable } = await import('node:stream');
  return { ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      const reader = fs.createReadStream(...args); io.readers.push(reader); return reader;
    },
    createWriteStream: (...args: Parameters<typeof fs.createWriteStream>) => {
      io.beforeOutput?.();
      if (!io.failWrite) return fs.createWriteStream(...args);
      let written = 0;
      return new Writable({ write(chunk: Buffer, _encoding, callback) {
        written += chunk.length; callback(written > 80 * 1024 ? new Error('Injected disk write failure') : null);
      } });
    },
  };
});
afterEach(async () => {
  io.failWrite = false; io.beforeOutput = null; io.readers.length = 0; vi.restoreAllMocks();
  await Promise.all(folders.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
async function folder() { const p = await mkdtemp(join(tmpdir(), 'pkw-export-test-')); folders.push(p); return p; }
async function* values<T>(items: T[]) { yield* items; }
const metadata = () => ({ jobId: randomUUID(), createdAt: '2026-09-07T12:00:00.000Z' });
function report(messages: ExportMessage[] = []): ExportReport {
  return { id: randomUUID(), revision: 90, data: { title: 'Private report', body: 'Original evidence', wallet: 'test-only-wallet', adminNote: 'Historical staff note', context: { build: 'test' } }, messages: values(messages), attachments: values([]) };
}
const message = (revision: number): ExportMessage => ({ id: randomUUID(), revision, body: `Evidence ${revision}`, visibility: revision % 2 ? 'reporter' : 'admin', kind: revision % 2 ? 'reply' : 'note', authorRole: 'admin', createdAt: metadata().createdAt });

/** Independent ZIP central-directory/deflate reader for these small fixtures.
 * Production encoding is the maintained yazl implementation, not this parser. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  let cursor = bytes.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const size = bytes.readUInt32LE(cursor + 20), method = bytes.readUInt16LE(cursor + 10);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(cursor + 42);
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(start, start + size);
    expect([0, 8]).toContain(method);
    out.set(name, method === 8 ? inflateRawSync(data) : data);
    cursor += 46 + nameLength + extra + comment;
  }
  return out;
}

describe('complete private feedback export files', () => {
  it('exports beyond 200 reports and beyond a thread page without discarding private history', async () => {
    const reports = Array.from({ length: 205 }, () => report());
    reports[204]!.messages = values(Array.from({ length: 75 }, (_, i) => message(i + 2)));
    const output = await writeFeedbackExport(await folder(), 'json', metadata(), values(reports));
    const bytes = await readFile(output.path), json = JSON.parse(bytes.toString());
    expect(json.private).toBe(true); expect(json.schemaVersion).toBe(FEEDBACK_EXPORTS.schemaVersion);
    expect(json.reports).toHaveLength(205); expect(json.reports[204].messages).toHaveLength(75);
    expect(json.reports[204].adminNote).toBe('Historical staff note');
    expect(json.reports[204].messages.some((m: ExportMessage) => m.visibility === 'admin')).toBe(true);
    expect(output).toMatchObject({ reportCount: 205, messageCount: 75, sha256: hash(bytes), byteLength: bytes.length });
  });

  it('labels staff-only notes and preserves their full text in readable export', async () => {
    const reviewed = { ...message(2), moderation: { reason: 'Verified against archived battle', verificationEvidence: 'Exact input replay' } };
    const output = await writeFeedbackExport(await folder(), 'text', metadata(), values([report([reviewed])]));
    const text = await readFile(output.path, 'utf8');
    expect(text).toContain('PRIVATE — PIXEL KINGDOM WARS');
    expect(text).toContain('ADMIN-ONLY NOTE'); expect(text).toContain('Evidence 2');
    expect(text).toContain('Historical staff note');
    expect(text).toContain('Exact input replay'); expect(text).toContain('Verified against archived battle');
    expect(text).toContain('Screenshot bytes are included only in ZIP');
  });

  it('says which client sent every report in every file of the export', async () => {
    // WHY (owner 2026-09-18): the downloaded export is how the owner reads feedback away from
    // the game, and Android-app reports were indistinguishable from web ones in it. Rows older
    // than the server stamp (no `client` key) must still read as ANDROID APP.
    const native = report(), legacy = report(), web = report();
    native.data = { ...native.data, context: { client: 'android-native', clientRelease: '0.5.4', platform: 'android' } };
    legacy.data = { ...legacy.data, context: { platform: 'android', screen: 'feedback', build: 'a'.repeat(40) } };
    web.data = { ...web.data, context: { platform: 'desktop', screen: 'tester', build: 'cee3869' } };
    const entries = unzip(await readFile((await writeFeedbackExport(await folder(), 'zip', metadata(), values([native, legacy, web]))).path));
    const text = entries.get('reports.txt')!.toString();
    expect(text).toContain(`SOURCE: ANDROID APP 0.5.4\nREPORT ${native.id} `);
    expect(text).toContain(`SOURCE: ANDROID APP\nREPORT ${legacy.id} `);
    expect(text).toContain(`SOURCE: WEB · desktop\nREPORT ${web.id} `);
    const json = JSON.parse(entries.get('reports.json')!.toString()).reports as Array<{ id: string; origin: unknown }>;
    expect(json.map(r => r.origin)).toEqual([
      { client: 'android-native', label: 'ANDROID APP 0.5.4', release: '0.5.4' },
      { client: 'android-native', label: 'ANDROID APP' },
      { client: 'web', label: 'WEB · desktop', platform: 'desktop' },
    ]);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()).entries as Array<{ type: string; source?: string }>;
    expect(manifest.filter(e => e.type === 'report').map(e => e.source)).toEqual(['ANDROID APP 0.5.4', 'ANDROID APP', 'WEB · desktop']);
    // A stored `origin` key can never override the derived one.
    const forged = report(); forged.data = { ...forged.data, origin: { client: 'android-native', label: 'ANDROID APP 9.9.9' } };
    const plain = JSON.parse(await readFile((await writeFeedbackExport(await folder(), 'json', metadata(), values([forged]))).path, 'utf8'));
    expect(plain.reports[0].origin).toEqual({ client: 'web', label: 'WEB' });
  });

  it('creates a readable ZIP with immutable IDs/hashes and explicit missing and expired images', async () => {
    const r = report([message(2)]), image = Buffer.from('verified local screenshot bytes');
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    r.attachments = values(ids.map((id, i) => ({ id, messageId: randomUUID(), sha256: hash(image), expired: i === 2,
      read: async () => { if (i === 2) throw new Error('Expired object must not be read'); return i === 0 ? image : null; } })));
    const output = await writeFeedbackExport(await folder(), 'zip', metadata(), values([r]));
    const entries = unzip(await readFile(output.path));
    expect(entries.get(`screenshots/${ids[0]}.webp`)).toEqual(image);
    expect(entries.has(`screenshots/${ids[1]}.webp`)).toBe(false);
    expect(entries.get('reports.txt')?.toString()).toContain('Historical staff note');
    expect(JSON.parse(entries.get('reports.json')!.toString()).reports).toHaveLength(1);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString());
    expect(manifest.complete).toBe(false); expect(manifest.missingAttachments).toBe(1);
    expect(manifest.entries.filter((e: { type: string }) => e.type === 'attachment').map((e: { status: string }) => e.status)).toEqual(['included', 'missing', 'expired']);
    expect(manifest.entries.find((e: { type: string }) => e.type === 'message').sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails a storage outage or changed hash instead of producing a falsely complete archive', async () => {
    for (const read of [async (): Promise<Buffer> => { throw new Error('Storage unavailable'); }, async () => Buffer.from('changed')]) {
      const r = report(); r.attachments = values([{ id: randomUUID(), messageId: randomUUID(), sha256: hash('expected'), expired: false, read }]);
      await expect(writeFeedbackExport(await folder(), 'zip', metadata(), values([r]))).rejects.toThrow();
    }
  });

  it('does not read image bytes for text/JSON or include messages after the frozen revision', async () => {
    const r = report(); r.attachments = values([{ id: randomUUID(), messageId: randomUUID(), sha256: hash('image'), expired: false,
      read: async () => { throw new Error('Metadata export must not fetch image bytes'); } }]);
    await expect(writeFeedbackExport(await folder(), 'json', metadata(), values([r]))).resolves.toMatchObject({ attachmentCount: 1 });
    const changed = report([message(91)]);
    await expect(writeFeedbackExport(await folder(), 'json', metadata(), values([changed]))).rejects.toThrow('frozen');
  });

  it('fails closed on the byte budget and unsafe identities, never truncates successfully', async () => {
    const original = FEEDBACK_EXPORTS.maxBytes;
    Object.defineProperty(FEEDBACK_EXPORTS, 'maxBytes', { value: 20 });
    try { await expect(writeFeedbackExport(await folder(), 'text', metadata(), values([report()]))).rejects.toThrow('too large'); }
    finally { Object.defineProperty(FEEDBACK_EXPORTS, 'maxBytes', { value: original }); }
    const bad = report(); bad.id = '../private';
    await expect(writeFeedbackExport(await folder(), 'zip', metadata(), values([bad]))).rejects.toThrow('identity');
  });

  it.each(['disk', 'zip budget'] as const)('closes active file readers after %s failure and prevents late lazy reopening', async (failure) => {
    const lazy: Array<Parameters<ZipFile['addReadStreamLazy']>[2]> = [];
    const originalAdd = ZipFile.prototype.addReadStreamLazy;
    vi.spyOn(ZipFile.prototype, 'addReadStreamLazy').mockImplementation(function (this: ZipFile, name, options, getReader) {
      lazy.push(getReader); return originalAdd.call(this, name, options, getReader);
    });
    const originalLimit = FEEDBACK_EXPORTS.maxBytes;
    if (failure === 'disk') io.failWrite = true;
    else io.beforeOutput = () => Object.defineProperty(FEEDBACK_EXPORTS, 'maxBytes', { value: 80 * 1024 });
    const bytes = Buffer.alloc(4 * 1024 * 1024, 23), r = report();
    r.attachments = values([{ id: randomUUID(), messageId: randomUUID(), sha256: hash(bytes), expired: false, read: async () => bytes }]);
    try {
      await expect(writeFeedbackExport(await folder(), 'zip', metadata(), values([r])))
        .rejects.toThrow(failure === 'disk' ? 'disk write failure' : 'too large');
      const activeImage = io.readers.find((reader) => String(reader.path).endsWith('.webp'));
      expect(activeImage?.bytesRead).toBeGreaterThan(0);
      expect(activeImage?.bytesRead).toBeLessThan(bytes.length);
      expect(io.readers.every((reader) => reader.destroyed && reader.closed && Reflect.get(reader, 'fd') === null)).toBe(true);
      const opened = io.readers.length, callback = vi.fn();
      lazy.at(-1)!(callback);
      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ message: 'Private export stopped' }), expect.anything());
      expect(io.readers).toHaveLength(opened);
    } finally { Object.defineProperty(FEEDBACK_EXPORTS, 'maxBytes', { value: originalLimit }); }
  });
});

/** Streaming, private export artifacts. Callers freeze report revisions and
 * authorize the job; no user filename or storage URL reaches the archive. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { FEEDBACK_EXPORTS as LIMIT, feedbackOrigin } from '@shardkeep/shared/feedback';
import { ZipFile } from 'yazl';

type Data = Record<string, unknown>;
export interface ExportMessage { id: string; revision: number; body: string; visibility: string; kind: string; authorRole: string; createdAt: string; [key: string]: unknown }
export interface ExportAttachment {
  id: string; messageId: string; sha256: string; expired: boolean;
  /** Returns verified bytes, null for a missing object, throws for uncertainty. */
  read: () => Promise<Buffer | null>;
}
export interface ExportReport {
  id: string; revision: number; data: Data;
  messages: AsyncIterable<ExportMessage>;
  attachments: AsyncIterable<ExportAttachment>;
}
export class FeedbackExportLimitError extends Error {
  constructor() { super('This export is too large. Narrow the selection and prepare another export.'); }
}
const uuid = (value: string): string => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid export object identity');
  return value;
};
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const encoded = (data: unknown): string => JSON.stringify(data);

/** The directory must be a new, private mkdtemp directory owned by this job.
 * Metadata and conversations stream one message at a time; one normalized
 * screenshot is resident at a time. ZIP opens staged files lazily. */
export async function writeFeedbackExport(directory: string, format: 'text' | 'json' | 'zip', metadata: {
  jobId: string; createdAt: string;
}, reports: AsyncIterable<ExportReport>): Promise<{
  path: string; sha256: string; byteLength: number; contentType: string;
  reportCount: number; messageCount: number; attachmentCount: number; missingAttachments: number;
}> {
  uuid(metadata.jobId);
  let stagedBytes = 0, reportCount = 0, messageCount = 0, attachmentCount = 0, missingAttachments = 0;
  const files = new Set<string>(), handles: Array<Awaited<ReturnType<typeof open>>> = [];
  const addFile = (name: string): void => {
    if (files.size >= LIMIT.maxArchiveEntries || files.has(name)) throw new FeedbackExportLimitError();
    files.add(name);
  };
  const create = async (name: string) => {
    addFile(name);
    const handle = await open(join(directory, name), 'wx', 0o600); handles.push(handle);
    return async (value: string | Buffer): Promise<void> => {
      const bytes = typeof value === 'string' ? Buffer.from(value) : value;
      stagedBytes += bytes.length;
      if (stagedBytes > LIMIT.maxBytes) throw new FeedbackExportLimitError();
      let offset = 0;
      while (offset < bytes.length) {
        const written = await handle.write(bytes, offset, bytes.length - offset);
        if (!written.bytesWritten) throw new Error('Private export write stopped');
        offset += written.bytesWritten;
      }
    };
  };
  let json: Awaited<ReturnType<typeof create>> | null = null;
  let text: Awaited<ReturnType<typeof create>> | null = null;
  let manifest: Awaited<ReturnType<typeof create>> | null = null;
  let manifestRows = 0;
  const record = async (entry: Data): Promise<void> => {
    if (manifest) await manifest(`${manifestRows++ ? ',' : ''}\n${encoded(entry)}`);
  };
  const header = { schemaVersion: LIMIT.schemaVersion, private: true, ...metadata,
    screenshotBytesIncluded: format === 'zip' };
  try {
    json = format !== 'text' ? await create('reports.json') : null;
    text = format !== 'json' ? await create('reports.txt') : null;
    manifest = format === 'zip' ? await create('manifest.json') : null;
    await json?.(`${encoded(header).slice(0, -1)},"reports":[`);
    await text?.(`PRIVATE — PIXEL KINGDOM WARS FEEDBACK\nExport ${metadata.jobId}\nPrepared from frozen report revisions.\n${format === 'zip' ? 'See manifest.json for included or missing screenshots.' : 'Screenshot bytes are included only in ZIP exports.'}\n\n`);
    await manifest?.(`${encoded(header).slice(0, -1)},"entries":[`);
    for await (const report of reports) {
      uuid(report.id);
      if (!Number.isSafeInteger(report.revision) || report.revision < 1) throw new Error('Invalid frozen report revision');
      // Owner 2026-09-18: every exported report says which client sent it, in every
      // file of the export. Derived at read time, so rows older than the server
      // stamp still read as ANDROID APP; the frozen snapshot itself is unchanged.
      const origin = feedbackOrigin(report.data['context']);
      const reportData = encoded({ ...report.data, origin, id: report.id, revision: report.revision });
      await json?.(`${reportCount ? ',' : ''}\n${reportData.slice(0, -1)},"messages":[`);
      await text?.(`SOURCE: ${origin.label}\nREPORT ${report.id} · REVISION ${report.revision}\n${String(report.data['title'] ?? '')}\n${String(report.data['body'] ?? '')}\n\nREPORT DATA\n${JSON.stringify(report.data, null, 2)}\n\nCONVERSATION\n`);
      await record({ type: 'report', id: report.id, revision: report.revision, source: origin.label, sha256: digest(reportData) });
      let firstMessage = true;
      for await (const message of report.messages) {
        uuid(message.id);
        if (message.revision > report.revision) throw new Error('Message exceeds the frozen export revision');
        const line = encoded(message);
        await json?.(`${firstMessage ? '' : ','}\n${line}`); firstMessage = false;
        await text?.(`[${message.createdAt}] ${message.authorRole} · ${message.visibility === 'admin' ? 'ADMIN-ONLY NOTE' : 'REPORTER-VISIBLE'} · ${message.kind} · ${message.id}\n${message.body}\n\n`);
        const { body: _body, ...details } = message;
        await text?.(`MESSAGE DATA\n${JSON.stringify(details, null, 2)}\n\n`);
        await record({ type: 'message', reportId: report.id, id: message.id, revision: message.revision, sha256: digest(line) });
        messageCount++;
      }
      await json?.('],"attachments":[');
      let firstAttachment = true;
      for await (const attachment of report.attachments) {
        uuid(attachment.id); uuid(attachment.messageId);
        if (!/^[0-9a-f]{64}$/.test(attachment.sha256)) throw new Error('Invalid frozen attachment hash');
        let status = attachment.expired ? 'expired' : 'metadata_only';
        let path: string | null = null;
        if (format === 'zip' && !attachment.expired) {
          const bytes = await attachment.read();
          if (bytes === null) { status = 'missing'; missingAttachments++; }
          else {
            if (digest(bytes) !== attachment.sha256) throw new Error('Private screenshot hash changed');
            path = `screenshots/${attachment.id}.webp`;
            await mkdir(join(directory, 'screenshots'), { recursive: true, mode: 0o700 });
            const write = await create(path); await write(bytes);
            // Close screenshots promptly; only the three text streams stay open.
            await handles.pop()!.close();
            status = 'included';
          }
        }
        const entry = { type: 'attachment', reportId: report.id, id: attachment.id,
          messageId: attachment.messageId, sha256: attachment.sha256, status, path };
        await json?.(`${firstAttachment ? '' : ','}${encoded(entry)}`); firstAttachment = false;
        await text?.(`SCREENSHOT ${attachment.id} · ${status.toUpperCase()} · SHA256 ${attachment.sha256}\n`);
        await record(entry); attachmentCount++;
      }
      await json?.(']}'); await text?.('\n────────────────────────────────\n\n'); reportCount++;
    }
    await json?.(']}\n');
    await manifest?.(`\n],"reportCount":${reportCount},"messageCount":${messageCount},"attachmentCount":${attachmentCount},"missingAttachments":${missingAttachments},"complete":${missingAttachments === 0}}\n`);
  } finally { await Promise.all(handles.map((handle) => handle.close())); }

  const name = format === 'text' ? 'reports.txt' : format === 'json' ? 'reports.json' : 'feedback.zip';
  const path = join(directory, name);
  if (format === 'zip') {
    const zip = new ZipFile();
    const archiveOutput = zip.outputStream;
    if (!(archiveOutput instanceof Readable)) throw new Error('Unexpected ZIP output stream');
    const readers = new Map<ReturnType<typeof createReadStream>, Promise<void>>();
    let stopped = false;
    const limiter = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      zipBytes += chunk.length;
      callback(zipBytes > LIMIT.maxBytes ? new FeedbackExportLimitError() : null, chunk);
    } });
    let zipBytes = 0;
    zip.on('error', (error: Error) => limiter.destroy(error));
    const output = pipeline(archiveOutput, limiter, createWriteStream(path, { flags: 'wx', mode: 0o600 }));
    // Observe immediately, including synchronous setup failures below.
    void output.catch(() => {});
    try {
      for (const name of files) zip.addReadStreamLazy(name, {
        mode: 0o100600, mtime: new Date(metadata.createdAt),
        // Screenshots are already compressed. Stored ZIP entries also avoid
        // leaving yazl-owned zlib workers alive when an output fails.
        compress: false,
      }, (callback) => {
        if (stopped) { callback(new Error('Private export stopped'), archiveOutput); return; }
        const reader = createReadStream(join(directory, name));
        const closed = finished(reader).catch(() => {}).then(() => { readers.delete(reader); });
        readers.set(reader, closed);
        reader.on('error', (error) => limiter.destroy(error));
        callback(null, reader);
      });
      zip.end(); await output;
    } finally {
      stopped = true;
      // yazl does not propagate output destruction to its file readers.
      // Close our sources explicitly before the job removes its private files.
      const closed = [...readers.values()];
      for (const reader of readers.keys()) reader.destroy();
      archiveOutput.destroy(); limiter.destroy();
      await Promise.all(closed); await output.catch(() => {});
    }
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return { path, sha256: hash.digest('hex'), byteLength: (await stat(path)).size,
    contentType: format === 'zip' ? 'application/zip' : format === 'json' ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    reportCount, messageCount, attachmentCount, missingAttachments };
}

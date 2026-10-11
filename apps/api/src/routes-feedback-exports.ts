/** Every export request/download uses the existing full admin session. Objects
 * stay private in R2; clients receive only a same-origin authenticated route. */
import { Readable } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import type { Config } from './config';
import type { Db } from './db/client';
import { feedbackExportJobs as jobs } from './db/schema';
import { FeedbackExportRequest, requestFeedbackExport } from './game/feedbackExports';
import type { FeedbackExportStorage } from './game/feedbackExportStorage';
import { HttpError } from './lib/errors';
import { parse } from './lib/validation';

export interface FeedbackExportRouteDeps { feedbackExportStorage?: FeedbackExportStorage }
const Id = z.object({ id: z.string().uuid() }).strict();
const Page = z.object({ before: z.string().uuid().optional() }).strict();
function dto(job: typeof jobs.$inferSelect, count: number) {
  const manifest = job.manifest as { byteLength?: number; missingAttachments?: number } | null;
  const expired = job.expiresAt <= new Date() || job.state === 'deleting' || job.state === 'deleted';
  return { id: job.id, format: job.format, state: expired ? 'expired' : job.state,
    schemaVersion: job.schemaVersion, reportCount: count, createdAt: job.createdAt.toISOString(),
    expiresAt: job.expiresAt.toISOString(), preparedAt: job.preparedAt?.toISOString() ?? null,
    downloadRequestedAt: job.downloadRequestedAt?.toISOString() ?? null,
    byteLength: manifest?.byteLength ?? null, missingAttachments: manifest?.missingAttachments ?? null,
    errorCode: job.errorCode, private: true };
}
export function registerFeedbackExportRoutes(app: FastifyInstance, config: Config, db: Db, deps: FeedbackExportRouteDeps): void {
  const prefix = '/admin/tester/feedback/exports';
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    await app.authenticate(req, reply); if (reply.sent) return;
    if (!config.ADMIN_WALLETS?.includes(req.wallet)) throw new HttpError(403, 'admin access required');
  }
  const headers = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store'); reply.header('Vary', 'Cookie, Authorization');
    reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer');
  };
  const options = { preHandler: requireAdmin, onRequest: headers };
  const count = sql<number>`(select count(*)::int from feedback_export_reports where job_id=${jobs.id})`;
  const available = () => {
    if (!deps.feedbackExportStorage) throw new HttpError(503, 'Private exports are unavailable. Your reports remain saved.', 'FEEDBACK_EXPORT_UNAVAILABLE');
    return deps.feedbackExportStorage;
  };
  app.post(prefix, options, async (req, reply) => {
    available(); const receipt = await requestFeedbackExport(db, config, req.wallet, parse(FeedbackExportRequest, req.body));
    return reply.code(202).send(receipt);
  });
  app.get(prefix, options, async req => {
    const { before } = parse(Page, req.query);
    const [cursor] = before ? await db.select({ id: jobs.id, createdAt: jobs.createdAt }).from(jobs).where(eq(jobs.id, before)) : [];
    if (before && !cursor) throw new HttpError(400, 'export page changed; refresh exports');
    const page = await db.select({ job: jobs, count }).from(jobs)
      .where(cursor ? sql`(${jobs.createdAt},${jobs.id})<(${cursor.createdAt.toISOString()}::timestamptz,${cursor.id}::uuid)` : undefined)
      .orderBy(desc(jobs.createdAt), desc(jobs.id)).limit(LIMIT.pageSize + 1);
    return { exports: page.slice(0, LIMIT.pageSize).map(row => dto(row.job, row.count)),
      nextBefore: page.length > LIMIT.pageSize ? page[LIMIT.pageSize - 1]!.job.id : null };
  });
  app.get(`${prefix}/:id`, options, async req => {
    const [row] = await db.select({ job: jobs, count }).from(jobs).where(eq(jobs.id, parse(Id, req.params).id));
    if (!row) throw new HttpError(404, 'export not found');
    return dto(row.job, row.count);
  });
  app.get(`${prefix}/:id/download`, options, async (req, reply) => {
    const storage = available();
    const [job] = await db.select().from(jobs).where(eq(jobs.id, parse(Id, req.params).id));
    if (!job) throw new HttpError(404, 'export not found');
    if (job.expiresAt <= new Date() || ['deleted', 'deleting'].includes(job.state)) throw new HttpError(410, 'This export expired. Prepare a new export.', 'FEEDBACK_EXPORT_EXPIRED');
    if (job.state !== 'ready' || !job.objectKey || !job.sha256) throw new HttpError(409, 'This export is not ready to download.', 'FEEDBACK_EXPORT_NOT_READY');
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.raw.once('aborted', abort);
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) abort(); });
    try {
      let object;
      try { object = await storage.read(job.objectKey, controller.signal); }
      catch { throw new HttpError(503, 'Private export storage is unavailable. Retry the download.', 'FEEDBACK_EXPORT_UNAVAILABLE'); }
      if (!object) throw new HttpError(503, 'The export file is unavailable. Prepare a new export.', 'FEEDBACK_EXPORT_UNAVAILABLE');
      const manifest = job.manifest as { byteLength?: number; contentType?: string } | null;
      if (object.sha256 !== job.sha256 || object.byteLength !== manifest?.byteLength || object.contentType !== manifest?.contentType) {
        await object.body.cancel(); throw new HttpError(503, 'Export verification failed. Prepare a new export.', 'FEEDBACK_EXPORT_UNAVAILABLE');
      }
      const recorded = await db.update(jobs).set({ downloadRequestedAt: new Date() })
        .where(and(eq(jobs.id, job.id), eq(jobs.state, 'ready'), gt(jobs.expiresAt, new Date())))
        .returning({ id: jobs.id });
      if (!recorded.length) { await object.body.cancel(); throw new HttpError(410, 'This export expired. Prepare a new export.', 'FEEDBACK_EXPORT_EXPIRED'); }
      const stream = Readable.fromWeb(object.body as NodeReadableStream<Uint8Array>);
      stream.once('close', () => { req.raw.removeListener('aborted', abort); });
      reply.header('Content-Disposition', `attachment; filename="pkw-private-feedback-${job.id}.${job.format === 'text' ? 'txt' : job.format}"`);
      reply.header('Content-Type', object.contentType); reply.header('Content-Length', object.byteLength);
      // The timestamp means requested, never that the browser saved a file.
      return reply.send(stream);
    } catch (error) { controller.abort(); req.raw.removeListener('aborted', abort); throw error; }
  });
}

import { FEEDBACK_SCREENSHOTS as LIMIT, FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { authorizeFeedbackScreenshotRead, authorizeFeedbackUpload, readFeedbackScreenshot, uploadFeedbackScreenshot } from './game/feedbackAttachments';
import { acquireFeedbackPermit, FeedbackImageError, FeedbackStorageBusyError, type FeedbackScreenshotStorage } from './game/feedbackStorage';
import { HttpError } from './lib/errors';

const Report = z.object({ id: z.string().uuid() });
const Upload = Report.extend({ requestId: z.string().min(1).max(FEEDBACK_THREADS.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/) });
const Read = Report.extend({ attachmentId: z.string().uuid() });
const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
function params<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'invalid screenshot request');
  return parsed.data;
}
function privateHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'private, no-store');
  reply.header('Vary', 'Cookie, Authorization');
  reply.header('X-Content-Type-Options', 'nosniff');
}
function publicError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof FeedbackImageError) throw new HttpError(422, error.message, 'FEEDBACK_IMAGE_INVALID');
  if (error instanceof FeedbackStorageBusyError) throw new HttpError(503, 'screenshot processing is busy; try again', 'FEEDBACK_STORAGE_BUSY');
  throw new HttpError(503, 'private screenshot storage is temporarily unavailable; retry the same request', 'FEEDBACK_STORAGE_UNAVAILABLE');
}
export interface FeedbackAttachmentRouteDeps {
  feedbackScreenshotStorage?: FeedbackScreenshotStorage;
  /** Lifecycle-test seam; production always uses the shared receive deadline. */
  feedbackUploadReceiveTimeoutMs?: number;
}
export function registerFeedbackAttachmentRoutes(app: FastifyInstance, config: Config, db: Db, deps: FeedbackAttachmentRouteDeps): void {
  // An encapsulated parser prevents unrelated routes accepting 8 MiB images.
  app.register(async (scoped) => {
    scoped.addHook('onRequest', async (_req, reply) => privateHeaders(reply));
    scoped.addHook('onSend', async (_req, reply, payload) => { privateHeaders(reply); return payload; });
    const releases = new WeakMap<FastifyRequest, () => void>();
    const timers = new WeakMap<FastifyRequest, ReturnType<typeof setTimeout>>();
    const clearTimer = (req: FastifyRequest): void => { clearTimeout(timers.get(req)); timers.delete(req); };
    const release = (req: FastifyRequest): void => { clearTimer(req); const done = releases.get(req); releases.delete(req); done?.(); };
    const limiter = config.NODE_ENV === 'test' ? null : app.createRateLimit({ max: LIMIT.maxUploadsPerWindow,
      timeWindow: LIMIT.uploadWindowMs, keyGenerator: (req: FastifyRequest) => `feedback-image:${req.wallet}`, skipOnError: false });
    for (const mode of ['reporter', 'admin'] as const) {
      const prefix = mode === 'admin' ? '/admin/tester/feedback' : '/tester/feedback';
      const authenticate = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        await app.authenticate(req, reply); if (reply.sent) return;
        if (mode === 'admin' && !config.ADMIN_WALLETS?.includes(req.wallet)) throw new HttpError(404, 'feedback not found');
      };
      scoped.register(async (uploadOnly) => {
        for (const type of imageTypes) uploadOnly.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: LIMIT.maxUploadBytes }, (_req, body, done) => done(null, body));
        uploadOnly.post(`${prefix}/:id/screenshots/:requestId`, {
          bodyLimit: LIMIT.maxUploadBytes,
          onRequest: async (req, reply) => {
            await authenticate(req, reply); if (reply.sent) return;
            const { id } = params(Upload, req.params);
            await authorizeFeedbackUpload(db, config, { wallet: req.wallet, mode }, id);
            if (!deps.feedbackScreenshotStorage) throw new HttpError(503, 'private screenshots are temporarily unavailable', 'FEEDBACK_STORAGE_UNAVAILABLE');
            const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
            if (!imageTypes.includes(type)) throw new HttpError(415, 'send a PNG, JPEG or WebP image');
            if (limiter) { const budget = await limiter(req); if (!budget.isAllowed && budget.isExceeded) throw new HttpError(429, 'too many screenshot attempts; try again later'); }
            try { releases.set(req, acquireFeedbackPermit('raw')); } catch (error) { publicError(error); }
            timers.set(req, setTimeout(() => { release(req); req.raw.destroy(new Error('screenshot upload receive deadline exceeded')); }, deps.feedbackUploadReceiveTimeoutMs ?? LIMIT.uploadReceiveTimeoutMs));
          },
          preValidation: async (req) => clearTimer(req),
          onError: async (req) => release(req), onResponse: async (req) => release(req),
          onRequestAbort: async (req) => release(req), onTimeout: async (req) => release(req),
        }, async (req) => {
          if (!Buffer.isBuffer(req.body)) throw new HttpError(422, 'screenshot image body is required');
          const { id, requestId } = params(Upload, req.params);
          try { return await uploadFeedbackScreenshot(db, config, deps.feedbackScreenshotStorage!, { wallet: req.wallet, mode }, id, requestId,
            req.body, (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()); }
          catch (error) { publicError(error); }
        });
      });
      scoped.get(`${prefix}/:id/screenshots/:attachmentId`, { onRequest: authenticate }, async (req, reply) => {
        const { id, attachmentId } = params(Read, req.params);
        try {
          // Authorization still precedes storage availability, preventing a
          // service outage from changing another wallet's private response.
          await authorizeFeedbackScreenshotRead(db, config, { wallet: req.wallet, mode }, id);
          if (!deps.feedbackScreenshotStorage) throw new HttpError(503, 'private screenshots are temporarily unavailable', 'FEEDBACK_STORAGE_UNAVAILABLE');
          const result = await readFeedbackScreenshot(db, config, deps.feedbackScreenshotStorage, { wallet: req.wallet, mode }, id, attachmentId);
          return reply.type(result.contentType).header('Content-Disposition', 'inline; filename="screenshot.webp"').send(result.bytes);
        } catch (error) { publicError(error); }
      });
    }
  });
}

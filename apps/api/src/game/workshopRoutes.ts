/**
 * `/workshop*` — Forge Ingot refining (docs/phase-e/E2-WORKSHOP-CONTRACT.md §4).
 *
 * Every route is auth-only (E1-CONTRACTS §4.0 conventions: `authOnly` +
 * `mutationBaseId` + `stablePrerequisiteContext`, the `/gems/*` shape) and
 * new starts are dark behind FORGE_INGOTS_ENABLED (503 PHASE_E_DISABLED). The dark gate runs
 * AFTER authentication, so an anonymous caller always sees 401, the land-gate
 * probe table can prove the registration, and the surface is never a flag
 * oracle. Money POSTs take the sensitive per-IP ceiling; receipts are
 * historical evidence only and never cached.
 */
import { FORGE_INGOT, TWOFA } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { forgeIngotsEnabled, multiBaseEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { workshopJobs } from '../db/schema';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import {
  assertFreshLockedBaseAuthority, lockActiveBase, requireFreshBaseAuthority,
  type FinalizedDeedReader,
} from './baseOwnership';
import {
  collectRefine, getWorkshopCollectReceipt, getWorkshopStartReceipt, getWorkshopView, startRefine,
} from './workshop';

export interface WorkshopRouteDeps {
  /** The same finalized-deed authority inputs `registerGameRoutes` receives. */
  market?: {
    rpcUrl?: string | undefined;
    deedCollection?: string | undefined;
    finalizedDeedReader?: FinalizedDeedReader | null | undefined;
  } | undefined;
}

const IdemKey = z.string().min(8).max(128);
const BaseId = z.uuid().optional();
const JobId = z.uuid();

export function registerWorkshopRoutes(app: FastifyInstance, db: Db, deps: WorkshopRouteDeps = {}): void {
  // NEVER construct a reader here: every `makeFinalizedDeedReader` call is a
  // paced foreground reader the deed RPC budget multiplies by (owner
  // 2026-09-19). app.ts hands over the one `registerGameRoutes` owns (null when
  // no RPC is configured — the authority helper then applies the same no-RPC
  // rule the game routes use); a bare registration (the land-gate probe) has none.
  const finalizedDeedReader = deps.market?.finalizedDeedReader ?? null;
  const deedCollection = deps.market?.deedCollection ?? null;

  const workshopOn = async () => {
    if (!forgeIngotsEnabled()) throw new HttpError(503, 'Workshop refining is not enabled', 'PHASE_E_DISABLED');
  };
  // A pause must not strand SHARDS already spent on a job. Historical receipts
  // and collection retain their normal wallet/base authority after flags turn off.
  const recoveryRead = { preHandler: [app.authenticate] };
  const recoveryMoney = {
    ...recoveryRead,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  };
  const money = {
    preHandler: [app.authenticate, workshopOn],
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  };
  const noStore = async (_req: unknown, reply: { header: (k: string, v: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store');
    return payload;
  };

  // Refining is deed-native: jobs and ingots are base rows. The legacy
  // wallet-keyed base (multi-base off) has no id to scope them to.
  const resolveBase = async (wallet: string, requestedBaseId?: string): Promise<string> => {
    if (!multiBaseEnabled()) {
      throw new HttpError(409, 'the Workshop needs a deed-native base', 'BASE_ID_REQUIRED');
    }
    const resolved = (await db.transaction((tx) => lockActiveBase(tx, wallet, requestedBaseId))).base.id;
    await requireFreshBaseAuthority(db, wallet, resolved, finalizedDeedReader, deedCollection);
    return resolved;
  };
  const stableContext = (baseId: string) => ({
    baseId,
    assertAuthority: async (tx: DbOrTx, wallet: string, lockedBaseId: string): Promise<void> => {
      await assertFreshLockedBaseAuthority(tx, wallet, lockedBaseId);
    },
  });
  const now = () => new Date();

  app.get('/workshop', recoveryRead, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const query = parse(z.object({ baseId: BaseId }), req.query ?? {});
    const baseId = await resolveBase(req.wallet, query.baseId);
    return getWorkshopView(db, req.wallet, baseId, now());
  });

  app.post('/workshop/jobs', money, async (req, reply) => {
    const body = parse(z.object({
      idempotencyKey: IdemKey,
      baseId: BaseId,
      ingots: z.number().int().positive().max(FORGE_INGOT.batch.max),
      recipeVersion: z.number().int().positive(),
    }), req.body);
    const baseId = await resolveBase(req.wallet, body.baseId);
    const res = await startRefine(
      db, req.wallet, baseId, body.ingots, body.recipeVersion, body.idempotencyKey, undefined, stableContext(baseId),
    );
    return reply.status(res.duplicate ? 200 : 201).send(res);
  });

  app.get('/workshop/jobs/by-key/:key', { ...recoveryRead, onSend: noStore }, async (req) => {
    const { key } = parse(z.object({ key: IdemKey }), req.params);
    const receipt = await getWorkshopStartReceipt(db, req.wallet, key);
    return { wallet: req.wallet, idempotencyKey: key, status: receipt.status,
      receipt: receipt.status === 'accepted' ? receipt : null, serverNow: now().toISOString() };
  });

  // The job names its base (E2-WORKSHOP-CONTRACT §4: body is `{ idempotencyKey }`);
  // the CURRENT owner's authority over that base is then required exactly as
  // for a start. A job id nobody can see answers the same 404 as an unowned one.
  app.post('/workshop/jobs/:jobId/collect', recoveryMoney, async (req, reply) => {
    const { jobId } = parse(z.object({ jobId: JobId }), req.params);
    const body = parse(z.object({ idempotencyKey: IdemKey }), req.body);
    const [job] = await db.select({ baseId: workshopJobs.baseId }).from(workshopJobs).where(eq(workshopJobs.id, jobId));
    if (!job) throw new HttpError(404, 'refining job not found on this base', 'JOB_NOT_FOUND');
    // A real id on a base this wallet does not own must answer EXACTLY like an
    // unknown id (no existence oracle across bases).
    const baseId = await resolveBase(req.wallet, job.baseId).catch((error: unknown) => {
      if (error instanceof HttpError && error.code === 'BASE_NOT_OWNED') {
        throw new HttpError(404, 'refining job not found on this base', 'JOB_NOT_FOUND');
      }
      throw error;
    });
    const res = await collectRefine(db, req.wallet, baseId, jobId, body.idempotencyKey, undefined, stableContext(baseId));
    return reply.status(res.duplicate ? 200 : 201).send(res);
  });

  app.get('/workshop/jobs/:jobId/collect/by-key/:key', { ...recoveryRead, onSend: noStore }, async (req) => {
    const { jobId, key } = parse(z.object({ jobId: JobId, key: IdemKey }), req.params);
    const receipt = await getWorkshopCollectReceipt(db, req.wallet, jobId, key);
    return { wallet: req.wallet, idempotencyKey: key, status: receipt.status,
      receipt: receipt.status === 'accepted' ? receipt : null, serverNow: now().toISOString() };
  });
}

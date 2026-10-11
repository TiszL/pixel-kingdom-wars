import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { FORGE_INGOT, GEMS, LIVE_RAID, RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import { z } from 'zod';
import { forgeIngotsEnabled, gemsEnabled, gemsWalletBuyEnabled, phaseEArtEnabled, phaseEBuildingsEnabled, type Config } from '../config';
import type { Db } from '../db/client';
import { gemsReserveAta } from '../money/economyIdentity';
import { readCustodyTransparency } from '../money/custodyTransparency';
import { GAME_CURRENCY_FEATURE } from '../game/clientCurrency';
import { HttpError } from '../lib/errors';
import { parse } from '../lib/validation';
import { BUILD } from '../version';
import { NATIVE_MAX_WAIT_MS, NATIVE_PAGE_BYTES, NATIVE_PAGE_AGE_MS, NATIVE_REALM_KIT_RENDERER_CONTRACT, NativeCapabilitiesSchema, type NativeUpdateOffer } from './contracts';
import { nativeRendererContract, registerNativeClientPresentation } from './clientPresentation';
import { loadNativePresentation } from './source';
import { visibleNativeUpdate } from './updateChannel';
import { NativeSimulationService } from './simulation';
import { NativePresentationPages } from './paging';

/** Transport cadence: avoid taking the live-raid row lock more than once a second per waiting viewer. */
export const NATIVE_POLL_INTERVAL_MS = 1_000;

/** One viewer leaving releases its HTTP slot immediately. A shared bounded
 * calculation may finish for another viewer and never touches game state. */
export function abortablePresentation<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new HttpError(499, 'presentation request closed'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    void task.then((value) => {
      signal.removeEventListener('abort', abort); resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** Technical admission limits, not game rules. Public enablement still requires
 * a measured worker budget; the default is dark even if a client knows this URL. */
export function registerNativeRoutes(app: FastifyInstance, config: Pick<Config,
  'NATIVE_PRESENTATION_ENABLED' | 'NATIVE_PRESENTATION_WALLETS' | 'NATIVE_PRESENTATION_OPEN' | 'NATIVE_PRESENTATION_WORKERS' |
  'NATIVE_PRESENTATION_MAX_RAIDS' | 'NATIVE_PRESENTATION_MAX_STREAMS' | 'NATIVE_PRESENTATION_CACHE_MIB' |
  'NATIVE_MIN_VERSION_CODE' | 'NATIVE_CONTENT_MANIFEST_URL' | 'NATIVE_CONTENT_MANIFEST_URL_LEGACY'> &
  // M45 §1: optional so the isolated companion and route fixtures stay dark by omission.
  // NATIVE_WORLD_V2_ENABLED is optional too, but an omitted key reads ON (the default).
  Partial<Pick<Config, 'NATIVE_UPDATE_CHANNEL_ENABLED' | 'NATIVE_WORLD_V2_ENABLED' | 'ADMIN_WALLETS' | 'PLAY_URL' | 'WEB_ORIGIN'>>, db: Db) {
  // Instance-wide: every route carrying a visualContext presents revision-5 ground
  // to a pre-realm-kit Android renderer as revision 4 (REALM-KIT-PLAN E-12).
  registerNativeClientPresentation(app);
  // S1: /base's server-owned feature gate is shared, but its art permission
  // must not promote a legacy renderer (or old web) onto native construction art.
  // Copy only the response projection; building offers/rules and stored state stay intact.
  app.addHook('preSerialization', async (req, _reply, payload) => {
    const contract = nativeRendererContract(req.headers);
    if (contract !== null && contract >= NATIVE_REALM_KIT_RENDERER_CONTRACT) return payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
    const features = (payload as { features?: unknown }).features;
    if (!features || typeof features !== 'object' || Array.isArray(features)
        || !Object.hasOwn(features, 'phaseEArt')) return payload;
    const { phaseEArt: _omitted, ...legacyFeatures } = features as Record<string, unknown>;
    return { ...payload, features: legacyFeatures };
  });
  const enabled = config.NATIVE_PRESENTATION_ENABLED === 'true';
  const open = config.NATIVE_PRESENTATION_OPEN === 'true';
  const authenticate = async (req: FastifyRequest, reply: FastifyReply) => {
    await app.authenticate(req, reply);
    // Fail closed: without the explicit OPEN switch only listed testers pass, and
    // an empty list admits nobody (config refuses that combination at boot too).
    if (!open && !config.NATIVE_PRESENTATION_WALLETS?.includes(req.wallet)) {
      throw new HttpError(403, 'native testing is not available for this account', 'NATIVE_TESTER_REQUIRED');
    }
  };
  const maxStreams = config.NATIVE_PRESENTATION_MAX_STREAMS ?? 16;
  const cacheBytes = config.NATIVE_PRESENTATION_CACHE_MIB ? config.NATIVE_PRESENTATION_CACHE_MIB * 1024 * 1024 : 32 * 1024 * 1024;
  const service = new NativeSimulationService({
    workers: config.NATIVE_PRESENTATION_WORKERS ?? 1,
    raids: config.NATIVE_PRESENTATION_MAX_RAIDS ?? 8,
    cacheBytes,
  });
  // A separate serialized timeline budget bounds resumable page retention. It
  // does not consume settlement-worker slots or duplicate cached page bodies.
  const pages = new NativePresentationPages({ cacheBytes,
    generations: maxStreams * 8, timelines: (config.NATIVE_PRESENTATION_MAX_RAIDS ?? 8) * 4 });
  const streams = new Set<AbortController>();
  const wallets = new Map<string, number>();
  app.addHook('onClose', async () => {
    for (const controller of streams) controller.abort();
    await service.close();
    pages.close();
  });

  // Optional content discovery must not spend gameplay's shared IP budget.
  // An explicit route bucket inherits the same finite global ceiling/window.
  app.get('/native/capabilities', { config: { rateLimit: {} } }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    let available = enabled;
    if (enabled && config.NATIVE_PRESENTATION_WALLETS) {
      try { await authenticate(req, reply); }
      catch (error) {
        if (!(error instanceof HttpError) || ![401, 403].includes(error.statusCode)) throw error;
        available = false;
      }
    }
    // M45 §1: tester rows need a valid session; a missing or refused one sees
    // stable rows only. With the flag off neither the session nor the table is read.
    // Any other failure leaves the key absent: an offer is optional, while code 25
    // reads capabilities on its battle path and must never see a 500 from it.
    let update: NativeUpdateOffer | null = null;
    if (config.NATIVE_UPDATE_CHANNEL_ENABLED === 'true') {
      try {
        let wallet: string | null = null;
        try { await app.authenticate(req, reply); wallet = req.wallet; }
        catch (error) {
          if (!(error instanceof HttpError) || ![401, 403].includes(error.statusCode)) throw error;
        }
        update = await visibleNativeUpdate(db, config, wallet);
      } catch (err) {
        req.log.error({ err }, 'native update offer failed; capabilities served without update');
      }
    }
    const reserveAta = gemsReserveAta(db);
    const walletBuy = gemsWalletBuyEnabled() && reserveAta !== null;
    // Match /gems: inaccessible or closed custody never advertises ledger spend.
    // Short-circuit while Gems is OFF so optional capability discovery adds no DB read.
    const ledgerGems = gemsEnabled() && (await readCustodyTransparency(db)).phase === 'open';
    // Code 25's content engine refuses any pack above renderer contract 14, so a
    // renderer below the realm-kit contract (or web, or a malformed header) is
    // advertised the legacy generation when one is configured.
    const contract = nativeRendererContract(req.headers);
    const modern = contract !== null && contract >= NATIVE_REALM_KIT_RENDERER_CONTRACT;
    return NativeCapabilitiesSchema.parse({
      protocolVersion: 1, sourceCommit: BUILD.gitSha, simVersion: BUILD.simVersion,
      minimumVersionCode: config.NATIVE_MIN_VERSION_CODE ?? 0,
      contentManifestUrl: (modern ? config.NATIVE_CONTENT_MANIFEST_URL
        : (config.NATIVE_CONTENT_MANIFEST_URL_LEGACY ?? config.NATIVE_CONTENT_MANIFEST_URL)) ?? null,
      ...(modern ? { phaseEArt: { version: 1 as const, enabled: phaseEArtEnabled() && phaseEBuildingsEnabled() } } : {}),
      presentation: { enabled: available, protocolVersions: [1, 2], raidProtocolVersions: [2], supportsStablePrefix: true,
        maxWaitMs: NATIVE_MAX_WAIT_MS, maxPageBytes: NATIVE_PAGE_BYTES, maxEvents: RAID_REPLAY_LIMITS.maxEvents,
        maxCommands: LIVE_RAID.maxCommands, maxPageAgeMs: NATIVE_PAGE_AGE_MS },
      notifications: { enabled: false },
      economy: { gameCurrency: GAME_CURRENCY_FEATURE, workshop: { enabled: forgeIngotsEnabled(), recipeVersion: FORGE_INGOT.recipeVersion }, gems: {
        enabled: gemsEnabled(),
        ...(gemsEnabled() ? { exactConsent: 1 as const } : {}),
        // The wallet source needs BOTH the flag and its destination: a source
        // without a reserve ATA would invite transfers nothing can credit, and
        // a destination without the source is never published (security
        // review 2026-09-20 #3) — a client must only see an ATA it may pay.
        sources: gemsEnabled() ? [...(ledgerGems ? ['ledger-keep' as const] : []),
          ...(walletBuy ? ['wallet-keep' as const] : [])] : [],
        destinationAta: walletBuy ? reserveAta : null,
        gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem,
        minConvertKeep: GEMS.minConvertKeep, maxConvertKeepPerTx: GEMS.maxConvertKeepPerTx,
      } },
      ...(update ? { update } : {}),
      // D-180 kill switch: always sent, from config only (no DB, no session), so it
      // can neither throw nor change any field installed code 25 reads.
      worldV2: { enabled: config.NATIVE_WORLD_V2_ENABLED !== 'false' },
    });
  });

  app.get('/raids/:id/presentation', {
    onRequest: [async () => {
      if (!enabled) throw new HttpError(503, 'native presentation is not enabled', 'NATIVE_PRESENTATION_DISABLED');
    }],
    preHandler: [authenticate],
    config: { rateLimit: { max: LIVE_RAID.reconnectRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    const { afterRevision, waitMs, protocolVersion, cursor } = parse(z.object({
      protocolVersion: z.coerce.number().int().min(1).max(2).default(1),
      cursor: z.string().min(1).max(160).optional(),
      afterRevision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      waitMs: z.coerce.number().int().min(0).max(NATIVE_MAX_WAIT_MS).default(0),
    }).strict(), req.query);
    if (cursor && (protocolVersion !== 2 || afterRevision !== undefined || waitMs !== 0)) {
      throw new HttpError(400, 'page cursors require protocol 2 without a polling revision or wait', 'NATIVE_PAGE_INVALID');
    }
    const wallet = req.wallet;
    if (streams.size >= maxStreams || (wallets.get(wallet) ?? 0) >= 2) {
      throw new HttpError(503, 'native presentation is busy', 'NATIVE_PRESENTATION_BUSY');
    }
    const controller = new AbortController();
    streams.add(controller); wallets.set(wallet, (wallets.get(wallet) ?? 0) + 1);
    const abort = () => controller.abort();
    req.raw.once('aborted', abort); reply.raw.once('close', abort);
    const deadline = Date.now() + waitMs;
    try {
      for (;;) {
        if (controller.signal.aborted) throw new HttpError(499, 'presentation request closed');
        // Session/alpha revocation and live deed ownership must beat cache hits,
        // and must be rechecked after waiting or a slow isolated simulation.
        await authenticate(req, reply);
        const source = await loadNativePresentation(db, wallet, id);
        // Even an immutable old generation requires current live-deed or
        // archived-participant authority. Cursors are never bearer access.
        if (cursor) return pages.read(wallet, id, cursor);
        if (source.revision !== afterRevision) {
          const presentation = source.input && source.simulationKey
            ? await service.simulate(id, source.simulationKey, source.input, controller.signal) : { events: source.events };
          if (controller.signal.aborted) throw new HttpError(499, 'presentation request closed');
          await authenticate(req, reply);
          const current = await loadNativePresentation(db, wallet, id);
          if (presentation && current.revision === source.revision) {
            const envelope = { ...current.envelope, ...('buildingHealth' in presentation ? { buildingHealth: presentation.buildingHealth } : {}) };
            if (protocolVersion === 2) return pages.create(wallet, id, current.revision, envelope, presentation.events, afterRevision);
            return { ...envelope, revision: current.revision, events: presentation.events };
          }
          if (Date.now() >= deadline) {
            throw new HttpError(503, 'raid changed during presentation; retry', 'NATIVE_PRESENTATION_STALE');
          }
        } else if (Date.now() >= deadline) return reply.status(204).send();
        await delay(Math.min(NATIVE_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())), undefined, { signal: controller.signal });
      }
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError(499, 'presentation request closed');
      throw error;
    } finally {
      req.raw.removeListener('aborted', abort); reply.raw.removeListener('close', abort);
      streams.delete(controller);
      const count = (wallets.get(wallet) ?? 1) - 1;
      if (count) wallets.set(wallet, count); else wallets.delete(wallet);
    }
  });
}

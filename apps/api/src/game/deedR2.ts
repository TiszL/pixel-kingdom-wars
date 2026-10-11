/**
 * Deed metadata → Cloudflare R2 (owner 2026-07-26: the api runs on a local dev
 * box, so wallet UIs cannot fetch metadata FROM the api — publish it to a
 * public R2 bucket instead and mint deeds with the bucket URI).
 *
 * Shape: a RECONCILER, not per-mutation hooks. Every intervalMs it scans deeded
 * stable bases (legacy players while multi-base is disabled), rebuilds each
 * metadata doc (deedMetadata.ts — same builder the api
 * route serves), and PUTs only the ones whose content changed since the last
 * push (in-memory hash). Chosen over event hooks because trait-changing paths
 * are many (job completion, raids, expansions, placements) and this covers all
 * of them — including manual DB fixes — without touching game code. The scan is
 * cursor-bounded; mutation paths additionally mark deed assets dirty
 * at mutation sites and feeding the same pusher.
 *
 * Config = 5 R2_* envs (see .env.example). Any missing → disabled no-op, same
 * guard pattern as the hot wallet and the deed minter. Failures log and retry
 * on the next sweep — metadata is presentation, it must never take the api down.
 *
 * ---------------------------------------------------------------------------
 * BLAST RADIUS OF THE R2 CREDENTIALS (security review 2026-07-29)
 *
 * The api holds Object Read & Write credentials for the WHOLE bucket, and the
 * bucket is not only the deed store: it also hosts the $KEEP TOKEN's identity —
 * `keep-metadata-v3.json` and `keep-token-logo.png`, the URI written into the
 * mint. Overwriting those renames or re-skins the token everywhere it is
 * displayed, and no on-chain authority is needed to do it.
 *
 * WHAT THIS FILE GUARANTEES: it is structurally incapable of writing outside
 * its own `deed/` prefix. Every PUT goes through `assertDeedKey` (see
 * `deedScopedPutter`), which allows exactly three key shapes and nothing else —
 * so no bug, refactor or crafted wallet/asset id in this module can reach the
 * token's objects. The guard wraps the putter rather than living at the call
 * sites, so a future PUT added here inherits it by construction.
 *
 * WHAT IT DOES NOT FIX, honestly stated: the CREDENTIALS remain bucket-scoped.
 * Anything that reaches the api's environment — a shell on the box, a leaked
 * .env, an SSRF/RCE in another route — can talk to R2 directly and rewrite the
 * token's name and logo. This guard removes the accidental path, not the
 * adversarial one. The real fix is an R2 API token scoped to the `deed/` prefix
 * (Cloudflare supports prefix-scoped tokens) or a second bucket for token
 * assets, so the api's key CANNOT address them; that is a dashboard change the
 * owner makes, not code, and it is the only thing that makes the residual risk
 * zero. Until then: treat R2_SECRET_ACCESS_KEY as able to re-brand the token,
 * and keep an offline copy of the two token objects (infra/r2-staging/) so a
 * rewrite is recoverable.
 * ---------------------------------------------------------------------------
 */
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { deedJsonUri } from '@shardkeep/chain';
import type { Db } from '../db/client';
import { and, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { bases, buildings, obstacles, players } from '../db/schema';
import { renderBasePng, baseRenderAvailable, baseRenderFleetArtFingerprint } from './baseRender';
import { captureDeedFleetDrawing, deedDrawingFingerprint, deedDrawingIdentityCurrent } from './deedFleetCapture';
import { resolveBaseVisual } from './baseVisual';
import { readBoundCosmeticBase } from './boundCosmeticPresentation';
import { matchBoundCosmeticBaseRead, type BoundCosmeticBaseRead } from '@shardkeep/shared/boundCosmeticVisual';
import {
  buildDeedMetadata, buildDeedMetadataForAsset, clearDeedDirty, isDeedDirty,
} from './deedMetadata';
import { fantasyWorldEnabled, multiBaseEnabled } from '../config';
import { fantasyPublishingScope, retiredMintPublishingScope, retiredWalletPublishingScope, canPublishWalletDeedAlias } from './fantasyPublishing';
import { resolveFantasyLocation } from './fantasyLocationRead';

export interface R2Config {
  endpoint: string;      // https://<account_id>.r2.cloudflarestorage.com
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  publicBaseUrl: string; // https://pub-<hash>.r2.dev or custom domain (no trailing /)
}

/** Read R2 config from env; null (disabled) unless ALL five are present. */
export function r2ConfigFromEnv(env = process.env): R2Config | null {
  const endpoint = env['R2_ENDPOINT'];
  const accessKeyId = env['R2_ACCESS_KEY_ID'];
  const secretAccessKey = env['R2_SECRET_ACCESS_KEY'];
  const bucket = env['R2_BUCKET'];
  const publicBaseUrl = env['R2_PUBLIC_BASE_URL'];
  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket || !publicBaseUrl) return null;
  return { endpoint: endpoint.replace(/\/$/, ''), accessKeyId, secretAccessKey, bucket, publicBaseUrl: publicBaseUrl.replace(/\/$/, '') };
}

/** The public URI a deed should carry (what wallet UIs fetch). ASSET-keyed, so
 *  the URI is a property of the deed and not of whoever is holding it (F2). */
export function r2DeedUri(cfg: R2Config, assetId: string): string {
  return deedJsonUri(cfg.publicBaseUrl, assetId);
}

/** Uploader seam — the reconciler is tested against a fake; prod uses R2 SigV4. */
export type ObjectPutter = (key: string, body: string | Buffer, contentType?: string) => Promise<void>;

/**
 * EVERY object key this module is allowed to write — the four shapes the sync
 * produces and nothing else:
 *   deed/asset/<assetId>.json   the deed document (asset-keyed, the real one)
 *   deed/asset/<assetId>.png    the corresponding stable-base picture
 *   deed/<wallet>.json          the transitional wallet alias
 *   deed/<wallet>.png           the legacy single-base picture
 *
 * Enumerating SHAPES rather than testing `startsWith('deed/')` is the whole
 * point: a prefix test still permits `deed/../keep-token-logo.png`, and S3 key
 * normalization is not something this file should have to reason about. The
 * variable segment is `[A-Za-z0-9_-]` — no `.`, `/` or `%` — so a traversal
 * cannot be smuggled through a wallet or asset id, whatever the DB holds.
 *
 * It deliberately does NOT insist the id is valid base58. That would be a
 * stricter check than the security property needs, and the failure mode is
 * backwards: a real deed whose id we mis-modelled would stop syncing (a live
 * outage) to buy nothing — the escape is already impossible without a dot or a
 * slash. Constrain the blast radius, not the vocabulary.
 */
const ALLOWED_DEED_KEY = /^deed\/(asset\/)?[A-Za-z0-9_-]{1,64}\.(json|png)$/;

/** Throws unless `key` is one of the four deed objects. Exported for the test
 *  that proves the token's own metadata is unreachable from here. */
export function assertDeedKey(key: string): string {
  if (!ALLOWED_DEED_KEY.test(key)) {
    throw new Error(
      `[deed-r2] REFUSING to write "${key}": the deed sync may only write deed/asset/<id>.json, `
      + 'deed/asset/<id>.png, deed/<wallet>.json and deed/<wallet>.png. The bucket also hosts the $KEEP token metadata '
      + '(keep-metadata-v3.json / keep-token-logo.png), and this process must not be able to '
      + 'touch it even by accident.',
    );
  }
  return key;
}

/** Wrap any putter so it can only ever address deed objects. Applied to the
 *  real R2 client AND inside the sweep, so test fakes and future call sites are
 *  covered by construction rather than by remembering to call the assertion. */
export function deedScopedPutter(put: ObjectPutter): ObjectPutter {
  // `async` so a rejected key REJECTS the promise instead of throwing
  // synchronously: ObjectPutter's contract is Promise-returning, and the
  // sweep's per-deed try/catch is what turns a bad key into a logged, retried
  // failure rather than a crashed reconcile loop.
  return async (key, body, contentType) => put(assertDeedKey(key), body, contentType);
}

/** HEAD seam: "does this object already exist in the bucket?" — lets a fresh
 *  process keep pointing at a previously-published PNG instead of reverting the
 *  metadata to the placeholder when the renderer is unavailable (verify wf). */
export type ObjectHead = (key: string) => Promise<boolean>;

export function r2Head(cfg: R2Config): ObjectHead {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto',
  });
  return async (key) => {
    const res = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`, { method: 'HEAD' });
    return res.ok;
  };
}

export function r2Putter(cfg: R2Config): ObjectPutter {
  const aws = new AwsClient({
    accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, service: 's3', region: 'auto',
  });
  // Scoped at the point the CREDENTIALS are bound: this deed writer cannot
  // address anything outside deed/ — see the blast-radius note in the header.
  // playerAvatar.ts has a separate binding constrained to exact avatar/ keys;
  // neither feature widens or reuses the other's namespace guard.
  return deedScopedPutter(async (key, body, contentType = 'application/json') => {
    const res = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`, {
      method: 'PUT',
      headers: {
        'content-type': contentType,
        // Short edge/browser cache: an upgrade should show within a minute,
        // matching the api route's own cache-control story.
        'cache-control': 'public, max-age=60',
      },
      body,
    });
    if (!res.ok) throw new Error(`R2 PUT ${key}: ${res.status} ${await res.text().catch(() => '')}`);
    if (contentType === 'application/json' || contentType === 'image/png') {
      // Verify the object store's bytes before publishedDocs can advance the
      // on-chain URI. Read the signed storage endpoint, never a stale CDN URL.
      const verified = await aws.fetch(`${cfg.endpoint}/${cfg.bucket}/${key}`, {
        method: 'GET', headers: { 'cache-control': 'no-cache' },
      });
      const expected = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
      if (!verified.ok || !Buffer.from(await verified.arrayBuffer()).equals(expected)) {
        throw new Error(`R2 verification failed for ${key}; URI version remains unchanged`);
      }
    }
  });
}

/**
 * Bump when the ART a base is drawn WITH changes, so every deed re-renders.
 *
 * WHY THIS EXISTS. layoutHash below fingerprints base STATE. An art rework
 * changes no player's state, so without this every existing deed keeps its old
 * picture forever and the new art only ever appears on deeds whose owners
 * happen to move something. Batch 13 (dragon/giant/six defences, 2026-08-03)
 * redrew six buildings that appear in most bases — the deed pictures had to
 * follow, and nothing in the fingerprint would have noticed.
 *
 * It "worked" before only by accident: the seen-hashes map is per-process, so a
 * deploy restart re-rendered everything. That accident is already scheduled to
 * die — this file's own header plans dirty-marking at mutation sites for 20k
 * players, and the moment those hashes become durable (Redis / a column) an art
 * change would stop propagating with nothing failing. This makes it deliberate.
 *
 * Format: bump the number on any atlas change that alters how a base LOOKS.
 *   1  pre-batch-13 baseline
 *   2  batch 13 — archer/mage/laser towers, dragon nest, cannon, mortar redrawn
 *   3  owner 2026-09-09 — five-tier contextual timber-to-shard walls
 *   4  owner 2026-09-10 — approved eight-realm full-ground paintings
 *   5  owner 2026-09-10 — v2 terrain across the full surrounding world
 */
const BASE_ART_VERSION = 5;
// D153.225 admitted ordinary Market source; only pictures containing a Market
// change identity. Do not force an unrelated all-deed art invalidation.
const MARKET_ART_SOURCE = 'f7cbf1bf9646d31baf5d7fcd0706e85348f24c199022dde22292adb3e19f1885';

/** Layout fingerprint driving the base-IMAGE re-render: anything that changes
 *  the PICTURE (positions, levels, obstacle clears, claim growth, and the ART
 *  itself) — a strict superset of nothing-in-common with the JSON hash, which a
 *  pure MOVE never touches (same counts, same levels). Deterministic ordering
 *  via SQL sort. */
async function layoutPresentation(db: Db, wallet: string, baseId: string | undefined, deedAssetId: string) {
  const buildingScope = baseId ? eq(buildings.baseId, baseId) : eq(buildings.playerWallet, wallet);
  const obstacleScope = baseId ? eq(obstacles.baseId, baseId) : eq(obstacles.playerWallet, wallet);
  const rows = await db.select({ id: buildings.id, type: buildings.type, level: buildings.level, tx: buildings.tx, ty: buildings.ty,
    // Explicit qualification is required inside this correlated subquery:
    // Drizzle's single-table column rendering would otherwise emit bare "id".
    underConstruction: sql<boolean>`exists(select 1 from builder_jobs j where j.building_id="buildings"."id" and j.kind='build' and j.completed_at is null and j.cancelled_at is null)`,
  })
    .from(buildings).where(buildingScope).orderBy(buildings.tx, buildings.ty, buildings.type);
  if (rows.some(row => row.type === 'berth')) {
    // Discovery rows select the branch only. The packet owns every drawing
    // value and both current fleet sources under its one released transaction.
    const fingerprint = baseId ? baseRenderFleetArtFingerprint() : null;
    if (!baseId || !fingerprint) return { kind: 'unavailable' as const, requiresPublishedHash: true };
    const captured = await captureDeedFleetDrawing(db, wallet, baseId, deedAssetId, fingerprint);
    if (!captured) return { kind: 'unavailable' as const, requiresPublishedHash: true };
    const hash = createHash('sha256').update(JSON.stringify({
      a: BASE_ART_VERSION,
      ...(captured.buildings.some(row => row.type === 'market') ? { marketSource: MARKET_ART_SOURCE } : {}),
      fleetDrawing: deedDrawingFingerprint(captured),
    })).digest('hex');
    return { kind: 'captured' as const, hash, captured, requiresPublishedHash: true };
  }
  const b = rows.map(({type,level,tx,ty})=>({type,level,tx,ty}));
  const o = await db.select({ k: obstacles.spriteKey, tx: obstacles.tx, ty: obstacles.ty })
    .from(obstacles).where(and(obstacleScope, isNull(obstacles.clearedAt)))
    .orderBy(obstacles.tx, obstacles.ty);
  const [p] = baseId
    ? await db.select({ e: bases.expansions }).from(bases).where(eq(bases.id, baseId))
    : await db.select({ e: players.expansions }).from(players).where(eq(players.wallet, wallet));
  const visualContext = await resolveBaseVisual(db, baseId);
  const hasMarket = rows.some(row=>row.type==='market');
  const boundCosmetics: BoundCosmeticBaseRead = hasMarket && baseId
    ? await readBoundCosmeticBase(db,baseId,wallet)
    : {state:'available',visual:{version:1,marketAwnings:[]}};
  if(boundCosmetics.state!=='available')throw new Error('Current Market appearance source is unavailable');
  matchBoundCosmeticBaseRead(boundCosmetics,rows);
  const marketPresentation = hasMarket ? { source:MARKET_ART_SOURCE,
    construction:rows.filter(row=>row.type==='market').map(({id,underConstruction})=>({id,underConstruction})),
    visual:boundCosmetics.visual,
  } : undefined;
  const hash=createHash('sha256')
    .update(JSON.stringify({ b, o, e: p?.e ?? 0, a: BASE_ART_VERSION, visualContext, ...(marketPresentation?{marketPresentation}:{}) }))
    .digest('hex').slice(0, 8);
  return { kind: 'legacy' as const, hash, visualContext, boundCosmetics, requiresPublishedHash: hasMarket };
}

/**
 * One reconcile sweep: push every deed whose metadata JSON differs from what we
 * last pushed. Exported for tests; the interval loop just calls it.
 *
 * Keyed by DEED ASSET, not by wallet (F2). Under multi-base, iteration is over
 * `bases.deed_asset_id`, and each document/image is scoped by that stable base
 * id — so after a transfer the same object describes the buyer's conveyed base,
 * while two deeds held by one wallet still cannot share an image or document.
 * Returns the asset ids pushed (diagnostics + tests).
 */
export async function sweepDeedMetadata(
  db: Db, rawPut: ObjectPutter, lastPushed: Map<string, string>,
  opts: {
    publicBaseUrl?: string; lastImageHash?: Map<string, string>;
    /** HEAD probe + its per-process cache: lets a restarted process keep the
     *  JSON pointing at an already-published PNG when it cannot render. */
    head?: ObjectHead; pngKnown?: Map<string, boolean>;
    /** Test seam for "atlases absent" — prod always uses baseRenderAvailable(). */
    renderAvailable?: boolean;
    /** Cursor: visit only deeds ordered after this asset id. Omitted = start of
     *  the table. The scheduler advances it so no single pass is unbounded. */
    after?: string;
    /** Slice size. Defaults to SWEEP_BATCH; tests use a small value. */
    limit?: number;
    /**
     * Called for every deed VISITED, in scan order — how the scheduler advances
     * its cursor. Deliberately not the return value, which is the PUSHED list
     * and is load-bearing for existing tests: a slice where nothing changed
     * pushes nothing, and a cursor driven off that would re-scan the same rows
     * forever without ever reaching the rest of the table.
     */
    onVisit?: (assetId: string) => void;
  } = {},
): Promise<string[]> {
  // Re-scoped here as well as in r2Putter: the sweep is the thing that BUILDS
  // keys, so the guard belongs where the construction happens — that way a
  // test fake, or any future caller passing its own putter, is bounded too.
  const put = deedScopedPutter(rawPut);
  // BOUNDED SLICE, not the whole table. This scan used to be every deed in the
  // game, every 60s, with 5 DB round-trips per deed (layoutHash issues 3,
  // buildDeedMetadata 2). At 20k players that is ~100k queries per sweep against
  // a pool of 10 — the sweep stops being background reconciliation and becomes
  // the thing your players are queued behind. A cursor keeps each pass cheap and
  // still visits every deed, just across several passes.
  const stable = multiBaseEnabled();
  const rows = stable
    ? await db.select({ wallet: bases.ownerWallet, assetId: bases.deedAssetId, baseId: bases.id })
      .from(bases)
      .where(opts.after !== undefined
        ? and(isNotNull(bases.deedAssetId), gt(bases.deedAssetId, opts.after), fantasyPublishingScope())
        : and(isNotNull(bases.deedAssetId), fantasyPublishingScope()))
      .orderBy(bases.deedAssetId).limit(opts.limit ?? SWEEP_BATCH)
    : (await db.select({ wallet: players.wallet, assetId: players.deedAssetId })
      .from(players)
      .where(opts.after !== undefined
        ? and(isNotNull(players.deedAssetId), gt(players.deedAssetId, opts.after), retiredMintPublishingScope(players.deedAssetId), retiredWalletPublishingScope(players.wallet))
        : and(isNotNull(players.deedAssetId), retiredMintPublishingScope(players.deedAssetId), retiredWalletPublishingScope(players.wallet)))
      .orderBy(players.deedAssetId).limit(opts.limit ?? SWEEP_BATCH))
      .map((row) => ({ ...row, baseId: null }));
  const pushed: string[] = [];
  for (const { wallet, assetId: maybeAsset, baseId: maybeBaseId } of rows) {
    const assetId = maybeAsset!; // guaranteed by the IS NOT NULL filter
    const baseId = maybeBaseId ?? undefined;
    const imageCacheKey = baseId ?? wallet;
    const imageObjectKey = baseId ? `deed/asset/${assetId}.png` : `deed/${wallet}.png`;
    opts.onVisit?.(assetId);
    try {
      // A claimed deed changed hands: force the republish and re-probe the new
      // holder's picture (a cached "no PNG" from before they had a base would
      // otherwise leave the buyer's deed image-less until the next layout edit).
      const dirty = isDeedDirty(assetId);
      const fantasyLocation = baseId ? await resolveFantasyLocation(db, baseId) : null;
      let fantasyImageReady = !fantasyLocation;
      if (dirty) opts.pngKnown?.delete(imageCacheKey);
      // Base IMAGE first (owner 2026-07-26: the NFT pictures the actual base):
      // re-render + push the PNG when the LAYOUT changed, and bake its hash into
      // the image URL as a cache-buster — which also flows into the JSON below,
      // so a pure building MOVE (identical traits) still re-publishes metadata.
      //
      // The image leg is deliberately FIRE-WALLED from the JSON leg (verify wf):
      // a repeatable render/PUT failure must degrade the picture, never starve
      // trait updates — wallets show traits from the JSON, and that keeps
      // flowing on the last known-good image URL (or none).
      let imageUrl: string | undefined;
      if (opts.publicBaseUrl && opts.lastImageHash) {
        try {
          const presentation = await layoutPresentation(db, wallet, baseId, assetId);
          const hash = presentation.kind === 'unavailable' ? undefined : presentation.hash;
          if (presentation.kind !== 'unavailable' && (opts.renderAvailable ?? baseRenderAvailable())
            && opts.lastImageHash.get(imageCacheKey) !== hash) {
            const png = presentation.kind === 'captured'
              ? await renderBasePng(db, wallet, baseId, undefined, undefined, presentation.captured)
              : await renderBasePng(db, wallet, baseId, presentation.visualContext, presentation.boundCosmetics, null);
            if (png) {
              // No capture lock spans painting or PUT. This observes custody
              // immediately before upload; the remote PUT is not DB-atomic.
              if (presentation.kind === 'captured' && !await deedDrawingIdentityCurrent(db, presentation.captured)) {
                throw new Error('Captured deed identity changed before image publication');
              }
              await put(imageObjectKey, png, 'image/png');
              opts.lastImageHash.set(imageCacheKey, presentation.hash); // after the successful put only
              opts.pngKnown?.set(imageCacheKey, true);
            }
          }
          let havePng = opts.lastImageHash.has(imageCacheKey) || opts.pngKnown?.get(imageCacheKey) === true;
          if (!havePng && opts.head && opts.pngKnown?.get(imageCacheKey) === undefined) {
            havePng = await opts.head(imageObjectKey); // once per process per stable base / legacy wallet
            opts.pngKnown?.set(imageCacheKey, havePng);
          }
          // HEAD proves existence only. Fleet/Market pictures need the hash of
          // an actual successful PUT; old plain no-berth hashes stay compatible.
          const publishedHash = opts.lastImageHash.get(imageCacheKey);
          const imageHash = presentation.requiresPublishedHash ? publishedHash : hash;
          if (havePng && imageHash) imageUrl = `${opts.publicBaseUrl}/${imageObjectKey}?v=${imageHash}`;
          if (imageUrl && hash !== undefined && publishedHash === hash) fantasyImageReady = true;
        } catch (e) {
          console.error(`[deed-r2] image leg failed for ${assetId} (JSON continues):`, e);
          const h = opts.lastImageHash.get(imageCacheKey);
          if (h) imageUrl = `${opts.publicBaseUrl}/${imageObjectKey}?v=${h}`;
        }
      }

      // Geography and its rendered picture publish together. A stale Earth PNG
      // must never accompany the first fantasy URI or a changed terrain image.
      if (!fantasyImageReady) throw new Error('Fantasy deed image is not verified for this layout; metadata publication deferred');
      const meta = stable
        ? await buildDeedMetadataForAsset(db, assetId, imageUrl)
        : await buildDeedMetadata(db, wallet, imageUrl);
      if (!meta) continue; // deeded but unpaid should not exist; skip defensively
      const json = JSON.stringify(meta);
      if (!dirty && lastPushed.get(assetId) === json) continue; // unchanged since last push
      await put(`deed/asset/${assetId}.json`, json);
      lastPushed.set(assetId, json); // only after a SUCCESSFUL put — failures retry
      // Record the PUBLISHED bytes for the on-chain versioner. Same placement,
      // same reason: after the PUT, never before.
      publishedDocs.set(assetId, json);
      clearDeedDirty(assetId);
      pushed.push(assetId);
      // Fantasy locations publish only asset-keyed documents. A retired old
      // deed may still name a wallet alias; never overwrite that history.
      if (fantasyWorldEnabled() || meta.attributes.some(attribute => attribute.trait_type === 'Realm')
        || !await canPublishWalletDeedAlias(db, wallet)) continue;
      // TRANSITIONAL ALIAS: deeds minted before the asset-keyed scheme still
      // carry `<base>/deed/<wallet>.json` ON CHAIN until `deed:reuri` has run
      // against them, and that object must keep tracking the wallet's base in
      // the meantime. Fire-walled from the primary put like the image leg — an
      // alias failure must never stall the document the new deeds point at.
      // Safe to delete once every minted deed has been re-URI'd.
      try {
        const alias = stable ? await buildDeedMetadata(db, wallet) : meta;
        if (alias) await put(`deed/${wallet}.json`, JSON.stringify(alias));
      } catch (e) {
        console.error(`[deed-r2] legacy wallet alias failed for ${wallet} (asset doc published):`, e);
      }
    } catch (e) {
      console.error(`[deed-r2] push failed for ${assetId} (retries next sweep):`, e);
    }
  }
  return pushed;
}

// ---------------------------------------------------------------------------
// Liveness (owner 2026-08-03)
// ---------------------------------------------------------------------------

/**
 * Is the deed sync actually alive? Exposed on GET /health so staleness is
 * detectable FROM OUTSIDE, by a uptime check, rather than by a player noticing
 * their NFT is wrong — which is how the 2026-07-30 outage was found, five days
 * late (the R2_* vars were absent from the env file the container reads, and
 * the only evidence was one console.log at boot).
 *
 * THE HEALTH SIGNAL IS `lastSweepOkAt`, NOT "last push". A sweep that pushes
 * nothing because no base changed is perfectly healthy — most sweeps are. Using
 * last-push as the signal would fire constantly on a quiet game and teach
 * everyone to ignore it. What must never happen is the LOOP stopping, so the
 * loop's own heartbeat is the thing to watch.
 *
 * `stale` is computed against the real tick interval rather than a hardcoded
 * number, so it stays correct if the interval is ever tuned.
 */
export interface DeedSyncStatus {
  /** Configured AND owned by this process — i.e. this loop should be ticking. */
  running: boolean;
  /** Why not, when running is false. Null when running. */
  disabledReason: string | null;
  /** Epoch ms of the last sweep that completed without throwing. */
  lastSweepOkAt: number | null;
  /** Epoch ms of the last sweep that threw. */
  lastSweepErrorAt: number | null;
  lastError: string | null;
  /** Sweeps that have thrown in a row. Resets on any success. */
  consecutiveFailures: number;
  /** Epoch ms we last actually wrote an object (informational, NOT health). */
  lastPushAt: number | null;
  /** Objects written since boot. */
  pushedTotal: number;
  /** Nominal ms between ticks, so `stale` has a basis. */
  intervalMs: number | null;
  /** Epoch ms the loop was started here — the grace clock before the first
   *  sweep lands, so a deploy does not serve 503 on the way up. */
  startedAt: number | null;
}

const syncStatus: DeedSyncStatus = {
  running: false,
  disabledReason: 'not started',
  lastSweepOkAt: null,
  lastSweepErrorAt: null,
  lastError: null,
  consecutiveFailures: 0,
  lastPushAt: null,
  pushedTotal: 0,
  intervalMs: null,
  startedAt: null,
};

/**
 * The exact JSON last PUBLISHED for each deed asset, by the running loop.
 *
 * Exists so the on-chain URI sync can version what a wallet will actually
 * FETCH, rather than what happens to be true in the database at that instant.
 * Those are not the same thing, and the difference is the whole feature:
 *
 *   T+0s   player upgrades their Keep
 *   T+30s  chain sweep stamps ?v=<hash of the Keep-17 doc> on chain
 *   T+31s  DAS reacts, GETs the R2 object — still the Keep-15 doc, because the
 *          R2 lap has not reached this deed yet — and caches Keep 15
 *   ever    the on-chain URI already equals the Keep-17 version, so nothing
 *          ever asks DAS to look again
 *
 * That is the original stale-deed bug wearing the fix as a disguise. Ordering by
 * construction is the only robust answer: a version can only be advertised after
 * the bytes it names exist.
 *
 * In-memory and per-process, deliberately: both loops run in the same worker, a
 * restart empties it, and an empty map makes the chain sync skip rather than
 * guess — which fails in the safe direction.
 */
const publishedDocs = new Map<string, string>();

/** The document last published for `assetId`, or null if this process has not
 *  published one yet. */
export function publishedDeedDoc(assetId: string): string | null {
  return publishedDocs.get(assetId) ?? null;
}

/** Mark why the sync is not running here. Called from server boot. */
export function setDeedSyncDisabled(reason: string): void {
  syncStatus.running = false;
  syncStatus.disabledReason = reason;
  syncStatus.startedAt = null;
}

/** The loop is live on this process, ticking every `intervalMs`. */
export function markDeedSyncRunning(intervalMs: number, at = Date.now()): void {
  syncStatus.running = true;
  syncStatus.disabledReason = null;
  syncStatus.intervalMs = intervalMs;
  syncStatus.startedAt = at;
  // A restart genuinely resets the heartbeat: the previous process's last-ok
  // stamp says nothing about whether THIS one is sweeping.
  syncStatus.lastSweepOkAt = null;
}

/** A sweep completed. `pushed` may be 0 — that is the healthy common case. */
export function recordDeedSweepOk(pushed: number, at = Date.now()): void {
  syncStatus.lastSweepOkAt = at;
  syncStatus.consecutiveFailures = 0;
  syncStatus.lastError = null;
  if (pushed > 0) {
    syncStatus.lastPushAt = at;
    syncStatus.pushedTotal += pushed;
  }
}

/** A sweep threw. Does NOT clear the last-ok stamp — the loop is still alive,
 *  and repeated failures surface through consecutiveFailures/lastError. */
export function recordDeedSweepError(e: unknown, at = Date.now()): void {
  syncStatus.lastSweepErrorAt = at;
  syncStatus.lastError = e instanceof Error ? e.message : String(e);
  syncStatus.consecutiveFailures++;
}

/**
 * A snapshot for /health, with staleness derived at read time.
 *
 * `ok` is false ONLY when this process is supposed to be syncing and has
 * visibly stopped. A process that legitimately does not run the loop (an api
 * container; an unconfigured dev box) reports ok:true with a reason — otherwise
 * every developer's health check goes red and the signal becomes noise.
 */
export function deedSyncHealth(now = Date.now()): DeedSyncStatus & {
  ok: boolean; stale: boolean; ageSec: number | null;
} {
  const age = syncStatus.lastSweepOkAt === null ? null : now - syncStatus.lastSweepOkAt;
  // Four missed ticks before calling it stale: one slow sweep behind live
  // traffic must not flap the check, but ~4 minutes of silence is real.
  const limit = (syncStatus.intervalMs ?? 60_000) * 4;
  // A process that has started the loop but not yet FINISHED a sweep is measured
  // from when it started, not treated as instantly stale — otherwise every
  // deploy serves 503 until its first sweep lands, and a restart loop would look
  // like a dead sync. It still goes red if that first sweep never arrives.
  const sinceHeartbeat = age ?? (syncStatus.startedAt === null ? 0 : now - syncStatus.startedAt);
  const stale = syncStatus.running && sinceHeartbeat > limit;
  return {
    ...syncStatus,
    stale,
    ageSec: age === null ? null : Math.round(age / 1000),
    ok: !stale,
  };
}

/**
 * Deeds visited per sweep tick. 500 x ~5 DB round-trips is a few hundred
 * milliseconds — cheap enough to sit behind live traffic, large enough that even
 * 20k deeds complete a full lap in ~40 ticks (well under an hour at 60s).
 */
const SWEEP_BATCH = 500;

/**
 * Boot wiring: start the reconciler; returns a stop handle (tests/shutdown).
 *
 * Two properties this loop did not have and needed before launch:
 *
 * NON-OVERLAPPING. It was a bare setInterval over an unbounded scan. Once one
 * pass took longer than the interval — which it would, well before 20k deeds —
 * a second started on top of it, sharing the same dedupe Maps, and they piled up
 * without limit. Each holds DB connections from a pool of 10, so the failure
 * shows up as the GAME getting slow, with nothing pointing at deed metadata.
 *
 * CURSORED. Each tick walks one bounded slice and remembers where it stopped,
 * wrapping at the end. Every deed still gets visited; no single pass can be
 * expensive. A deed that genuinely changed is also marked dirty and republished
 * on its next visit, so the cursor only affects LATENCY of reconciliation, never
 * whether it happens.
 */
export function startDeedMetadataSync(db: Db, cfg: R2Config, intervalMs = 60_000): { stop(): void } {
  markDeedSyncRunning(intervalMs);
  const put = r2Putter(cfg);
  const lastPushed = new Map<string, string>();
  const lastImageHash = new Map<string, string>();
  const base = {
    publicBaseUrl: cfg.publicBaseUrl, lastImageHash,
    head: r2Head(cfg), pngKnown: new Map<string, boolean>(),
  };
  let cursor: string | undefined;
  let running = false;
  let skipped = 0;

  const pass = async (): Promise<void> => {
    if (running) {
      // Log every skip: silent skipping is how you end up believing metadata is
      // current when the sweep has not finished a lap in hours.
      if (++skipped % 10 === 1) console.warn(`[deed-r2] sweep still running, skipped ${skipped} tick(s)`);
      return;
    }
    running = true;
    try {
      let n = 0;
      let last: string | undefined;
      const pushed = await sweepDeedMetadata(db, put, lastPushed, {
        ...base,
        // Spread-in rather than `after: cursor`: exactOptionalPropertyTypes
        // distinguishes "absent" from "explicitly undefined", and absent is what
        // "start a fresh lap" means here.
        ...(cursor !== undefined ? { after: cursor } : {}),
        onVisit: (id) => { n++; last = id; },
      });
      // Advance, or wrap. A short slice means we reached the end of the table,
      // so the next tick starts a fresh lap.
      cursor = n < SWEEP_BATCH ? undefined : last;
      // Heartbeat. Stamped on every completed sweep INCLUDING one that pushed
      // nothing — "nothing changed" is the normal, healthy case, and treating it
      // as silence would put /health red on a quiet game and train everyone to
      // ignore it.
      recordDeedSweepOk(pushed.length);
    } catch (e) {
      console.error('[deed-r2] sweep failed (retries next tick):', e);
      recordDeedSweepError(e);
    } finally {
      running = false;
    }
  };

  void pass(); // immediate first slice on boot
  const timer = setInterval(() => { void pass(); }, intervalMs);
  timer.unref?.(); // never hold the process open for a presentation loop
  return { stop: () => clearInterval(timer) };
}

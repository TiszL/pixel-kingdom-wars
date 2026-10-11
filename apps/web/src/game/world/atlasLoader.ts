/**
 * On-demand loading of the per-level dragon/giant atlases (`trpdg_l<N>`).
 *
 * WHY THESE ARE NOT IN THE BOOT SET. One level of dragon + giant art is a
 * 1482×1456 @2x texture — ~8.6MB of VRAM — and there are 20 of them. Eager
 * loading all of them is ~173MB for art a given battle almost never shows: a
 * raid renders the levels actually deployed, usually one or two. So a scene
 * asks for the levels it is about to draw and waits for them.
 *
 * THE HAZARD THIS MODULE EXISTS TO CONTAIN. Textures are game-global, while a
 * request belongs to a scene that may shut down mid-transfer. Phaser's shared
 * LoaderPlugin cannot reliably retract a late staging texture after shutdown,
 * so on-demand art uses abortable byte fetches and performs exactly one final
 * TextureManager insertion. Every request is funnelled through one promise per
 * level so concurrent callers share the transfer and registration.
 *
 * WHY LOADING ON DEMAND IS ONLY HALF THE STORY (releaseUnusedAtlases). Lazy
 * loading bounds what ONE battle costs; it does nothing about a session. The
 * TextureManager is game-global and nothing ever removed a group from it, so
 * raiding across tiers accumulated monotonically. Measured from the generated
 * atlases (w×h×4, RGBA, no mips — MiB here, so the trpdg level above is the
 * same texture as the 8.2 below): a rework-v2 dragon tier is 28.1MiB, giant
 * 18.2, mortar 10.3, cannon 9.6, v2fx 15.6, a trpdg level @2x 8.2 — all 73 v2
 * groups plus all 20 trpdg levels is ~1.5GiB of live textures. The game ships
 * as an Android TWA, i.e. a WebView on 3–4GB phones, where that is a lost WebGL
 * context or an OOM kill. So scene teardown sweeps: every group THIS module
 * loaded that no surviving scene is still drawing is removed, and re-loading is
 * just another fetch. Liveness is read off the live display lists rather than
 * from bookkeeping, because the display list is the only thing that cannot lie
 * about whether evicting a group would blank a sprite on screen.
 */
import type Phaser from 'phaser';
import { deviceAtlasScale, eagerAtlasScale, trpdgGroup } from '@shardkeep/shared';
import { BUILD } from '../../lib/version';
import {
  admitAtlasCandidates, ON_DEMAND_ART_BUDGET_BYTES, type AtlasCandidate,
} from './artBudget';
import {
  sceneArtProfile, stitchAtlas, supportsLogicalAtlasUpscale,
} from './atlasTexels';

/** A stalled response must not pin the shared in-flight map for the session. */
export const ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS = 15_000;

/** Optional scheduling belongs to the requesting scene. BaseScene uses this
 * seam to keep parse/decode/texture insertion idle; Battle omits it and adopts
 * the same abortable bytes immediately. */
export interface AtlasLoadScheduling {
  beforeTextureInsert?: (() => Promise<void>) | undefined;
}

/**
 * `Phaser.Scenes.Events.SHUTDOWN`, spelled out for the same reason.
 *
 * A retreat must abort transfer/body/decode work and settle the shared promise;
 * otherwise its `inflight` entry would hand every later request the same dead
 * load for the rest of the session.
 */
const SCENE_SHUTDOWN = 'shutdown';

/**
 * In-flight loads, keyed by the TextureManager rather than the scene: textures
 * are game-global, so BaseScene and BattleScene asking for level 7 at the same
 * time must share one fetch even though they have separate loaders. Entries are
 * dropped once settled — from then on the live texture state is the authority,
 * which is what keeps this correct across an HMR reload that wipes the game.
 * Keyed by GROUP NAME since the rework-v2 groups joined the trpdg levels.
 */
interface InflightLoad {
  promise: Promise<void>;
  /** A non-deferred caller (notably BattleScene) must not inherit BaseScene's
   * interaction gate merely because both scenes share a TextureManager. */
  stitchImmediately: () => void;
}

const inflight = new WeakMap<Phaser.Textures.TextureManager, Map<string, InflightLoad>>();

/**
 * Groups THIS module has registered, with the VRAM estimate each is holding —
 * i.e. exactly the eviction candidates, and nothing else. Keyed by
 * TextureManager for the same reason `inflight` is (textures are game-global,
 * and an HMR reload brings a fresh manager with a fresh, empty set).
 *
 * The eager boot groups (BootScene's ATLAS_PREFIXES loop) never enter this map,
 * which is what makes them structurally un-evictable rather than protected by a
 * name check somebody could forget to update.
 */
const resident = new WeakMap<Phaser.Textures.TextureManager, Map<string, number>>();
/** Budget reservations shared by every scene using one global TextureManager.
 * They include in-flight groups, which `resident` cannot see yet. */
const budgetReserved = new WeakMap<Phaser.Textures.TextureManager, Set<string>>();
/** Non-sprite dependencies (projectile/effect sheets) held by live controllers. */
const retained = new WeakMap<Phaser.Textures.TextureManager, Map<string, number>>();

export function retainAtlasGroups(scene: Phaser.Scene, groups: Iterable<string>): () => void {
  let counts = retained.get(scene.textures);
  if (!counts) { counts = new Map(); retained.set(scene.textures, counts); }
  const held = [...new Set(groups)];
  for (const group of held) counts.set(group, (counts.get(group) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const group of held) {
      const next = (counts!.get(group) ?? 1) - 1;
      if (next > 0) counts!.set(group, next); else counts!.delete(group);
    }
  };
}

/** Exact current on-demand residency, measured from the registered textures. */
export function onDemandAtlasState(scene: Phaser.Scene): { bytes: number; groups: Set<string> } {
  const byGroup = resident.get(scene.textures);
  return {
    bytes: byGroup ? sum(byGroup) : 0,
    groups: new Set(byGroup?.keys() ?? []),
  };
}

/**
 * Atomically admit candidates against the game-global resident + in-flight
 * ledger. BaseScene and BattleScene have separate loaders but one texture
 * manager; a scene-local reservation lets both spend the same free bytes.
 */
export function admitOnDemandAtlasCandidates(
  scene: Phaser.Scene,
  atlasBytes: Readonly<Record<string, number>>,
  candidates: readonly AtlasCandidate[],
  budgetBytes = ON_DEMAND_ART_BUDGET_BYTES,
): Set<string> {
  const state = onDemandAtlasState(scene);
  const current = budgetReserved.get(scene.textures) ?? new Set<string>();
  const admission = admitAtlasCandidates(
    atlasBytes,
    state.bytes,
    state.groups,
    current,
    candidates,
    budgetBytes,
  );
  budgetReserved.set(scene.textures, admission.reservedGroups);
  return admission.accepted;
}

/** Release completed/failed reservations; resident textures remain accounted
 * by their measured bytes until an eviction function removes them. */
export function releaseAtlasReservations(scene: Phaser.Scene, groups: Iterable<string>): void {
  const reserved = budgetReserved.get(scene.textures);
  if (!reserved) return;
  for (const group of groups) reserved.delete(group);
}

/** Is this level's dragon/giant art already registered and drawable? */
export function isTroopLevelAtlasLoaded(scene: Phaser.Scene, level: number): boolean {
  return scene.textures.exists(trpdgGroup(level));
}

/** Is a rework-v2 atlas group (`v2trp_giant_t2`, `v2bld_cannon_t1`, `v2fx`)
 *  registered and drawable? Same authority as the trpdg gate: live texture
 *  state, never a promise. */
export function isV2AtlasLoaded(scene: Phaser.Scene, group: string): boolean {
  return scene.textures.exists(group);
}

/**
 * Load the `trpdg_l<N>` atlas for every given level, resolving once all of them
 * are registered and their frames are drawable. Idempotent and safe to call
 * concurrently. Rejects if a level's image or JSON did not arrive — callers
 * gate rendering on this, so it must never resolve on missing art, and must
 * never sit there un-settled either.
 */
export function ensureTroopLevelAtlases(
  scene: Phaser.Scene,
  levels: Iterable<number>,
): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const level of new Set(levels)) {
    if (!isTroopLevelAtlasLoaded(scene, level)) {
      // trpdg groups are packed at both scales. Constrained WebGL sessions use
      // @1x source texels but retain the @2x logical frame space, exactly like
      // BootScene's eager historical groups.
      const group = trpdgGroup(level);
      const logicalScale = eagerAtlasScale(group);
      const fileScale = supportsLogicalAtlasUpscale(scene)
        ? deviceAtlasScale(group, sceneArtProfile(scene))
        : logicalScale;
      pending.push(loadGroup(scene, group, `${fileScale}x`, logicalScale / fileScale));
    }
  }
  return Promise.all(pending).then(() => undefined);
}

/**
 * Load rework-v2 atlas groups on demand. Same funnel, same hazards, one
 * difference: the v2 pack is packed at @1x ONLY — the art is authored at its
 * final pixel size and an @2x set would blow the packer's 4096² texture cap —
 * so requesting `@2x` here would 404 into a batch that "completes" with a
 * failed file and a group that can never draw.
 */
export function ensureV2Atlases(
  scene: Phaser.Scene,
  groups: Iterable<string>,
  scheduling?: AtlasLoadScheduling,
): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const group of new Set(groups)) {
    if (!isV2AtlasLoaded(scene, group)) {
      pending.push(loadGroup(scene, group, '1x', 1, scheduling));
    }
  }
  return Promise.all(pending).then(() => undefined);
}

/**
 * Release every on-demand group no surviving scene is still drawing, and return
 * the VRAM estimate reclaimed. Called from a scene's SHUTDOWN handler with that
 * scene as `closing` — a raid's attacker tiers, its `v2fx` and the defender's
 * cannon/mortar tiers are dead art the moment the battle scene stops, while the
 * base's own garrison and towers must survive untouched (BaseScene only SLEEPS
 * during a raid, so its display list — and therefore its claim on those groups —
 * is intact).
 *
 * THE PREDICATE IS "IS A SPRITE USING IT", not "did somebody ask for it". Every
 * caller in the codebase already re-checks `isV2AtlasLoaded` / a live texture
 * before it keys a sprite (BaseScene.spriteKeyFor, the patrol resolver,
 * adoptV2Defenses), so an evicted group simply re-loads on the next render. A
 * sprite that is ALREADY keyed to a group is the one thing that cannot recover —
 * Phaser swaps in the missing-texture placeholder without an error — so those
 * groups are the ones this must never take.
 *
 * `closing` is deliberately EXCLUDED from the liveness scan: its own sprites are
 * being destroyed as part of the same shutdown, and whether the DisplayList
 * plugin has cleared itself before or after our SHUTDOWN listener runs is an
 * ordering detail no correctness should hang on.
 *
 * Only ever called at scene teardown, never mid-battle: BattleScene freezes
 * each family's art at its first functional event, so a group evicted mid-raid
 * could still be referenced by a later actor from that family.
 */
export function releaseUnusedAtlases(closing: Phaser.Scene): number {
  return sweepUnusedAtlases(closing, closing);
}

/**
 * Reclaim on-demand textures that NO live scene draws while keeping `scene`
 * itself in the liveness scan. BaseScene uses this after suspending its patrol
 * for a raid: garrison atlases can go, but a cannon/mortar still visible in the
 * sleeping base must remain registered for the return transition.
 */
export function releaseUnreferencedAtlases(scene: Phaser.Scene): number {
  return sweepUnusedAtlases(scene, null);
}

/**
 * Reclaim only an explicit set of completed-but-ungranted groups. Live sprites
 * in any scene still protect their texture. Unlike the broad sweep, callers
 * can omit shared dependency sheets (notably v2fx) that an adopted controller
 * may need on its next event even while no effect sprite is currently alive.
 */
export function releaseAtlasGroups(scene: Phaser.Scene, groups: Iterable<string>): number {
  const byGroup = resident.get(scene.textures);
  if (!byGroup || byGroup.size === 0) return 0;
  const live = liveTextureKeys(scene, null);
  const held = retained.get(scene.textures);
  const dropped: string[] = [];
  let bytes = 0;
  for (const group of new Set(groups)) {
    if (live.has(group) || (held?.get(group) ?? 0) > 0) continue;
    const size = byGroup.get(group);
    if (size === undefined) continue;
    scene.textures.remove(group);
    byGroup.delete(group);
    budgetReserved.get(scene.textures)?.delete(group);
    dropped.push(group);
    bytes += size;
  }
  if (dropped.length > 0) logSweep(dropped, bytes, byGroup);
  return bytes;
}

function sweepUnusedAtlases(scene: Phaser.Scene, closing: Phaser.Scene | null): number {
  const byGroup = resident.get(scene.textures);
  if (!byGroup || byGroup.size === 0) return 0;
  const live = liveTextureKeys(scene, closing);
  const held = retained.get(scene.textures);
  const dropped: string[] = [];
  let bytes = 0;
  for (const [group, size] of byGroup) {
    if (live.has(group) || (held?.get(group) ?? 0) > 0) continue;
    scene.textures.remove(group);
    byGroup.delete(group);
    budgetReserved.get(scene.textures)?.delete(group);
    dropped.push(group);
    bytes += size;
  }
  if (dropped.length > 0) logSweep(dropped, bytes, byGroup);
  return bytes;
}

function logSweep(dropped: string[], bytes: number, byGroup: Map<string, number>): void {
  // One line per sweep, in BootScene's measurement style — the whole point of
  // this mechanism is invisible in the field unless it says what it took.
  console.info(
    `[atlas] evicted ${dropped.length} on-demand group(s), ~${mib(bytes)}MiB reclaimed`
    + ` (${dropped.join(', ')}); ${byGroup.size} resident ~${mib(sum(byGroup))}MiB`,
  );
}

/** Texture keys any sprite in any OTHER scene is currently drawing with. */
function liveTextureKeys(scene: Phaser.Scene, excluded: Phaser.Scene | null): Set<string> {
  const keys = new Set<string>();
  const manager = (scene.game as { scene?: { scenes?: unknown[] } } | undefined)?.scene;
  for (const other of (manager?.scenes ?? []) as Phaser.Scene[]) {
    if (other === excluded) continue;
    // A SLEEPING scene keeps its children (that is the base during a raid), and a
    // shut-down one has none, so scene state needs no filtering here.
    collectTextureKeys((other as { children?: { list?: unknown[] } }).children?.list, keys);
  }
  return keys;
}

function collectTextureKeys(list: unknown[] | undefined, out: Set<string>): void {
  for (const obj of list ?? []) {
    const o = obj as { texture?: { key?: unknown }; list?: unknown };
    if (typeof o.texture?.key === 'string') out.add(o.texture.key);
    // Containers hold their children off the scene's own list — the v2 breath
    // stream is one (game/v2/breath.ts), and it is made of v2fx frames.
    if (Array.isArray(o.list)) collectTextureKeys(o.list, out);
  }
}

/** RGBA bytes the group's texture occupies (no mips — Phaser does not build any
 *  for atlases). Best-effort: an unreadable source reports 0 rather than lying.
 *  Exported so the diagnostics overlay (lib/perfDiag.ts, D-101) reports the
 *  same residency number the budget here is enforced against. */
export function textureBytes(
  textures: Pick<Phaser.Textures.TextureManager, 'get'>, group: string,
): number {
  const src = (textures.get(group) as { source?: { width?: number; height?: number }[] })
    .source?.[0];
  const w = src?.width ?? 0;
  const h = src?.height ?? 0;
  return w * h * 4;
}

function sum(byGroup: Map<string, number>): number {
  let total = 0;
  for (const bytes of byGroup.values()) total += bytes;
  return total;
}

const mib = (bytes: number): string => (bytes / (1024 * 1024)).toFixed(1);

/** Staging keys are never renderable assets. A failed Phaser load may have
 * inserted exactly one half before shutdown; carrying it into the byte-path
 * retry wastes VRAM/cache and can leave a large atlas resident twice. */
function clearStagingPair(scene: Phaser.Scene, group: string): void {
  const imageKey = `${group}-img`;
  if (scene.textures.exists(imageKey)) scene.textures.remove(imageKey);
  scene.cache.json.remove(`${group}-json`);
}

function loadGroup(
  scene: Phaser.Scene,
  group: string,
  scale: '1x' | '2x',
  texelStep: number,
  scheduling?: AtlasLoadScheduling,
): Promise<void> {
  let byGroup = inflight.get(scene.textures);
  if (!byGroup) {
    byGroup = new Map();
    inflight.set(scene.textures, byGroup);
  }
  const running = byGroup.get(group);
  if (running) {
    if (!scheduling?.beforeTextureInsert) running.stitchImmediately();
    return running.promise;
  }
  clearStagingPair(scene, group);

  const load = loadGroupFromBytes(
    scene, group, scale, texelStep, scheduling?.beforeTextureInsert,
  );
  byGroup.set(group, load);
  void load.promise.finally(() => {
    if (byGroup.get(group) === load) byGroup.delete(group);
  }).catch(() => undefined);
  return load.promise;
}

interface AtlasJson {
  textures?: Array<{ frames?: unknown[] }>;
}

/** Decode a fetched PNG without registering Phaser's `<group>-img` staging
 * texture. The decoded DOM image remains usable after its blob URL is revoked. */
async function decodeAtlasImage(blob: Blob, signal: AbortSignal): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  const image = new Image();
  let rejectAbort!: (cause: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => {
    image.onload = null;
    image.onerror = null;
    image.src = '';
    rejectAbort(new Error('atlas image decode aborted'));
  };
  try {
    if (signal.aborted) throw new Error('atlas image decode aborted');
    signal.addEventListener('abort', onAbort, { once: true });
    let decoded: Promise<void>;
    if (typeof image.decode === 'function') {
      image.src = url;
      decoded = image.decode();
    } else {
      decoded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error('atlas image failed to decode'));
        image.src = url;
      });
    }
    await Promise.race([decoded, aborted]);
    return image;
  } finally {
    signal.removeEventListener('abort', onAbort);
    image.onload = null;
    image.onerror = null;
    URL.revokeObjectURL(url);
  }
}

/** Network transfer may overlap a gesture because it holds inert bytes. Base
 * gates parse/decode and the first TextureManager/GPU insertion independently;
 * an immediate Battle/troop caller releases either gate without duplicating the
 * fetch. No path uses Phaser staging textures, whose late completion cannot be
 * canceled reliably after a Scene LoaderPlugin shuts down. */
function loadGroupFromBytes(
  scene: Phaser.Scene,
  group: string,
  scale: '1x' | '2x',
  texelStep: number,
  beforeTextureInsert?: (() => Promise<void>) | undefined,
): InflightLoad {
  const controller = new AbortController();
  let immediate = beforeTextureInsert === undefined;
  let releaseImmediate!: () => void;
  const immediateRequested = new Promise<void>((resolve) => { releaseImmediate = resolve; });
  let settled = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;

  const promise = new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      scene.events.off(SCENE_SHUTDOWN, onShutdown);
      if (timeout !== undefined) clearTimeout(timeout);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (cause: unknown): void => {
      if (settled) return;
      settled = true;
      controller.abort();
      cleanup();
      reject(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const onShutdown = (): void => {
      fail(new Error(`atlas ${group} abandoned — scene shut down mid-load`));
    };
    const waitUntilInsertAllowed = async (): Promise<void> => {
      if (immediate) return;
      await Promise.race([beforeTextureInsert!(), immediateRequested]);
    };

    const fetchAtlasPart = async (url: string): Promise<Response> => {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`atlas ${group} failed to load`);
      return response;
    };

    scene.events.once(SCENE_SHUTDOWN, onShutdown);
    timeout = setTimeout(() => {
      fail(new Error(`atlas ${group} timed out`));
    }, ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS);
    const suffix = `?v=${BUILD.gitSha}`;
    void (async () => {
      const [imageResponse, jsonResponse] = await Promise.all([
        fetchAtlasPart(`/atlas/${group}@${scale}.png${suffix}`),
        fetchAtlasPart(`/atlas/${group}@${scale}.json${suffix}`),
      ]);
      if (settled) return;
      const [blob, jsonBlob] = await Promise.all([
        imageResponse.blob(), jsonResponse.blob(),
      ]);
      if (settled) return;
      const jsonText = await jsonBlob.text();
      if (settled) return;
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      await waitUntilInsertAllowed();
      if (settled) return;
      const data = JSON.parse(jsonText) as AtlasJson;
      const frames = data.textures?.[0]?.frames;
      if (!frames) throw new Error(`atlas ${group} failed to load`);
      timeout = setTimeout(() => {
        fail(new Error(`atlas ${group} timed out during decode`));
      }, ON_DEMAND_ATLAS_LOAD_TIMEOUT_MS);
      const image = await decodeAtlasImage(blob, controller.signal);
      if (timeout !== undefined) clearTimeout(timeout);
      timeout = undefined;
      // A new gesture can begin while decode is off-thread. Re-check directly
      // before addAtlas, the first operation that can allocate/upload a texture.
      await waitUntilInsertAllowed();
      if (settled) return;
      clearStagingPair(scene, group);
      registerAtlas(scene, group, image, frames, texelStep);
      succeed();
    })().catch(fail);
  });

  return {
    promise,
    stitchImmediately: () => {
      immediate = true;
      releaseImmediate();
    },
  };
}

function registerAtlas(
  scene: Phaser.Scene,
  group: string,
  image: HTMLImageElement,
  frames: unknown[],
  texelStep: number,
): void {
  stitchAtlas(scene, group, image, frames, texelStep);
  // Registered on-demand ⇒ evictable, and its size is measured HERE (from the
  // texture that actually landed) rather than tabulated somewhere that could
  // drift from the atlases the pipeline emits.
  let byGroup = resident.get(scene.textures);
  if (!byGroup) {
    byGroup = new Map();
    resident.set(scene.textures, byGroup);
  }
  byGroup.set(group, textureBytes(scene.textures, group));
}

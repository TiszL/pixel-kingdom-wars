import { BASE_GROUND_GEOMETRY, BASE_GROUND_WORLD_GEOMETRY } from './constants';

/** Small presentation contract. Never import the world catalog or feed this
 * into simulation snapshots. A replay without frozen visual context depicts
 * Crownlands, regardless of its participants' later location or ownership. */
export const REALM_IDS = [
  'frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach',
  'stormcairn', 'thornwake', 'cinderfall',
] as const;
export type RealmId = typeof REALM_IDS[number];
export const REALM_NAMES: Record<RealmId, string> = {
  frostveil: 'Frostveil', elderwood: 'Elderwood', sunscar: 'Sunscar', crownlands: 'Crownlands',
  'seeker-reach': 'Solana Reach', stormcairn: 'Stormcairn', thornwake: 'Thornwake', cinderfall: 'Cinderfall',
};
export interface BaseVisualContext { version: 1; realmId: RealmId; artVersion: 1 | 2; groundRevision?: 1 | 2 | 3 | 4 | 5 }
export const DEFAULT_BASE_VISUAL: Readonly<BaseVisualContext> = Object.freeze({
  version: 1, realmId: 'crownlands', artVersion: 1,
});
/** The accepted layered revision a realm presents unless
 * CURRENT_LAYERED_REVISION_BY_REALM lists a newer one for it. */
const ACCEPTED_LAYERED_REVISION = 3 as const;
/** Owner-reviewed revision 4 realms. Thornwake piloted on 2026-09-16 (D-137); the
 * owner then asked for the same layered treatment on all eight realms so every
 * base frames its 50×50 clearing without a finite painting edge (D-138). A listed
 * realm needs its pinned BASE_LAYERED_GROUND_V4 descriptor and matching client
 * content; an unlisted realm would keep the accepted revision 3 painting. Frozen
 * replay and archive contexts never consult this table. Revision 5 (the realm
 * environment kit, docs/REALM-KIT-PLAN.md, D-173) is the current revision in every
 * realm since the owner's flip order of 2026-09-26 ("Flip it"; D-175 accepted all
 * eight kits, M45 "Later — the revision-5 flip"). Code-25 store clients draw the
 * kit obstacle rows as legacy tier art on revision-4 ground (M45 F2 / K-186). */
export const CURRENT_LAYERED_REVISION_BY_REALM: Readonly<Partial<Record<RealmId, 3 | 4 | 5>>> = Object.freeze({
  frostveil: 5, elderwood: 5, sunscar: 5, crownlands: 5, 'seeker-reach': 5, stormcairn: 5, thornwake: 5, cinderfall: 5,
});
/** The current Crownlands scenery — what a raid stamps when it has no realm of its
 * own (apps/api raids.ts). It follows the activation table, so it moved from
 * revision 3 to 4 with D-138; contexts already frozen on raids keep their own
 * revision, whose descriptors stay published. */
export const CURRENT_BASE_VISUAL: Readonly<BaseVisualContext> = Object.freeze({
  version: 1, realmId: 'crownlands', artVersion: 2, groundRevision: CURRENT_LAYERED_REVISION_BY_REALM.crownlands ?? ACCEPTED_LAYERED_REVISION,
});
export function isRealmId(value: unknown): value is RealmId {
  return typeof value === 'string' && (REALM_IDS as readonly string[]).includes(value);
}
function hasBaseVisualFields(value: unknown): value is BaseVisualContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<BaseVisualContext>;
  return candidate.version === 1 && (candidate.artVersion === 1 || candidate.artVersion === 2)
    && isRealmId(candidate.realmId);
}
export function isBaseVisualContext(value: unknown): value is BaseVisualContext {
  if (!hasBaseVisualFields(value)) return false;
  return value.groundRevision === undefined || (value.artVersion === 2
    && (value.groundRevision === 2 || (value.groundRevision === 1 && value.realmId === 'crownlands')
      || value.groundRevision === 3 || value.groundRevision === 4 || value.groundRevision === 5));
}
/** The ground revision a server context carries when THIS bundle cannot draw it:
 * a positive integer revision that no realm admits here, i.e. scenery newer than
 * this build. resolveBaseVisualContext drops it and the scene paints the frozen v2
 * ground, which is how a stale tab showed the owner "old realms" after the
 * revision-5 flip (2026-09-26). A supported revision, a malformed value or an
 * admitted revision on the wrong realm answers undefined: a reload cannot fix
 * those, and the caller answers this with a reload prompt. */
export function unsupportedGroundRevision(value: unknown): number | undefined {
  if (!hasBaseVisualFields(value) || value.artVersion !== 2) return undefined;
  const revision: unknown = value.groundRevision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) return undefined;
  // Crownlands admits every revision this bundle draws (1 is its own), so a
  // revision it refuses is newer than this bundle in every realm.
  return isBaseVisualContext({ ...value, realmId: 'crownlands' }) ? undefined : revision;
}
/** Both immutable layered revisions use explicit manifest readers. Revision 5
 * shares the layered family's registry but not these readers (see below). */
export function isLayeredBaseVisualContext(value: BaseVisualContext): value is BaseVisualContext & { artVersion: 2; groundRevision: 3 | 4 } {
  return value.artVersion === 2 && (value.groundRevision === 3 || value.groundRevision === 4);
}
/** The tile-based realm environment kit (docs/REALM-KIT-PLAN.md E-2, D-173):
 * schemaVersion 3 manifests read by `@shardkeep/shared/realmKit`, never by the
 * r3/r4 painting readers or the historical raster path. */
export function isRealmKitBaseVisualContext(value: BaseVisualContext): value is BaseVisualContext & { artVersion: 2; groundRevision: 5 } {
  return value.artVersion === 2 && value.groundRevision === 5;
}
export function resolveBaseVisualContext(value?: unknown): BaseVisualContext {
  if (!hasBaseVisualFields(value)) return { ...DEFAULT_BASE_VISUAL };
  // Additive revisions preserve the three-field v2 contract. Older clients
  // already drop the new field, retaining their exact v2 source. Unknown
  // revisions likewise fall back to that known realm/generation, never v1.
  const resolved: BaseVisualContext = { version: 1, realmId: value.realmId, artVersion: value.artVersion };
  if (isBaseVisualContext(value) && value.groundRevision !== undefined) resolved.groundRevision = value.groundRevision;
  return resolved;
}
/** Select the approved current scenery without rebinding any frozen context. */
export function currentBaseVisualForRealm(realmId: RealmId = 'crownlands'): BaseVisualContext {
  return { ...CURRENT_BASE_VISUAL, realmId, groundRevision: CURRENT_LAYERED_REVISION_BY_REALM[realmId] ?? ACCEPTED_LAYERED_REVISION };
}

/** The accepted campaign presentation has ten existing acts across four
 * realms. Act identity comes from the server's campaign catalog; it changes
 * only the scenery, never stage IDs, formations, rewards or simulation input. */
export function campaignBaseVisualForAct(act: number): BaseVisualContext {
  const realmByAct: readonly RealmId[] = [
    'crownlands', 'crownlands', 'elderwood', 'elderwood', 'sunscar', 'sunscar',
    'frostveil', 'frostveil', 'crownlands', 'frostveil',
  ];
  return currentBaseVisualForRealm(realmByAct[act - 1] ?? 'crownlands');
}

/** Immutable art facts, not gameplay geometry. Each approved 320px painting
 * covers the full 30-tile plot once at native 32px tile spacing. Outskirts fade
 * to the same material; image coordinates never wrap, rotate or mirror. */
export const BASE_GROUND_ART = {
  sourceSize: 320, ...BASE_GROUND_GEOMETRY,
  worldOriginTiles: 0, worldTiles: BASE_GROUND_GEOMETRY.plotTiles,
  sources: {
    frostveil: { color: '#a9bec1', sha256: '86cd1154010c41c452e457f69d33ad3938d51648402c231f4780fea98bea13d4' },
    elderwood: { color: '#51684a', sha256: 'f792d8a4d84e8307b7ca680861d63406cbccf34411fbdf2eff4a40e30b27eae2' },
    sunscar: { color: '#b89966', sha256: '3d67df10603a77329eda8c24da4214bde7f8922421ba75fd6f4cea6f4067937a' },
    crownlands: { color: '#62764d', sha256: 'a4814fb969d855efe924943f8a34f06542b2630378760056f27352abe654bef1' },
    'seeker-reach': { color: '#777081', sha256: '93f5fbf4caccdf33f7d5a38c3901a980771ae4bb53c08af39051c57cc4d861a0' },
    stormcairn: { color: '#788384', sha256: '80825bf22686044cabf2f8c4bd79d52b434ed861694880afdac76fcd539d5b88' },
    thornwake: { color: '#536e62', sha256: 'c749302fd7f94f89f178cea8e3a27d9db091b496a6e0fd0510fa491be7a9a5c1' },
    cinderfall: { color: '#746c64', sha256: '6d3c435ef0a14fda6980c506357152be343ecff2e319e1518e94c6e0c02d12dc' },
  },
} as const;
/** New source generation, never a replacement for frozen v1 art. Source PNG
 * hashes must match the accepted pack before either client or deed can load it. */
export const BASE_GROUND_ART_V2 = {
  sourceSize: 1536, ...BASE_GROUND_WORLD_GEOMETRY,
  sources: {
    frostveil: { color: '#a9bec1', sha256: '86df6a83a9ba069b1a64f0fc754470b870ea92f84b29eb36c6f65fede23a5983' },
    elderwood: { color: '#51684a', sha256: 'd8dad39a1c95fbef7eb53bcea38fa0c3a192f6880f659b58072cf68b8bc450d2' },
    sunscar: { color: '#b89966', sha256: '466af802750cc02299e140dc46f0a5a91e79384802109a6cc0f6306f3df0b687' },
    crownlands: { color: '#62764d', sha256: '85c9b58c9c1de5b7d5b9333201d6872884ba6959769c24b3260b49818902d022' },
    'seeker-reach': { color: '#777081', sha256: 'b5b63110eab3849f3292801b9ee25984d44ff22e844057acb3311794c4d15f45' },
    stormcairn: { color: '#788384', sha256: '9ee40a604c0bff45a072078b07a1e040c11ee54c5c5f180f496f96cc0d3866c0' },
    thornwake: { color: '#536e62', sha256: 'a75bbf48f318d78bc378ab950b995364baa75e6baa47a03688567aceeb6f8acb' },
    cinderfall: { color: '#746c64', sha256: '423cae471a19b3502e7843329296edc2e72583c4ddf217c53fa379e7c0dd4eef' },
  },
} as const;
/** Localized Crownlands clearing correction. Frozen v2 replay pixels remain
 * immutable; the other seven sources are not replaced or republished. */
export const BASE_GROUND_ART_V3 = {
  ...BASE_GROUND_ART_V2,
  sources: {
    ...BASE_GROUND_ART_V2.sources,
    crownlands: { color: '#62764d', sha256: '74858534854326f8042f718ce91a74449b758d31597130330d05bfa1fce3eb96' },
  },
} as const;
/** Rejected September15 study sources, retained for reproducible review only.
 * No live selector may admit these as the accepted environment. */
export const BASE_GROUND_ART_V4 = {
  sourceSize: 1536, ...BASE_GROUND_WORLD_GEOMETRY,
  sources: {
    'crownlands': { color: '#7d7744', sha256: '59c8dac481110edee505a6ce54aec63178a64537297339f4a4967a01e99cd7f6' },
    'thornwake': { color: '#668052', sha256: '94b47fe2fad7858925f48e3bad70152229323fd81307d07f9afe37ab24a87f03' },
    'frostveil': { color: '#daeff9', sha256: 'e5d2df40cdd7eab3fd12bd3bfa4335fe9429e365d67eaf3116460252447e1716' },
    'elderwood': { color: '#5c753f', sha256: '794a9772dce222e8d83ee2f8a6c234fd124162a58355b16e459780f692656dde' },
    'sunscar': { color: '#f9d796', sha256: '7c28980b8c495d452c393fc9c7f11f0b3d4b6fa21bf9ac2734766edc3df1ba5c' },
    'seeker-reach': { color: '#7f647a', sha256: 'e51702fc34250c3852a4545083c916278bb265e478774228e1db12181d5b03e6' },
    'stormcairn': { color: '#7b7d70', sha256: '404b105f014c2282250608ba97ca4a9c67c6fdc4f85c9c82e9ca115eb4043a3f' },
    'cinderfall': { color: '#75625c', sha256: '1f2880d89f117883a3a9a9f3e7e6c6f86d567451ca8525a8cd67b059a346451c' },
  },
} as const;
export function baseGroundArt(context?: unknown): typeof BASE_GROUND_ART | typeof BASE_GROUND_ART_V2 | typeof BASE_GROUND_ART_V3 | typeof BASE_GROUND_ART_V4 {
  const resolved = resolveBaseVisualContext(context);
  if (isLayeredBaseVisualContext(resolved) || isRealmKitBaseVisualContext(resolved)) throw new Error('Layered ground revision requires its versioned manifest renderer');
  return resolved.groundRevision === 2 ? BASE_GROUND_ART_V4 : resolved.groundRevision === 1 ? BASE_GROUND_ART_V3 : resolved.artVersion === 2 ? BASE_GROUND_ART_V2 : BASE_GROUND_ART;
}
/** Transport representation only: canonical PNG identity and frozen visual
 * context stay unchanged. The asset build proves exact decoded RGBA parity. */
const GROUND_WEBP_SHA256: Record<RealmId, string> = {
    'frostveil': 'a6f40274df2c46eb4fecc5354433b4e4ce061d8076765ad80a476b1dccb2f1aa',
    'elderwood': '3498bd6064f24d486ec615c1bff7286d2f46fe0d92718db7f2e0dc726fd5fa8a',
    'sunscar': '79885fe5b3c8ea9674f03eaa889f33f8b98998c1e24b88e27d33fd22b56c6083',
    'crownlands': '353ec9a2391308d43257ec8c323340099a3d16998a7d3228256b3f6fd100a66e',
    'seeker-reach': '747dacb99ee5980d2ae2c2ee4945b5b4a4d487b8c9e06f3bc42762049ba7803a',
    'stormcairn': '1c2934d6c94c5ec7b15123cefb9d7425445f7a44f5fe7aaacb71b4e273ef5dc4',
    'thornwake': 'a889b44f47400663a8f5ff88a1634463c8702595b22583d83693cc234ce7248f',
    'cinderfall': 'b8eee6027a8c1af3673ef9f301411a4951054add2be06fad6ab31d29c78d6ea5',
};
const GROUND_V4_WEBP_SHA256: Record<RealmId, string> = {
  'crownlands': '59b8284c80b44fb10fe74b529cc095bd8f9751d1375daf38b5b10c6a186d69d6',
  'thornwake': '758590d738a1d4b5baab978b8eedc6c6b6d34e90ead225703e9bb6e64338240e',
  'frostveil': 'eab9c0c19a18325160e929a9e961b9bf3fb5a2972b623c4208831c65a7cd5f03',
  'elderwood': '1a15302a68a1860dedb7778f936f183b0599828fc5bf9231f6895eac69327b62',
  'sunscar': '0c49827e8b33cdf3ed183d2f42024db8106cdc4d8eee10055c3948d4060cf506',
  'seeker-reach': 'd2c5295b6ecc85c334039add2da303225d70f8ca48f4f58031649e0da31aa132',
  'stormcairn': 'c76cd1266fed91b4dab98116d67a8ac59384d451cef7e5324f3f3267e23ddc07',
  'cinderfall': '5d2f4f1a3b0649c890557441e73e32cdb94c6bbef9e11527979b5ff2ab8a8a17',
};
export function baseGroundTransport(context?: unknown): { path: string; sha256: string; mime: 'image/png' | 'image/webp' } {
  const resolved = resolveBaseVisualContext(context);
  if (resolved.groundRevision === 2) {
    return { path: `/atlas/fantasy/ground-v4/${resolved.realmId}.webp`,
      sha256: GROUND_V4_WEBP_SHA256[resolved.realmId], mime: 'image/webp' };
  }
  if (resolved.artVersion === 2 && resolved.groundRevision === undefined) {
    return { path: `/atlas/fantasy/ground-v2/${resolved.realmId}.webp`,
      sha256: GROUND_WEBP_SHA256[resolved.realmId], mime: 'image/webp' };
  }
  return { path: baseGroundPath(resolved), sha256: baseGroundArt(resolved).sources[resolved.realmId].sha256, mime: 'image/png' };
}
export interface GroundPixels { data: Uint8Array | Uint8ClampedArray; width: number; height: number }
export function baseGroundPath(context?: unknown): string {
  const resolved = resolveBaseVisualContext(context);
  if (isLayeredBaseVisualContext(resolved) || isRealmKitBaseVisualContext(resolved)) throw new Error('Layered ground revision requires its versioned manifest renderer');
  const folder = resolved.groundRevision === 2 ? 'ground-v4' : resolved.groundRevision === 1 ? 'ground-v3' : resolved.artVersion === 2 ? 'ground-v2' : 'ground';
  return `/atlas/fantasy/${folder}/${resolved.realmId}.png`;
}
export function assertGroundSource(source: GroundPixels, context?: unknown): void {
  const size = baseGroundArt(context).sourceSize;
  if (source.width !== size || source.height !== size || source.data.length !== size * size * 4) {
    throw new Error(`Fantasy ground must be complete ${size}×${size} RGBA artwork`);
  }
}
/** World coordinates are native game pixels (Phaser world pixels / 2).
 * Crop callers pass their real world origin: claim expansion cannot move or
 * stretch the painting and a deed crop matches the same square in Phaser. */
export function renderGroundPixels(
  source: GroundPixels, context: unknown,
  width: number, height: number, originX = 0, originY = 0,
): Uint8ClampedArray {
  const raster = createGroundRaster(source, context, width, height, originX, originY);
  raster.drawRows(height);
  return raster.data;
}

/** The browser can yield between row batches; server crops use the same writer
 * synchronously. One owned pixel buffer preserves exact source/deed alignment. */
export function createGroundRaster(
  source: GroundPixels, context: unknown,
  width: number, height: number, originX = 0, originY = 0,
) {
  assertGroundSource(source, context);
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096)
    || !Number.isSafeInteger(originX) || !Number.isSafeInteger(originY)) {
    throw new RangeError('Invalid fantasy ground raster bounds');
  }
  const resolved = resolveBaseVisualContext(context);
  const art = baseGroundArt(resolved);
  const color = Number.parseInt(art.sources[resolved.realmId].color.slice(1), 16);
  const channels = [color >>> 16 & 255, color >>> 8 & 255, color & 255];
  const start = art.worldOriginTiles * art.tilePx;
  const span = art.tilePx * art.worldTiles;
  const result = new Uint8ClampedArray(width * height * 4);
  const columns = new Int32Array(width);
  for (let x = 0; x < width; x++) columns[x] = Math.max(0, Math.min(source.width - 1,
    Math.floor((x + originX - start) * source.width / span))) * 4;
  let completedRows = 0;
  let previousSourceRow = -1;
  return {
    data: result,
    get completedRows() { return completedRows; },
    get complete() { return completedRows === height; },
    drawRows(count: number): void {
      if (!Number.isSafeInteger(count) || count <= 0) throw new RangeError('Invalid ground row batch');
      const end = Math.min(height, completedRows + count);
      for (let y = completedRows; y < end; y++) {
        const wy = y + originY;
        const sy = Math.max(0, Math.min(source.height - 1, Math.floor((wy - start) * source.height / span)));
        // Current worlds nearest-sample the same source row about twice. Reuse
        // the completed output row, including across yield boundaries and edge
        // clamps, rather than repainting identical pixels. Historical v1 has
        // world-position grit/fade and deliberately keeps its original path.
        if (resolved.artVersion === 2) {
          const row = y * width * 4;
          if (sy === previousSourceRow) {
            result.copyWithin(row, row - width * 4, row);
          } else {
            for (let x = 0; x < width; x++) {
              const from = sy * source.width * 4 + columns[x]!, to = row + x * 4;
              result[to] = source.data[from]!;
              result[to + 1] = source.data[from + 1]!;
              result[to + 2] = source.data[from + 2]!;
              result[to + 3] = 255;
            }
          }
          previousSourceRow = sy;
          continue;
        }
        for (let x = 0; x < width; x++) {
          const wx = x + originX;
          const from = sy * source.width * 4 + columns[x]!, to = (y * width + x) * 4;
          const distance = Math.max(0, start - wx, start - wy, wx - start - span + 1, wy - start - span + 1);
          const fade = Math.min(1, distance / art.edgeBlendPx);
          // Quiet clustered grit is deterministic at every crop origin. It never
          // creates scenery sprites, hit areas, obstacles or placement restrictions.
          const hash = Math.imul(Math.floor(wx / 3) + 431, 374761393)
            ^ Math.imul(Math.floor(wy / 3) + 719, 668265263);
          const shade = ((hash ^ (hash >>> 13)) & 7) - 3;
          for (let k = 0; k < 3; k++) result[to + k] = Math.round(
            source.data[from + k]! * (1 - fade) + (channels[k]! + shade) * fade,
          );
          result[to + 3] = 255;
        }
      }
      completedRows = end;
    },
  };
}

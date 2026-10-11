// Realm ground (D-128/D-129) and fantasy globe (D-128) contracts. Art bytes are
// copied verbatim as optional-tier files after their SHA-256 is proved against the
// shared constants (ground) or the pinned web art manifest (globe); the client
// verifies the same digests before decoding, exactly as apps/web does.
//
// apps/web/public/atlas/retired-deeds/ is a server-only byte archive for deed
// metadata endpoints (D-128, emit-asset-pack.mjs skips it). It is deliberately
// never read here; a future recursive atlas copy must keep excluding it.
import { createHash } from 'node:crypto';
import { buildWorldContentGroups } from './world-content-groups.mjs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildGlobePresentation } from './globe-presentation.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(`Realm contract: ${message}`); };

export async function buildGroundSection({ constants, baseVisual, groundEnvironment, publicRoot, readFile, put, decodePng, skirtTint }) {
  const { REALM_IDS, REALM_NAMES, DEFAULT_BASE_VISUAL, CURRENT_BASE_VISUAL, BASE_GROUND_ART, BASE_GROUND_ART_V2, BASE_GROUND_ART_V3 } = baseVisual;
  if (!baseVisual.isBaseVisualContext(DEFAULT_BASE_VISUAL) || !baseVisual.isBaseVisualContext(CURRENT_BASE_VISUAL)) fail('visual context defaults are not valid contexts');
  if (!BASE_GROUND_ART_V3) fail('source lacks retained realm ground revisions');
  const art = [
    { artVersion: 1, dir: 'ground', spec: BASE_GROUND_ART, realms: REALM_IDS },
    { artVersion: 2, dir: 'ground-v2', spec: BASE_GROUND_ART_V2, realms: REALM_IDS },
    { artVersion: 2, groundRevision: 1, dir: 'ground-v3', spec: BASE_GROUND_ART_V3, realms: ['crownlands'] },
    // Owner rejected the unshipped revision2 studies. Keep their source bytes
    // and readers for audit, but do not install them in a player's content pack.
    // Accepted revision3 is exported separately by layered-ground-catalog.
  ];
  const files = [];
  const vectors = [];
  const artOut = {};
  const revisions = [];
  for (const { artVersion, groundRevision, dir, spec, realms } of art) {
    const manifestPath = `atlas/fantasy/${dir}/manifest.json`;
    const manifestBytes = await readFile(path.join(publicRoot, manifestPath));
    const manifest = JSON.parse(manifestBytes);
    // v2 manifests declare the world geometry; v1 manifests declare only the art version.
    const declares = manifest.sourceSize !== undefined;
    if (declares && (manifest.sourceSize !== spec.sourceSize || manifest.worldOriginTiles !== spec.worldOriginTiles || manifest.worldTiles !== spec.worldTiles || manifest.tilePx !== spec.tilePx)) fail(`${manifestPath} disagrees with BASE_GROUND_ART (${dir})`);
    if (!declares && manifest.artVersion !== Number(artVersion)) fail(`${manifestPath} declares art version ${manifest.artVersion}`);
    await put(manifestPath, manifestBytes, 'optional');
    files.push({ path: manifestPath, sha256: sha256(manifestBytes), size: manifestBytes.length });
    const sources = {};
    if (manifest.files.length !== realms.length) fail(`${manifestPath} has unexpected paintings`);
    for (const realm of realms) {
      const entry = manifest.files.find((file) => file.id === realm);
      const expected = spec.sources[realm];
      if (!entry || !expected) fail(`missing ${dir} painting for ${realm}`);
      const relative = `atlas/fantasy/${dir}/${entry.path}`;
      const bytes = await readFile(path.join(publicRoot, relative));
      const hash = sha256(bytes);
      if (hash !== expected.sha256 || hash !== entry.sha256) fail(`${relative} does not match the accepted painting hash`);
      const pixels = await decodePng(bytes);
      if (pixels.width !== spec.sourceSize || pixels.height !== spec.sourceSize || entry.width !== spec.sourceSize || entry.height !== spec.sourceSize) fail(`${relative} is not ${spec.sourceSize}x${spec.sourceSize}`);
      await put(relative, bytes, 'optional');
      files.push({ path: relative, sha256: hash, size: bytes.length });
      sources[realm] = { path: relative, sha256: hash, size: bytes.length, width: pixels.width, height: pixels.height, color: expected.color };
      const context = { version: 1, realmId: realm, artVersion, ...(groundRevision ? { groundRevision } : {}) };
      if (baseVisual.baseGroundPath(context) !== `/${relative}`) fail(`web ground path changed for ${realm}@${artVersion}`);
      // Goldens from the canonical row writer: plot origin, the world corner and a
      // window past the painting edge (v1 skirt fade/grit, v2 clamp).
      const start = spec.worldOriginTiles * spec.tilePx, span = spec.tilePx * spec.worldTiles;
      const windows = [[0, 0, 64, 64], [start, start, 48, 48], [start + span - 24, start + span - 24, 48, 48]];
      if (groundRevision) {
        // The clearing correction does not touch plot origin or world corners. Prove a real
        // changed patch as well, deriving its world coordinates from the accepted source pixels.
        const prior = await decodePng(await readFile(path.join(publicRoot, artOut[artVersion].sources[realm].path)));
        if (prior.width !== pixels.width || prior.height !== pixels.height) fail('ground revision changed painting geometry');
        let changed = -1;
        for (let pixel = 0; pixel < pixels.width * pixels.height && changed < 0; pixel++) {
          const at = pixel * 4;
          if ([0, 1, 2].some(channel => pixels.data[at + channel] !== prior.data[at + channel])) changed = pixel;
        }
        if (changed < 0) fail('ground revision has no changed terrain pixels');
        windows.push([Math.ceil(start + (changed % pixels.width) * span / pixels.width) - 16,
          Math.ceil(start + Math.floor(changed / pixels.width) * span / pixels.height) - 16, 48, 48, 'revision-correction']);
      }
      for (const [originX, originY, width, height, purpose] of windows) {
        const data = baseVisual.renderGroundPixels(pixels, context, width, height, originX, originY);
        vectors.push({ artVersion, ...(groundRevision ? { groundRevision } : {}), ...(purpose ? { purpose } : {}), realm, originX, originY, width, height, rgbaSha256: sha256(data) });
      }
    }
    const exported = { sourceSize: spec.sourceSize, tilePx: spec.tilePx, plotTiles: spec.plotTiles, edgeBlendPx: spec.edgeBlendPx,
      worldOriginTiles: spec.worldOriginTiles, worldTiles: spec.worldTiles, manifestPath, sources };
    if (groundRevision) for (const realmId of realms) {
      const visual = { version: 1, realmId, artVersion, groundRevision };
      const features = groundEnvironment.groundEnvironmentFeatures(visual);
      if (groundRevision === 2 && (!Array.isArray(features) || features.length === 0 || features.length > constants.BASE_GROUND_MOTION.maxVisiblePoints)) fail(`invalid ground features for ${realmId}`);
      if (features) {
        const lo=-spec.worldOriginTiles/spec.worldTiles*spec.sourceSize, hi=(spec.plotTiles-spec.worldOriginTiles)/spec.worldTiles*spec.sourceSize;
        if (new Set(features.map(p=>p.seed)).size!==features.length || new Set(features.map(p=>`${p.x}:${p.y}`)).size!==features.length
          || features.some(p=>!['water','ice','crystal','vent','foliage','waterfall','dust','mist'].includes(p.kind)
            || !Number.isSafeInteger(p.seed) || p.seed<1 || p.seed>0xffffffff
            || ![p.width,p.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=spec.sourceSize)
            || ![p.x,p.y].every(n=>Number.isSafeInteger(n)&&n>=0&&n<spec.sourceSize)
            || !(p.x<lo || p.y<lo || p.x>=hi || p.y>=hi))) fail(`invalid ground feature seats for ${realmId}`);
      }
      revisions.push({ visual, art: { ...exported, sources: { [realmId]: sources[realmId] }, ...(features ? { features } : {}) } });
    }
    else artOut[artVersion] = exported;
  }
  const skirtTints = {};
  for (const realm of REALM_IDS) {
    const tint = (key, artVersion) => skirtTint(key, { version: 1, realmId: realm, artVersion });
    const stone = tint('rock1', 2), boulder = tint('boulder2', 2), other = tint('tree1', 2);
    if (stone !== boulder) fail(`stone skirt tint differs between rock and boulder for ${realm}`);
    if (tint('rock1', 1) !== 0xffffff || tint('tree1', 1) !== 0xffffff) fail('art version 1 skirt must stay untinted');
    skirtTints[realm] = { stone, other };
  }
  const acts = constants.CAMPAIGN.totalStages / constants.CAMPAIGN.stagesPerAct;
  if (!Number.isInteger(acts) || acts <= 0) fail('campaign act count is not integral');
  const campaignRealmByAct = Array.from({ length: acts }, (_, i) => {
    const visual = baseVisual.campaignBaseVisualForAct(i + 1);
    if (visual.artVersion !== CURRENT_BASE_VISUAL.artVersion || !REALM_IDS.includes(visual.realmId)) fail(`campaign act ${i + 1} visual is not current`);
    return visual.realmId;
  });
  return {
    version: 2,
    source: { context: 'packages/shared/src/baseVisual.ts', constants: 'packages/shared/src/constants.ts', client: 'apps/web/src/game/world/fantasyGround.ts', skirt: 'apps/web/src/game/world/underlay.ts' },
    geometry: constants.BASE_GROUND_GEOMETRY,
    worldGeometry: constants.BASE_GROUND_WORLD_GEOMETRY,
    motion: constants.BASE_GROUND_MOTION,
    realms: [...REALM_IDS],
    realmNames: REALM_NAMES,
    defaultVisual: DEFAULT_BASE_VISUAL,
    currentVisual: CURRENT_BASE_VISUAL,
    campaignRealmByAct,
    art: artOut,
    revisions,
    crop: {
      units: 'native game pixels (world pixels / presentation.worldScale)',
      column: 'sx = clamp(floor((wx - start) * sourceWidth / span), 0, sourceWidth - 1) with start = worldOriginTiles * tilePx and span = tilePx * worldTiles; rows identical',
      artVersion2: 'opaque authored terrain everywhere, alpha forced to 255',
      artVersion1: 'outside the plot: blend toward the realm color over edgeBlendPx plus deterministic grit (createGroundRaster, code)',
      skirtDecor: 'same sprites and positions as before; tinted per realm only for artVersion 2',
    },
    skirtTints,
    motionGlyphs: { codeOnly: 'FantasyGroundMotion in apps/web/src/game/world/fantasyGround.ts draws realm-specific Graphics glyphs every motion.frameMs; not data' },
    files,
    vectors,
  };
}

export async function buildFantasySection({ constants, fantasyWorld, baseVisual, source, publicRoot, readFile, put }) {
  const { FANTASY_WORLD } = constants;
  // Pure authored display metadata, exported from the same clean source as its pinned pixels.
  const runtime = 'apps/web/src/ui/fantasy/runtime/';
  const { REGIONS, ARCHIPELAGOS } = await import(pathToFileURL(path.join(source, runtime, 'world.mjs')).href);
  const { REGIONAL_DETAILS } = await import(pathToFileURL(path.join(source, runtime, 'details.mjs')).href);
  if (REGIONS.length !== baseVisual.REALM_IDS.length || REGIONS.some(r => !baseVisual.REALM_IDS.includes(r.id))) fail('globe presentation realm mismatch');
  const { FANTASY_WORLD_ID, FANTASY_CATALOG_HASH, FANTASY_MEMBERSHIP_HASH } = fantasyWorld;
  const catalogRelative = 'packages/shared/src/data/fantasy-world-v1.json';
  const catalogBytes = await readFile(path.join(source, catalogRelative));
  const catalog = JSON.parse(catalogBytes);
  if (catalog.membershipSha256 !== FANTASY_MEMBERSHIP_HASH) fail('frozen catalog membership hash drifted');
  const tiles = [...fantasyWorld.fantasyTiles()];
  const derived = sha256(JSON.stringify({ worldId: FANTASY_WORLD_ID, columns: FANTASY_WORLD.columns, rows: FANTASY_WORLD.rows,
    tiles: tiles.map((t) => [t.tileId, t.realmId, t.allocation]) }));
  if (derived !== FANTASY_CATALOG_HASH) fail('frozen catalog no longer hashes to FANTASY_CATALOG_HASH');
  const counts = { total: tiles.length, byRealm: {}, byAllocation: {} };
  for (const tile of tiles) {
    counts.byRealm[tile.realmId] = (counts.byRealm[tile.realmId] ?? 0) + 1;
    counts.byAllocation[tile.allocation] = (counts.byAllocation[tile.allocation] ?? 0) + 1;
  }
  if (counts.total !== FANTASY_WORLD.totalTiles || counts.byAllocation.ordinary !== FANTASY_WORLD.ordinaryTiles
    || counts.byAllocation.genesis !== FANTASY_WORLD.genesisTiles || counts.byAllocation.seeker !== FANTASY_WORLD.seekerTiles) fail('tile totals disagree with FANTASY_WORLD');
  for (const realm of baseVisual.REALM_IDS) if (!(counts.byRealm[realm] > 0)) fail(`realm ${realm} has no tiles`);
  const catalogPath = 'fantasy/world-v1.json';
  await put(catalogPath, catalogBytes, 'core');
  // Tile math goldens: the same helpers the API uses for every parcel response.
  const sampleIds = [0, FANTASY_WORLD.columns - 1, tiles[0].tileId, tiles[Math.floor(tiles.length / 2)].tileId, tiles.at(-1).tileId,
    FANTASY_WORLD.columns * FANTASY_WORLD.rows - 1];
  const tileVectors = sampleIds.map((tileId) => ({ tileId, tile: fantasyWorld.getFantasyTile(tileId) }));
  const atVectors = [[0, 0], [-180, 90], [179.999, -89.999], [FANTASY_WORLD.crownlandsCenter.lon, FANTASY_WORLD.crownlandsCenter.lat]]
    .map(([lon, lat]) => ({ lon, lat, tile: fantasyWorld.fantasyTileAt(lon, lat) }));
  const migration = fantasyWorld.crownlandsMigrationTiles();
  // Globe rasters: the web pins every file in apps/web/src/ui/fantasy/art-manifest.json
  // and refuses bytes with another digest. The generated tree must carry the same pins.
  const pinnedBytes = await readFile(path.join(source, 'apps/web/src/ui/fantasy/art-manifest.json'));
  const pinned = JSON.parse(pinnedBytes);
  const globeManifestPath = 'atlas/fantasy/globe/manifest.json';
  const globeManifestBytes = await readFile(path.join(publicRoot, globeManifestPath));
  const globeManifest = JSON.parse(globeManifestBytes);
  const pins = (manifest) => JSON.stringify(manifest.files.map((f) => [f.path, f.sha256, f.width, f.height]).sort());
  if (pins(pinned) !== pins(globeManifest) || pinned.version !== globeManifest.version) fail('generated globe art disagrees with the web art manifest');
  await put(globeManifestPath, globeManifestBytes, 'optional');
  const globeFiles = [{ path: globeManifestPath, sha256: sha256(globeManifestBytes), size: globeManifestBytes.length }];
  for (const file of globeManifest.files) {
    const relative = `atlas/fantasy/globe/${file.path}`;
    const bytes = await readFile(path.join(publicRoot, relative));
    if (sha256(bytes) !== file.sha256) fail(`${relative} does not match its pinned hash`);
    await put(relative, bytes, 'optional');
    globeFiles.push({ path: relative, sha256: file.sha256, size: bytes.length, width: file.width, height: file.height });
  }
  const display = await buildGlobePresentation({ source, readFile, addFile: async (relative, bytes) => {
    await put(relative, bytes, 'optional');
    globeFiles.push({ path: relative, sha256: sha256(bytes), size: bytes.length });
  } });
  const campaignRelative = 'apps/web/src/ui/fantasy/campaign-presentation.json';
  const campaignBytes = await readFile(path.join(source, campaignRelative));
  const campaign = JSON.parse(campaignBytes);
  if (!Array.isArray(campaign.chapters) || campaign.chapters.some((c) => !baseVisual.REALM_IDS.includes(c.region))) fail('campaign presentation names an unknown realm');
  const campaignPath = 'fantasy/campaign-presentation.json';
  await put(campaignPath, campaignBytes, 'core');
  return {
    version: 1,
    source: { catalog: 'packages/shared/src/fantasyWorld.ts', data: catalogRelative, art: 'apps/web/src/ui/fantasy/art-manifest.json', campaign: campaignRelative },
    world: FANTASY_WORLD,
    worldId: FANTASY_WORLD_ID,
    catalogHash: FANTASY_CATALOG_HASH,
    catalogHashDerivation: 'sha256(JSON.stringify({worldId, columns, rows, tiles: [[tileId, realmId, allocation] in tileId order]}))',
    membershipHash: FANTASY_MEMBERSHIP_HASH,
    catalogPath, catalogSha256: sha256(catalogBytes),
    catalogEncoding: 'regions[].runs and genesisRuns/seekerRuns are inclusive [start, end] tileId ranges; tileId = row * columns + column',
    tileMath: {
      lon: '((tileId % columns) + 0.5) * 360 / columns - 180',
      lat: '90 - (floor(tileId / columns) + 0.5) * 180 / rows',
      tileAt: 'x = floor(wrap(lon) / 360 * columns), y = min(rows - 1, floor((90 - lat) / 180 * rows)), tileId = y * columns + x',
    },
    allocations: ['ordinary', 'genesis', 'seeker'],
    counts,
    crownlandsMigration: { count: migration.length, firstTileIds: migration.slice(0, 8).map((t) => t.tileId) },
    vectors: { tiles: tileVectors, tileAt: atVectors },
    globe: { version: globeManifest.version, sourceCommit: globeManifest.sourceCommit, manifestPath: globeManifestPath, files: globeFiles,
      groups: buildWorldContentGroups(globeFiles, REGIONAL_DETAILS, ARCHIPELAGOS),
      renderer: { codeOnly: 'apps/web/src/ui/fantasy/runtime/*.mjs (CPU sphere raster, coastline/feature data) is not exported; the native globe is a separate port' } },
    presentation: { regions: REGIONS, chains: ARCHIPELAGOS, regionalDetails: REGIONAL_DETAILS, ...display },
    campaignPresentationPath: campaignPath,
    endpoints: ['/globe/fantasy', '/globe/fantasy/search', '/globe/fantasy/parcels', '/globe/fantasy/parcels/:tileId'],
  };
}

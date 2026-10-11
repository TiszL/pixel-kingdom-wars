import { createHash } from 'node:crypto';

// Candidate contract 17 (N-C5-ART): the authored fleet-journey art beside the
// renderer15 service graph and the renderer16 bound cosmetics. The two generated
// web sidecars (`pe_fleet_starter.manifest.json`, `pe_advanced_fleet.manifest.json`)
// are carried VERBATIM as the block's metadata — no parallel representation of the
// starter clips/tracks — and bound to the packed groups' exact cell closure and
// file pins. The canonical web parsers (`parseStarterFleetMetadata`,
// `parseAdvancedFleetMetadata`, injected) own the graph semantics; this boundary
// checks sidecar/generated-metadata agreement, group/frame/file closure, the
// separately authored gate stills, owned byte snapshots and PNG shape. It selects
// no art, installs nothing and grants no renderer compatibility.

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Fleet catalogue: ${message}`); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export const FLEET_STARTER_GROUP = 'pe_fleet_starter';
/** Wire/group names stay underscored; the authored family-track names are dashed. */
export const ADVANCED_FLEET_FAMILIES = ['survey_balloon', 'cargo_cutter', 'courier_airship', 'expedition_barge'];
export const ADVANCED_FLEET_TIERS = [1, 2, 3, 4];
/** The 1 + 20 optional groups a fleet extension pins, sorted by id. */
export function fleetGroupIds() {
  const ids = [FLEET_STARTER_GROUP];
  for (const family of ADVANCED_FLEET_FAMILIES) {
    ids.push(`pe_berth_${family}`);
    for (const tier of ADVANCED_FLEET_TIERS) ids.push(`pe_veh_${family}_t${tier}`);
  }
  return ids.sort();
}
/** The gate effects whose reduced-motion still is a SEPARATE packed frame. */
export const GATE_EFFECTS = ['pe_fx_departure', 'pe_fx_return'];

/** The starter sidecar is the generated `peStarterFleet` header plus the fleet
 *  `peClips` and `peTracks` tables; the advanced sidecar IS `peAdvancedFleet`. */
export function assertSidecarsAgree({ starterSidecar, advancedSidecar, meta }) {
  const header = meta?.peStarterFleet;
  if (!header || typeof header !== 'object' || !starterSidecar || typeof starterSidecar !== 'object') fail('peStarterFleet is missing');
  const headerKeys = Object.keys(header), sidecarKeys = Object.keys(starterSidecar);
  if (!same([...headerKeys, 'clips', 'tracks'].sort(), [...sidecarKeys].sort())) fail('starter sidecar keys differ from peStarterFleet');
  for (const key of headerKeys) if (!same(header[key], starterSidecar[key])) fail(`starter sidecar ${key} differs from peStarterFleet`);
  if (!same(starterSidecar.clips, meta.peClips)) fail('starter sidecar clips differ from peClips');
  if (!same(starterSidecar.tracks, meta.peTracks)) fail('starter sidecar tracks differ from peTracks');
  if (!same(advancedSidecar, meta.peAdvancedFleet)) fail('advanced sidecar differs from peAdvancedFleet');
}

export async function buildFleetCatalogue({ starterSidecar: callerStarter, advancedSidecar: callerAdvanced, meta: callerMeta, parseStarterFleetMetadata, parseAdvancedFleetMetadata, atlasGroupFor, assets, inspectPng }) {
  // Own deep snapshots of BOTH sidecars and the generated tables BEFORE any validation: agreement, the canonical
  // parses, the cross-source/still checks and the returned metadata all read these same owned objects, so a caller
  // changing its objects during the asynchronous inspection below changes nothing that was validated or is returned.
  const starterSidecar = structuredClone(callerStarter), advancedSidecar = structuredClone(callerAdvanced);
  const meta = callerMeta && typeof callerMeta === 'object'
    ? { peStarterFleet: structuredClone(callerMeta.peStarterFleet), peClips: structuredClone(callerMeta.peClips), peTracks: structuredClone(callerMeta.peTracks), peAdvancedFleet: structuredClone(callerMeta.peAdvancedFleet) }
    : callerMeta;
  assertSidecarsAgree({ starterSidecar, advancedSidecar, meta });
  // The canonical parsers never throw; an EMPTY table is a refusal here.
  const starter = parseStarterFleetMetadata(starterSidecar, starterSidecar.clips, starterSidecar.tracks);
  if (!starter || starter.atlas !== FLEET_STARTER_GROUP || !starter.tracks || !starter.geometry || Object.keys(starter.clips ?? {}).length === 0) fail('starter metadata did not parse');
  const advanced = parseAdvancedFleetMetadata(advancedSidecar);
  if (!advanced || advanced.berths?.size !== ADVANCED_FLEET_FAMILIES.length || advanced.vehicles?.size !== ADVANCED_FLEET_FAMILIES.length * ADVANCED_FLEET_TIERS.length
    || advanced.tracks?.size !== ADVANCED_FLEET_FAMILIES.length || Object.keys(advanced.clips ?? {}).length === 0) fail('advanced metadata did not parse');
  // Starter and advanced tables come from ONE authored source.
  for (const key of ['sourceManifestSha256', 'sourceIndexSha256']) if (starter[key] !== advanced[key]) fail(`starter/advanced ${key} disagree`);
  if (starterSidecar.sourceTracksSha256 !== advanced.sourceTracksSha256) fail('starter/advanced sourceTracksSha256 disagree');
  // Dock translation stated twice: attachment − contact equals dockOffsetPx (starter; the advanced parser proves its own).
  const { starter: craft, berth } = starter.geometry;
  if (berth.attachment[0] - craft.contactPx[0] !== craft.dockOffsetPx[0] || berth.attachment[1] - craft.contactPx[1] !== craft.dockOffsetPx[1]) fail('starter dock translation disagrees');
  if (!same(starter.dockTranslation, craft.dockOffsetPx)) fail('starter dock translation disagrees');

  const expected = new Map();
  const claim = (id, key, width, height) => {
    if (atlasGroupFor(key) !== id) fail(`frame routes to another group: ${key}`);
    const frames = expected.get(id) ?? new Map();
    if (frames.has(key)) fail(`duplicate cell: ${key}`);
    frames.set(key, { width, height }); expected.set(id, frames);
  };
  for (const [id, clip] of Object.entries(starter.clips)) {
    if (clip.atlas !== FLEET_STARTER_GROUP) fail(`starter clip packed elsewhere: ${id}`);
    for (const key of clip.frames) claim(FLEET_STARTER_GROUP, key, clip.cellW, clip.cellH);
  }
  for (const [id, clip] of Object.entries(advanced.clips)) {
    if (clip.atlas === FLEET_STARTER_GROUP) fail(`advanced clip packed in the starter group: ${id}`);
    for (const key of clip.frames) claim(clip.atlas, key, clip.cellW, clip.cellH);
  }
  if (!same([...expected.keys()].sort(), fleetGroupIds())) fail('group closure changed');
  // The gate stills are separately authored packed frames, never a member of the eight-frame animation.
  for (const id of GATE_EFFECTS) {
    const clip = starter.clips[id], still = clip?.reducedMotionClip ? starter.clips[clip.reducedMotionClip] : null;
    if (!clip || clip.frames.length !== 8 || !still || still.frames.length !== 1) fail(`gate effect lacks its separate still: ${id}`);
    if (clip.frames.includes(still.frames[0])) fail(`gate still is a normal frame: ${id}`);
    const digests = new Set(starterSidecar.clips[id].frames.map(frame => frame.sha256));
    if (digests.has(starterSidecar.clips[clip.reducedMotionClip].frames[0].sha256)) fail(`gate still duplicates a normal frame digest: ${id}`);
  }
  // Own every byte before the first async inspection (service-catalogue precedent).
  const paths = [...expected.keys()].flatMap(id => [`atlas/${id}@1x.json`, `atlas/${id}@1x.png`]).sort();
  if (assets.size !== paths.length || paths.some(name => !assets.has(name))) fail('selected file closure changed');
  const owned = new Map(paths.map(name => [name, Buffer.from(assets.get(name))]));
  const groups = [];
  for (const [id, cells] of [...expected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const atlasPath = `atlas/${id}@1x.json`, imagePath = `atlas/${id}@1x.png`;
    const json = owned.get(atlasPath), png = owned.get(imagePath);
    const textures = JSON.parse(json.toString('utf8')).textures;
    if (!Array.isArray(textures) || textures.length !== 1) fail(`one texture required: ${id}`);
    const texture = textures[0], width = texture.size?.w, height = texture.size?.h;
    if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096)
      || texture.image !== `${id}@1x.png` || texture.format !== 'RGBA8888' || texture.scale !== 1
      || !Array.isArray(texture.frames) || texture.frames.length !== cells.size) fail(`texture header/closure changed: ${id}`);
    const seen = new Set();
    for (const frame of texture.frames) {
      const cell = cells.get(frame.filename), rect = frame.frame;
      if (!cell || seen.has(frame.filename) || frame.rotated !== false || frame.trimmed !== false
        || !rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isSafeInteger)
        || rect.x < 0 || rect.y < 0 || rect.w !== cell.width || rect.h !== cell.height
        || rect.x + rect.w > width || rect.y + rect.h > height
        || frame.sourceSize?.w !== cell.width || frame.sourceSize?.h !== cell.height
        || frame.spriteSourceSize?.x !== 0 || frame.spriteSourceSize?.y !== 0
        || frame.spriteSourceSize?.w !== cell.width || frame.spriteSourceSize?.h !== cell.height) fail(`cell identity/geometry changed: ${id}`);
      seen.add(frame.filename);
    }
    const info = await inspectPng(png);
    if (info.format !== 'png' || info.width !== width || info.height !== height || info.depth !== 'uchar'
      || !info.hasAlpha || (info.pages !== undefined && info.pages !== 1)) fail(`PNG shape changed: ${id}`);
    groups.push({ id, atlasPath, imagePath, decodedBytes: width * height * 4,
      files: [atlasPath, imagePath].map(name => ({ path: name, sha256: hash(owned.get(name)), size: owned.get(name).length })) });
  }
  return { version: 1, metadata: { peStarterFleet: starterSidecar, peAdvancedFleet: advancedSidecar }, groups }; // the owned snapshots themselves, never a later clone
}

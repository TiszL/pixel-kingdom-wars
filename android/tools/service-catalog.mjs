import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Service catalogue: ${message}`); };
const types = ['workshop', 'lodge', 'market', 'harvester', 'berth'];

/** A service entry deliberately has no static fallback sprite or default family. */
export function serviceBuildingEntry(type, level, constants, artTierOfLevel) {
  if (!types.includes(type)) return null;
  if (JSON.stringify(constants.PHASE_E_BUILDINGS?.types) !== JSON.stringify(types)) fail('building identities changed');
  const properties = constants.STRUCTURES[type];
  if (!Number.isSafeInteger(level) || level < 1 || level > properties.maxLevel
    || JSON.stringify(properties.footprint) !== '[2,2]') fail(`invalid service level/footprint: ${type}`);
  const tier = type === 'berth' ? null : artTierOfLevel(level);
  if (tier !== null && (!Number.isSafeInteger(tier) || tier < 1 || tier > constants.PHASE_E_BUILDINGS.visualTiers)) fail('invalid source tier');
  return { type, level, footprintWidth: properties.footprint[0], footprintHeight: properties.footprint[1], phaseE: { facility: type, tier } };
}

/** Candidate contract 15 only. Canonical parsePhaseEArt owns graph semantics;
 * this boundary binds its exact cell closure to packed file pins and geometry.
 * It does not select art, install files or grant renderer compatibility. */
export async function buildServiceCatalogue({ meta, parsePhaseEArt, atlasGroupFor, isPhaseEServiceAtlasGroup, assets, inspectPng }) {
  const metadata = parsePhaseEArt({ peClips: meta.peClips, peAppearances: meta.peAppearances, peEffects: meta.peEffects });
  const expected = new Map();
  const claim = (key, width, height) => {
    const id = atlasGroupFor(key);
    if (!isPhaseEServiceAtlasGroup(id)) fail(`foreign group: ${id}`);
    const frames = expected.get(id) ?? new Map();
    if (frames.has(key)) fail(`duplicate cell: ${key}`);
    frames.set(key, { width, height }); expected.set(id, frames);
  };
  for (const clip of Object.values(metadata.peClips)) for (const frame of clip.frames) claim(frame.key, clip.cellW, clip.cellH);
  for (const appearance of Object.values(metadata.peAppearances)) for (const state of Object.values(appearance.states)) {
    if (state.kind === 'static') claim(state.key, ...appearance.geometry.cell);
  }
  // Own every byte before the first async inspection; a caller cannot mutate a
  // later file after its geometry was checked but before its digest was made.
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
    // Same packed-format bound as canonical phase-e-packed-group.ts, not a
    // gameplay value or native device texture-budget approval.
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
  return { version: 1, metadata, groups };
}

/** A final export guard: selected-group delivery must never silently turn into
 * bundling every service variant. Pins must still describe the staged bytes. */
export function assertServiceOptionalFiles(phaseE, files, tier = 'optional') {
  if (!phaseE) return;
  // `tier` is 'core' only for an explicit `--phase-e-core` export (2026-10-06): the pins still describe the staged bytes.
  for (const pin of phaseE.groups.flatMap(group => group.files)) {
    const matches = files.filter(file => file.path === pin.path);
    if (matches.length !== 1 || matches[0].tier !== tier || matches[0].sha256 !== pin.sha256 || matches[0].size !== pin.size) {
      fail(`optional file pin changed: ${pin.path}`);
    }
  }
}

/** Candidate contract 16 extension: the bound-cosmetics table beside the
 * service graph. The generated `meta.peCosmetics` table (clips, one-based keys,
 * alias/overlay references, per-cell RGBA digests and the Awning bindings with
 * their source/index/binding hashes) is carried VERBATIM and bound to the packed
 * `pe_cosmetics` group's exact cell closure and file pins. It selects no art,
 * installs nothing and grants no renderer compatibility. The packed group also
 * carries the craft-success overlay and the Aurora wake cells: they are
 * described for closure only; no wake appearance is exported here. */
const cosmeticGroup = 'pe_cosmetics';
export const cosmeticAwningOutputs = ['artisan_market_awning_t1', 'artisan_market_awning_t2', 'artisan_market_awning_t3', 'artisan_market_awning_t4'];
const cosmeticOutputs = [...cosmeticAwningOutputs, 'aurora_wake'];
const hex64 = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isInt = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const isPair = value => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
const exactKeys = (object, keys, label) => {
  if (!object || typeof object !== 'object' || Array.isArray(object)) fail(`${label} is not an object`);
  const actual = Object.keys(object).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(`${label} keys changed: ${actual.join(',')}`);
};
export async function buildCosmeticCatalogue({ meta, atlasGroupFor, assets, inspectPng }) {
  const table = meta?.peCosmetics;
  if (!table || typeof table !== 'object') fail('peCosmetics table is missing');
  exactKeys(table, ['schemaVersion', 'atlas', 'sourceScale', 'sourceIndexBase', 'keyIndexBase', 'sourceManifestSha256', 'indexSha256', 'provenanceSha256', 'clips', 'bindings'], 'peCosmetics');
  if (table.schemaVersion !== 1 || table.atlas !== cosmeticGroup || table.sourceScale !== 1 || table.sourceIndexBase !== 0 || table.keyIndexBase !== 1) fail('peCosmetics header changed');
  for (const name of ['sourceManifestSha256', 'indexSha256', 'provenanceSha256']) if (!hex64(table[name])) fail(`peCosmetics ${name} is not a digest`);
  const expected = new Map();
  const clips = table.clips;
  if (!clips || typeof clips !== 'object' || Array.isArray(clips)) fail('peCosmetics clips changed');
  for (const [id, clip] of Object.entries(clips)) {
    if (!/^pe_cos_[a-z0-9_]+$/.test(id)) fail(`foreign cosmetic clip: ${id}`);
    const optional = ['alias', 'overlay', 'footprint', 'sourcePivot', 'sourceFrameIndices'].filter(key => key in clip);
    exactKeys(clip, ['sourcePath', 'sourceSha256', 'cellW', 'cellH', 'anchorPx', 'anchorKind', 'fps', 'loop', 'reducedMotionFrame', 'frames', ...optional], `clip ${id}`);
    if (typeof clip.sourcePath !== 'string' || !clip.sourcePath || !hex64(clip.sourceSha256)) fail(`clip provenance changed: ${id}`);
    if (!isInt(clip.cellW, 1) || !isInt(clip.cellH, 1) || !isPair(clip.anchorPx) || typeof clip.anchorKind !== 'string') fail(`clip geometry changed: ${id}`);
    if (!Number.isFinite(clip.fps) || clip.fps < 0 || typeof clip.loop !== 'boolean') fail(`clip clock changed: ${id}`);
    if (!Array.isArray(clip.frames) || clip.frames.length === 0 || !isInt(clip.reducedMotionFrame) || clip.reducedMotionFrame >= clip.frames.length) fail(`clip frames changed: ${id}`);
    if (clip.alias !== undefined && (typeof clip.alias !== 'string' || !(clip.alias in clips) || clip.alias === id)) fail(`clip alias changed: ${id}`);
    if (clip.overlay !== undefined && (typeof clip.overlay?.clip !== 'string' || !(clip.overlay.clip in clips) || !isPair(clip.overlay.offset))) fail(`clip overlay changed: ${id}`);
    const keyBase = clip.alias ?? id;
    clip.frames.forEach((frame, index) => {
      exactKeys(frame, ['sourceIndex', 'key', 'rgbaSha256'], `frame ${id}[${index}]`);
      if (frame.sourceIndex !== index || frame.key !== `${keyBase}_f${index + 1}` || !hex64(frame.rgbaSha256)) fail(`frame identity changed: ${id}[${index}]`);
      if (clip.alias === undefined) {
        if (atlasGroupFor(frame.key) !== cosmeticGroup) fail(`foreign group: ${frame.key}`);
        if (expected.has(frame.key)) fail(`duplicate cell: ${frame.key}`);
        expected.set(frame.key, { width: clip.cellW, height: clip.cellH });
      }
    });
    if (clip.alias !== undefined) {
      const target = clips[clip.alias];
      if (!Array.isArray(target.frames) || target.frames.length !== clip.frames.length
        || target.frames.some((frame, index) => frame.key !== clip.frames[index].key)) fail(`alias cells differ: ${id}`);
    }
  }
  const bindings = table.bindings;
  exactKeys(bindings, cosmeticOutputs, 'peCosmetics bindings');
  for (const [outputId, binding] of Object.entries(bindings)) {
    exactKeys(binding, ['sha256', 'value'], `binding ${outputId}`);
    if (!hex64(binding.sha256)) fail(`binding digest changed: ${outputId}`);
    const value = binding.value;
    exactKeys(value, ['version', 'outputId', 'sourceId', 'sourceManifestSha256', 'sourceIndexSha256', 'sourceScale', 'clips'], `binding value ${outputId}`);
    if (value.version !== 1 || value.outputId !== outputId || typeof value.sourceId !== 'string' || value.sourceScale !== 1) fail(`binding identity changed: ${outputId}`);
    if (value.sourceManifestSha256 !== table.sourceManifestSha256 || value.sourceIndexSha256 !== table.indexSha256) fail(`binding provenance differs from the table: ${outputId}`);
    if (!Array.isArray(value.clips) || value.clips.length === 0) fail(`binding clips changed: ${outputId}`);
    for (const clip of value.clips) {
      const id = typeof clip === 'string' ? clip : clip?.id;
      if (typeof id !== 'string' || !(id in clips)) fail(`binding names an unpacked clip: ${outputId}`);
    }
  }
  for (const tier of [1, 2, 3, 4]) for (const state of ['idle', 'damaged', 'destroyed', 'working', 'construction', 'collapse', 'ready']) {
    if (!(`pe_cos_market_t${tier}_${state}` in clips)) fail(`Awning tier ${tier} lacks ${state}`);
  }
  const atlasPath = `atlas/${cosmeticGroup}@1x.json`, imagePath = `atlas/${cosmeticGroup}@1x.png`;
  const paths = [atlasPath, imagePath];
  if (assets.size !== paths.length || paths.some(name => !assets.has(name))) fail('selected file closure changed');
  const owned = new Map(paths.map(name => [name, Buffer.from(assets.get(name))]));
  const json = owned.get(atlasPath), png = owned.get(imagePath);
  const textures = JSON.parse(json.toString('utf8')).textures;
  if (!Array.isArray(textures) || textures.length !== 1) fail(`one texture required: ${cosmeticGroup}`);
  const texture = textures[0], width = texture.size?.w, height = texture.size?.h;
  if (![width, height].every(n => Number.isSafeInteger(n) && n > 0 && n <= 4096)
    || texture.image !== `${cosmeticGroup}@1x.png` || texture.format !== 'RGBA8888' || texture.scale !== 1
    || !Array.isArray(texture.frames) || texture.frames.length !== expected.size) fail(`texture header/closure changed: ${cosmeticGroup}`);
  const seen = new Set();
  for (const frame of texture.frames) {
    const cell = expected.get(frame.filename), rect = frame.frame;
    if (!cell || seen.has(frame.filename) || frame.rotated !== false || frame.trimmed !== false
      || !rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isSafeInteger)
      || rect.x < 0 || rect.y < 0 || rect.w !== cell.width || rect.h !== cell.height
      || rect.x + rect.w > width || rect.y + rect.h > height
      || frame.sourceSize?.w !== cell.width || frame.sourceSize?.h !== cell.height
      || frame.spriteSourceSize?.x !== 0 || frame.spriteSourceSize?.y !== 0
      || frame.spriteSourceSize?.w !== cell.width || frame.spriteSourceSize?.h !== cell.height) fail(`cell identity/geometry changed: ${cosmeticGroup}`);
    seen.add(frame.filename);
  }
  const info = await inspectPng(png);
  if (info.format !== 'png' || info.width !== width || info.height !== height || info.depth !== 'uchar'
    || !info.hasAlpha || (info.pages !== undefined && info.pages !== 1)) fail(`PNG shape changed: ${cosmeticGroup}`);
  const group = { id: cosmeticGroup, atlasPath, imagePath, decodedBytes: width * height * 4,
    files: paths.map(name => ({ path: name, sha256: hash(owned.get(name)), size: owned.get(name).length })) };
  return { version: 1, metadata: { peCosmetics: structuredClone(table) }, groups: [group], awnings: [...cosmeticAwningOutputs] };
}

/** Project explicitly selected RGBA cells into native service groups. This does
 * not infer semantic aliases or renderer compatibility. decodePng returns
 * {data: Buffer, width, height}; encodePng receives the same shape. Both codecs
 * must preserve RGBA8, including RGB under zero alpha. No source file is written.
 * Uses the existing service-catalog.mjs `hash` helper. */
export async function projectServiceAssets({ frames, assets, inspectPng, decodePng, encodePng }) {
  const refuse = reason => { throw new Error(`Service projection: ${reason}`); };
  const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
  const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,159}$/.test(value);
  const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  const maxPixelsBytes = 256 * 1024 * 1024;
  const maxInputBytes = 256 * 1024 * 1024;
  if (!Array.isArray(frames) || !integer(frames.length, 1, 2048) || !(assets instanceof Map)
    || [inspectPng, decodePng, encodePng].some(callback => typeof callback !== 'function')) refuse('invalid input');
  // Capture every selected input before the first await. Callbacks only receive
  // disposable copies; neither callers nor codecs can change a later source.
  const selected = [], destinations = new Set(), destinationGroups = new Set(), sources = new Map(), owned = new Map();
  let sourceDecodedBytes = 0, selectedDecodedBytes = 0, encodedInputBytes = 0;
  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) refuse('invalid frame');
    const { key, group, sourceAtlasPath, sourceKey, width, height, rgbaSha256 } = frame;
    const match = typeof sourceAtlasPath === 'string' && /^atlas\/([a-z][a-z0-9_-]{0,159})@1x\.json$/.exec(sourceAtlasPath);
    if (!identifier(key) || !identifier(group) || !identifier(sourceKey) || !match
      || !integer(width, 1, 4092) || !integer(height, 1, 4092) || !digest(rgbaSha256)) refuse('invalid frame identity/shape');
    if (destinations.has(key)) refuse(`duplicate destination: ${key}`);
    destinations.add(key);
    // Explicit aliases are allowed but still consume destination RGBA memory.
    // Bound them before decoding or allocating a copy of any selected cell.
    selectedDecodedBytes += width * height * 4;
    if (selectedDecodedBytes > maxPixelsBytes) refuse('selected decoded-byte limit');
    destinationGroups.add(group);
    if (destinationGroups.size > 64) refuse('destination group limit');
    selected.push({ key, group, sourceAtlasPath, sourceKey, width, height, rgbaSha256 });
    if (sources.has(sourceAtlasPath)) continue;
    if (sources.size >= 64) refuse('source group limit');
    const imagePath = `atlas/${match[1]}@1x.png`;
    for (const name of [sourceAtlasPath, imagePath]) {
      const bytes = assets.get(name), maximum = name.endsWith('.json') ? 2 * 1024 * 1024 : 64 * 1024 * 1024;
      if (!Buffer.isBuffer(bytes) || !integer(bytes.length, 1, maximum)) refuse(`missing/oversized input: ${name}`);
      encodedInputBytes += bytes.length;
      if (encodedInputBytes > maxInputBytes) refuse('encoded input-byte limit');
      owned.set(name, Buffer.from(bytes));
    }
    let document;
    try { document = JSON.parse(owned.get(sourceAtlasPath).toString('utf8')); } catch { refuse(`invalid atlas JSON: ${sourceAtlasPath}`); }
    if (!document || !Array.isArray(document.textures) || document.textures.length !== 1) refuse('one texture required');
    const texture = document.textures[0], w = texture?.size?.w, h = texture?.size?.h;
    if (!integer(w, 1, 4096) || !integer(h, 1, 4096) || texture.image !== `${match[1]}@1x.png`
      || texture.format !== 'RGBA8888' || texture.scale !== 1 || !Array.isArray(texture.frames)
      || !integer(texture.frames.length, 1, 2048)) refuse('texture header/closure changed');
    sourceDecodedBytes += w * h * 4;
    if (sourceDecodedBytes > maxPixelsBytes) refuse('source decoded-byte limit');
    const cells = new Map(), rectangles = [];
    for (const cell of texture.frames) {
      const r = cell?.frame;
      if (!cell || !identifier(cell.filename) || cells.has(cell.filename) || cell.rotated !== false || cell.trimmed !== false
        || !r || !integer(r.x, 0, w) || !integer(r.y, 0, h) || !integer(r.w, 1, w) || !integer(r.h, 1, h)
        || r.x + r.w > w || r.y + r.h > h || cell.sourceSize?.w !== r.w || cell.sourceSize?.h !== r.h
        || cell.spriteSourceSize?.x !== 0 || cell.spriteSourceSize?.y !== 0
        || cell.spriteSourceSize?.w !== r.w || cell.spriteSourceSize?.h !== r.h) refuse('source cell identity/geometry changed');
      if (rectangles.some(other => r.x < other.x + other.w && r.x + r.w > other.x
        && r.y < other.y + other.h && r.y + r.h > other.y)) refuse('source cells overlap');
      const rect = { x: r.x, y: r.y, w: r.w, h: r.h };
      cells.set(cell.filename, rect); rectangles.push(rect);
    }
    sources.set(sourceAtlasPath, { imagePath, width: w, height: h, cells });
  }
  for (const frame of selected) {
    const cell = sources.get(frame.sourceAtlasPath).cells.get(frame.sourceKey);
    if (!cell || cell.w !== frame.width || cell.h !== frame.height) refuse(`missing/mismatched source cell: ${frame.sourceKey}`);
  }
  async function callBytes(callback, bytes) {
    const argument = Buffer.from(bytes), result = await callback(argument);
    if (!argument.equals(bytes)) refuse('callback mutated its byte input');
    return result;
  }
  async function decode(bytes, width, height) {
    const info = await callBytes(inspectPng, bytes);
    if (!info || info.format !== 'png' || info.width !== width || info.height !== height || info.depth !== 'uchar'
      || info.hasAlpha !== true || (info.pages !== undefined && info.pages !== 1)) refuse('PNG shape changed');
    const image = await callBytes(decodePng, bytes);
    if (!image || image.width !== width || image.height !== height || !Buffer.isBuffer(image.data)
      || image.data.length !== width * height * 4) refuse('decoded shape changed');
    return Buffer.from(image.data);
  }
  const decoded = new Map();
  for (const [name, source] of sources) decoded.set(name, await decode(owned.get(source.imagePath), source.width, source.height));
  const groups = new Map();
  for (const frame of selected) {
    const source = sources.get(frame.sourceAtlasPath), rect = source.cells.get(frame.sourceKey), image = decoded.get(frame.sourceAtlasPath);
    const rgba = Buffer.alloc(frame.width * frame.height * 4);
    for (let y = 0; y < frame.height; y++) image.copy(rgba, y * frame.width * 4,
      ((rect.y + y) * source.width + rect.x) * 4, ((rect.y + y) * source.width + rect.x + frame.width) * 4);
    if (hash(rgba) !== frame.rgbaSha256) refuse(`RGBA cell digest changed: ${frame.sourceKey}`);
    const cells = groups.get(frame.group) ?? [];
    cells.push({ ...frame, rgba }); groups.set(frame.group, cells);
  }
  if (groups.size > 64) refuse('destination group limit');
  const output = new Map();
  let outputDecodedBytes = 0;
  for (const group of [...groups.keys()].sort()) {
    const cells = groups.get(group).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    const slotW = Math.max(...cells.map(cell => cell.width)) + 4, slotH = Math.max(...cells.map(cell => cell.height)) + 4;
    const maxColumns = Math.floor(4096 / slotW), maxRows = Math.floor(4096 / slotH), minimumColumns = Math.ceil(cells.length / maxRows);
    if (minimumColumns > maxColumns) refuse(`destination texture limit: ${group}`);
    const columns = Math.max(minimumColumns, Math.min(maxColumns, Math.ceil(Math.sqrt(cells.length * slotH / slotW))));
    const width = columns * slotW, height = Math.ceil(cells.length / columns) * slotH;
    outputDecodedBytes += width * height * 4;
    if (outputDecodedBytes > maxPixelsBytes) refuse('destination decoded-byte limit');
    const data = Buffer.alloc(width * height * 4), packed = [];
    for (const [index, cell] of cells.entries()) {
      const x = (index % columns) * slotW + 2, y = Math.floor(index / columns) * slotH + 2;
      for (let row = 0; row < cell.height; row++) cell.rgba.copy(data, ((y + row) * width + x) * 4,
        row * cell.width * 4, (row + 1) * cell.width * 4);
      packed.push({ filename: cell.key, rotated: false, trimmed: false,
        sourceSize: { w: cell.width, h: cell.height }, spriteSourceSize: { x: 0, y: 0, w: cell.width, h: cell.height },
        frame: { x, y, w: cell.width, h: cell.height } });
    }
    const argument = { data: Buffer.from(data), width, height }, encoded = await encodePng(argument);
    if (!Buffer.isBuffer(argument.data) || !argument.data.equals(data) || argument.width !== width || argument.height !== height) refuse('callback mutated its raw input');
    if (!Buffer.isBuffer(encoded) || !integer(encoded.length, 1, 64 * 1024 * 1024)) refuse('invalid encoded PNG');
    const png = Buffer.from(encoded), roundTrip = await decode(png, width, height);
    if (!roundTrip.equals(data)) refuse(`round-trip pixels changed: ${group}`);
    const texture = { image: `${group}@1x.png`, format: 'RGBA8888', size: { w: width, h: height }, scale: 1, frames: packed };
    output.set(`atlas/${group}@1x.json`, Buffer.from(JSON.stringify({ textures: [texture] }) + '\n'));
    output.set(`atlas/${group}@1x.png`, png);
  }
  return output;
}

/** Project the composed server's authored families onto the unchanged contract-15
 * service graph. This is a key/atlas projection, never art generation or scaling.
 * Unrelated source fleet/cosmetics metadata remains in atlas/meta.json. */
export function composeServiceMetadata(meta, reducedMotionImage) {
  const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
  const same = (a, b) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
  const requireValue = (ok, label) => { if (!ok) fail(`composed source ${label}`); };
  const sequence = n => Array.from({ length: n }, (_, i) => i);
  const realms = ['frostveil', 'elderwood', 'sunscar', 'crownlands', 'seeker-reach', 'stormcairn', 'thornwake', 'cinderfall'];
  const fleets = ['starter', 'survey-balloon', 'cargo-cutter', 'courier-airship', 'expedition-barge'];
  const stateNames = ['idle', 'working', 'damaged', 'ready', 'destroyed', 'construction', 'collapse'];
  requireValue(!meta.peAppearances && !meta.peEffects, 'mixes legacy and composed graphs');
  exactKeys(reducedMotionImage, ['path', 'sha256', 'bytes'], 'craft-success still');
  requireValue(reducedMotionImage.path === 'production-assets/shared-fx/craft-success/frames/frame-00.png'
    && hex64(reducedMotionImage.sha256) && isInt(reducedMotionImage.bytes, 1), 'craft-success still descriptor');
  const services = meta.peServiceBuildings, harvesters = meta.peHarvesters, market = meta.peMarket;
  const starter = meta.peStarterFleet, advanced = meta.peAdvancedFleet;
  for (const table of [services, harvesters, market, starter, advanced]) {
    requireValue(table?.schemaVersion === 1 && table.sourceScale === 1 && table.sourceIndexBase === 0 && table.keyIndexBase === 1, 'table header');
  }
  requireValue(same(services.families, ['workshop', 'lodge']) && market.family === 'market' && harvesters.family === 'harvester'
    && harvesters.runtimeReady === true && harvesters.runtimeApproval === 'D153.302-tester', 'family identity/admission');
  for (const table of [services, harvesters, market, advanced]) {
    requireValue(table.clips && Array.isArray(table.atlases) && new Set(table.atlases).size === table.atlases.length, 'clip/group table');
    const digests = [table.indexSha256 ?? table.sourceIndexSha256,
      ...Object.values(typeof table.sourceManifestSha256 === 'object' ? table.sourceManifestSha256 : { digest: table.sourceManifestSha256 }),
      ...Object.values(typeof table.provenanceSha256 === 'object' ? table.provenanceSha256 : { digest: table.provenanceSha256 })];
    requireValue(digests.every(hex64), 'table provenance');
    if (table !== market) requireValue(table.bindings && !Array.isArray(table.bindings)
      && same(Object.keys(table.bindings).sort(), [...table.atlases].sort()), 'binding group closure');
    if (table.bindings) for (const [atlas, binding] of Object.entries(table.bindings)) {
      requireValue(table.atlases.includes(atlas) && binding.value?.atlas === atlas && binding.value.version === 1
        && binding.sha256 === hash(JSON.stringify(binding.value)) && Array.isArray(binding.value.clips), `binding ${atlas}`);
      const value = binding.value;
      const manifest = table === services ? table.sourceManifestSha256[value.family === 'workshop' ? 'workshop' : 'services'] : table.sourceManifestSha256;
      requireValue(value.sourceManifestSha256 === manifest && value.sourceIndexSha256 === (table.indexSha256 ?? table.sourceIndexSha256)
        && (table === advanced ? value.sourceTracksSha256 === table.sourceTracksSha256 : value.sourceScale === 1), `binding provenance ${atlas}`);
      const sourceIds = Object.keys(table.clips).filter(id => table === advanced ? table.clips[id].atlas === atlas : id.startsWith(`${atlas}_`));
      requireValue(same(value.clips.map(clip => clip.id).sort(), sourceIds.sort()), `binding clip closure ${atlas}`);
      for (const { id, ...clip } of binding.value.clips) requireValue(same(clip, table.clips[id]), `bound clip ${id}`);
    }
  }
  requireValue(starter.atlas === 'pe_fleet_starter' && starter.awayComposition === 'intact + ambient; no vehicle', 'starter identity');
  const starterValue = {
    schemaVersion: starter.schemaVersion, atlas: starter.atlas, sourceScale: starter.sourceScale,
    sourceIndexBase: starter.sourceIndexBase, keyIndexBase: starter.keyIndexBase,
    sourceManifestSha256: starter.sourceManifestSha256, sourceTracksSha256: starter.sourceTracksSha256,
    sourceFxManifestSha256: starter.sourceFxManifestSha256, sourceIndexSha256: starter.sourceIndexSha256,
    provenanceSha256: starter.provenanceSha256, fxProvenanceSha256: starter.fxProvenanceSha256,
    clips: meta.peClips, tracks: meta.peTracks, geometry: starter.geometry, awayComposition: starter.awayComposition,
  };
  requireValue(['sourceManifestSha256', 'sourceTracksSha256', 'sourceFxManifestSha256', 'sourceIndexSha256', 'provenanceSha256', 'fxProvenanceSha256']
    .every(key => hex64(starter[key])) && hash(JSON.stringify(starterValue)) === starter.bindingSha256, 'starter binding');
  const metadata = { peClips: {}, peAppearances: {}, peEffects: { 'craft-success': { clip: 'pe_fx_craft-success', anchor: [0.5, 0.5] } } };
  const frames = [], wanted = new Map([[services, new Set()], [market, new Set()], [harvesters, new Set()]]);
  const digest = frame => frame.rgbaSha256 ?? frame.sha256;
  const checkClip = (table, atlas, id, count, loop, kind = 'service', isStarter = false) => {
    const clip = table.clips[id], effect = kind === 'effect', edge = effect ? 64 : 112;
    requireValue(clip && typeof clip.sourcePath === 'string' && clip.sourcePath.length > 0 && hex64(clip.sourceSha256), `clip provenance ${id}`);
    requireValue(clip.cellW === edge && clip.cellH === edge && same(clip.anchorPx, effect ? [32, 32] : [56, 112])
      && clip.anchorKind === (effect ? 'centre' : 'cellBottomPivotX') && clip.fps === (count === 1 ? 0 : 8) && clip.loop === loop, `clip geometry/clock ${id}`);
    if (kind === 'service') requireValue(same(clip.sourcePivot, [56, 104]) && same(clip.footprint, [2, 2]), `source pivot ${id}`);
    if (clip.playbackFrameIndices !== undefined) requireValue(same(clip.playbackFrameIndices, sequence(loop ? 8 : count)), `playback ${id}`);
    requireValue(Array.isArray(clip.frames) && clip.frames.length === count, `frame count ${id}`);
    clip.frames.forEach((frame, index) => {
      requireValue(frame.sourceIndex === index && frame.key === `${clip.alias ?? id}_f${index + 1}`
        && hex64(isStarter ? frame.sha256 : frame.rgbaSha256)
        && !(isStarter ? 'rgbaSha256' in frame : 'sha256' in frame), `frame identity/hash ${id}`);
      if (frame.sourceRect) requireValue([frame.sourceRect.x, frame.sourceRect.y].every(n => isInt(n))
        && frame.sourceRect.w === edge && frame.sourceRect.h === edge, `source rectangle ${id}`);
    });
    if (table.bindings) requireValue(table.bindings[atlas]?.value.clips.some(bound => bound.id === id), `missing binding ${id}`);
    if (wanted.has(table)) wanted.get(table).add(id);
    return clip;
  };
  const mapFrames = (clip, atlas, id, group) => clip.frames.map((frame, index) => {
    const key = `${id}_f${index + 1}`, sha256 = digest(frame);
    frames.push({ key, group, sourceAtlasPath: `atlas/${atlas}@1x.json`, sourceKey: frame.key, width: clip.cellW, height: clip.cellH, rgbaSha256: sha256 });
    return { sourceIndex: index, key, sha256, hashDomain: 'rgba-cell' };
  });
  const animated = (clip, atlas, id, group, kind = 'service') => {
    metadata.peClips[id] = {
      frames: mapFrames(clip, atlas, id, group), playbackIndices: sequence(clip.loop ? 8 : clip.frames.length),
      fps: clip.fps, loop: clip.loop, cellW: clip.cellW, cellH: clip.cellH, anchorPx: [...clip.anchorPx], anchorKind: clip.anchorKind,
      ...(kind !== 'effect' ? { footprint: [2, 2] } : {}),
      ...(kind !== 'service' ? { providerIndices: sequence(8).map(i => i + 1), reducedMotion: kind === 'effect' ? { image: { ...reducedMotionImage } } : { frame: 0 } } : {}),
    };
    return { kind: 'clip', clip: id };
  };
  const geometry = () => ({ cell: [112, 112], footprint: [2, 2], drawScale: 1, deedScale: 0.5, seat: 'full-cell-bottom', horizontalPivot: 56, cellBottom: 112 });
  let effect;
  for (let tier = 1; tier <= 4; tier++) for (const family of ['workshop', 'lodge', 'market', ...realms]) {
    const harvester = realms.includes(family), facility = harvester ? 'harvester' : family;
    const table = harvester ? harvesters : family === 'market' ? market : services;
    const atlas = harvester ? `pe_harvester_${family.replaceAll('-', '_')}_t${tier}` : `pe_${family}_t${tier}`;
    const prefix = harvester ? `pe_harv_${family}_t${tier}` : atlas;
    const id = harvester ? `harvester-${family}-t${tier}` : `${family}-t${tier}`;
    requireValue(table.atlases.includes(atlas), `missing group ${atlas}`);
    if (table !== market) requireValue(table.bindings[atlas].value.family === facility && table.bindings[atlas].value.tier === tier, `binding identity ${atlas}`);
    const sourceClips = {};
    for (const state of stateNames) {
      const moving = ['working', 'construction', 'collapse'].includes(state);
      const count = moving ? state === 'working' && ['lodge', 'market'].includes(facility) ? 8 : 9 : 1;
      sourceClips[state] = checkClip(table, atlas, `${atlas}_${state}`, count, state === 'working');
    }
    const at = (state, index = 0) => digest(sourceClips[state].frames[index]);
    requireValue(at('construction', 8) === at('idle') && at('collapse') === at('damaged') && at('collapse', 8) === at('destroyed'), `transition endpoints ${atlas}`);
    if (facility === 'workshop') requireValue(at('working') === at('working', 8), `loop closure ${atlas}`);
    if (harvester) requireValue(at('working') === at('idle') && at('working', 8) === at('idle'), `loop closure ${atlas}`);
    if (family === 'lodge' || family === 'market') {
      requireValue(at('destroyed') === digest(services.clips[`pe_workshop_t${tier}_destroyed`].frames[0]), `rubble alias ${atlas}`);
      requireValue(sourceClips.ready.alias === `${atlas}_idle` && at('ready') === at('idle')
        && same(sourceClips.ready.overlay, { clip: `${atlas}_ready_fx`, offset: [24, 0] }), `ready alias ${atlas}`);
    }
    if (!harvester) {
      const fx = checkClip(table, atlas, `${atlas}_ready_fx`, 8, false, 'effect');
      if (!effect) effect = { clip: fx, atlas };
      requireValue(same(fx.frames.map(digest), effect.clip.frames.map(digest)), `shared effect ${atlas}`);
    } else {
      const binding = table.bindings[atlas].value;
      requireValue(same(binding.aliases, { rubble: `${atlas}_destroyed` }) && same(binding.readyComposition,
        { alreadyComposed: true, fxId: 'craft-success', sourceOffsetPx: [24, -12] }), `harvester composition ${atlas}`);
      requireValue(binding.sourceProvenanceSha256 === table.provenanceSha256 && hex64(binding.scaffold?.sourceSha256)
        && binding.scaffold.rgbaSha256 === at('construction'), `harvester scaffold ${atlas}`);
    }
    const states = {};
    const stills = facility === 'workshop' ? ['idle', 'ready', 'damaged', 'rubble'] : harvester ? ['idle', 'ready', 'damaged', 'destroyed'] : ['idle', 'damaged'];
    for (const state of stills) {
      const mapped = mapFrames(sourceClips[state === 'rubble' ? 'destroyed' : state], atlas, `${prefix}_${state}`, prefix);
      states[state] = { kind: 'static', key: mapped[0].key };
    }
    for (const state of ['working', 'construction', 'collapse']) states[state] = animated(sourceClips[state], atlas, `${prefix}_${state}`, prefix);
    if (harvester) states.rubble = { kind: 'alias', target: { appearance: id, state: 'destroyed' } };
    else states.destroyed = { kind: 'alias', target: { appearance: `workshop-t${tier}`, state: 'rubble' } };
    if (family === 'lodge' || family === 'market') states.ready = { kind: 'composition', parts: [{ appearance: id, state: 'idle' }], overlay: { effect: 'craft-success', offset: [24, 0] } };
    metadata.peAppearances[id] = { id, facility, family, tier, geometry: { ...geometry(), sourcePivot: [56, 104], contactLine: 104,
      ...(['lodge', 'market'].includes(facility) ? { providerCell: [80, 80] } : {}) }, states };
  }
  for (const [table, selected] of wanted) requireValue(Object.keys(table.clips).length === selected.size
    && table.atlases.length === (table === services ? 8 : table === market ? 4 : 32), 'closed facility group/state set');
  for (const family of fleets) {
    const isStarter = family === 'starter', atlas = isStarter ? starter.atlas : `pe_berth_${family.replaceAll('-', '_')}`;
    const sourcePrefix = `pe_berth_${family.replaceAll('-', '_')}`, prefix = `pe_berth_${family}`, id = `${family}-berth`;
    const table = isStarter ? { clips: meta.peClips } : advanced, states = {}, aerial = ['survey-balloon', 'courier-airship'].includes(family);
    const groundContact = [56, 93], attachment = [56, aerial ? 56 : 78], tidalGate = aerial ? null : [56, 28];
    const sourceGeometry = { cell: [112, 112], horizontalPivot: 56, sourceCellBottom: 112, drawScale: 1, footprint: [2, 2], groundContact, attachment, tidalGate };
    if (!isStarter) {
      const binding = advanced.bindings[atlas]?.value;
      requireValue(advanced.atlases.includes(atlas) && binding?.awayComposition === 'intact + ambient; no vehicle'
        && binding.sourceAssetId === id && binding.sourceFamily === family && binding.kind === 'berth' && binding.tier === null
        && same(binding.geometry, sourceGeometry) && same(binding.track, advanced.tracks?.families?.[family]), `berth composition/identity ${family}`);
    }
    for (const state of ['intact', 'damaged', 'destroyed', 'ambient']) {
      const ambient = state === 'ambient', clip = checkClip(table, atlas, `${sourcePrefix}_${state}`, ambient ? 8 : 1, ambient, 'berth', isStarter);
      requireValue(same(clip.geometry, sourceGeometry), `berth geometry ${family}`);
      if (!isStarter) requireValue(clip.atlas === atlas && clip.sourceAssetId === id, `berth identity ${family}`);
      if (ambient) {
        requireValue(same(clip.providerIndices, sequence(8).map(i => i + 1)) && clip.reducedMotionFrame === 0, `berth provider/RM ${family}`);
        if (!isStarter) requireValue(clip.frames.every((f, i) => f.providerIndex === i + 1), `berth provider frames ${family}`);
        states.ambient = animated(clip, atlas, `${prefix}_ambient`, 'pe_fleet_berths', 'berth');
      } else states[state] = { kind: 'static', key: mapFrames(clip, atlas, `${prefix}_${state}`, 'pe_fleet_berths')[0].key };
    }
    states.away = { kind: 'composition', parts: [{ appearance: id, state: 'intact' }, { appearance: id, state: 'ambient' }] };
    metadata.peAppearances[id] = { id, facility: 'berth', family, tier: null, geometry: { ...geometry(), groundContact, attachment, tidalGate }, states };
  }
  animated(effect.clip, effect.atlas, 'pe_fx_craft-success', 'pe_fx', 'effect');
  requireValue(Object.keys(metadata.peClips).length === 138 && Object.keys(metadata.peAppearances).length === 49
    && frames.length === 1403 && new Set(frames.map(f => f.key)).size === 1403 && new Set(frames.map(f => f.group)).size === 46, 'contract-15 closure');
  return { metadata, frames };
}

export async function buildComposedServiceCatalogue({ meta, reducedMotionImage, assets, inspectPng, decodePng, encodePng }) {
  const { metadata, frames } = composeServiceMetadata(meta, reducedMotionImage);
  const projected = await projectServiceAssets({ frames, assets, inspectPng, decodePng, encodePng });
  const groups = new Set(frames.map(frame => frame.group)), routing = new Map(frames.map(frame => [frame.key, frame.group]));
  const phaseE = await buildServiceCatalogue({ meta: metadata, parsePhaseEArt: value => value,
    atlasGroupFor: key => routing.get(key), isPhaseEServiceAtlasGroup: group => groups.has(group), assets: projected, inspectPng });
  return { phaseE, assets: projected };
}

export function craftSuccessImage(manifest, bytes, info) {
  const effects = manifest?.effects?.filter(effect => effect.id === 'craft-success');
  if (manifest?.schemaVersion !== 1 || JSON.stringify(manifest.exportFrameIndices) !== '[1,2,3,4,5,6,7,8]'
    || effects?.length !== 1 || effects[0].reducedMotion !== 'craft-success/frames/frame-00.png'
    || !Buffer.isBuffer(bytes) || bytes.length === 0 || hash(bytes) !== effects[0].frameHashes?.[0]
    || info?.format !== 'png' || info.width !== 64 || info.height !== 64 || info.depth !== 'uchar'
    || !info.hasAlpha || (info.pages !== undefined && info.pages !== 1)) fail('craft-success original frame-zero proof changed');
  return { path: 'production-assets/shared-fx/craft-success/frames/frame-00.png', sha256: hash(bytes), bytes: bytes.length };
}

/** Both source and projected bytes belong to the pack. Only colliding source
 * paths move, together in one directory so JSON image references still resolve. */
export function serviceAssetEntries(sourceAssets, projectedAssets) {
  const result = new Map();
  const add = (name, bytes) => {
    if (result.has(name)) fail(`service staging collision: ${name}`);
    result.set(name, bytes);
  };
  for (const [name, bytes] of sourceAssets) {
    if (!/^atlas\/pe_[a-z0-9_-]+@1x\.(json|png)$/.test(name)) fail(`foreign source service path: ${name}`);
    add(projectedAssets.has(name) ? name.replace('atlas/', 'atlas/source-phase-e/') : name, bytes);
  }
  for (const [name, bytes] of projectedAssets) {
    if (!/^atlas\/pe_[a-z0-9_-]+@1x\.(json|png)$/.test(name)) fail(`foreign projected service path: ${name}`);
    add(name, bytes);
  }
  return [...result].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

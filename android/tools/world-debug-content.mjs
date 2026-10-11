// Bundled world content for every APK (D-171 debug delivery, then D-NEXT: the new world ships in the release APK, no
// download; plan §6.3). The command keeps its historical name so the integrator's recipe still works.
//
//   node tools/world-debug-content.mjs --source <SHARDKEEP-globe repo>          copy + verify into app/src/main/assets/world
//   node tools/world-debug-content.mjs --source <SHARDKEEP-globe repo> --check  the installed copy is exactly what the pin names
//   node tools/world-debug-content.mjs --verify                                 source-free: every file against content.json,
//                                                                               content.json against the lock's pin
//
// What is copied: the files N1 (flat globe), N2 (overview realm maps) and N3 (MAP/TRUE detail: GROUND, LIFE, BASES) read,
// plus the Phase E island art (every build type since the owner's 2026-09-26 call; D-172 had it in test builds only) (with `"phaseEIslands": true` in content.json, the flag the
// native globe's Phase E layer waits for), and nothing else (selection() below). The N3 files are read
// from each realm's own realm.json the way the native lanes read it (laneReads), so the bundle carries exactly the pack
// keys GroundLoad/LifeLoad/BasesLoad open. Every byte is checked against the pack manifest committed AT the shader pin
// (world-shaders.lock.json `contentManifest`, plan §6.1): the manifest is read with `git show <pin>:…` and its sha256 must
// be the lock's, and every copied file (and every realm.json / shared JSON the selection is read from) must have the
// manifest's size and sha256, or nothing is written. The copy is staged under app/build/tmp and swapped in with one
// rename, so the app never sees half a generation. The destination is app/src/main/assets/world, which every build type
// packages (D-NEXT), gitignored like the imported client pack beside it (app/src/main/assets/native):
// `world/content.json` lists every file with its size and sha256; the app verifies each file at load, and the app's
// gradle gate (verifyWorldContent) refuses to package a variant whose copy is missing, names another pin or pack manifest
// than world-shaders.lock.json, or has a file of the wrong size or sha256. This tool writes one bundle for every build
// type, islands included; checkReleasePhaseEOn fails a release whose packaged content.json does not say true.
// The retired debug-only location (app/src/debug/assets/world) is removed by a successful install: a debug APK packages
// src/debug/assets over src/main/assets, so a leftover copy would shadow the pinned one file by file.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONCEPT, LOCK_FILE, PACK_MANIFEST } from './world-shaders.mjs';

export const PACK_DIR = `${CONCEPT}/pack`;
export const OUT_DIR = 'app/src/main/assets/world';
/** Where D-171 put the debug-only copy; a debug APK would package it over OUT_DIR, so install retires it. */
export const LEGACY_DIR = 'app/src/debug/assets/world';
export const INDEX = 'content.json';
/** The lead's bar for the bundled copy (about 40 MB); over it the tool refuses instead of bloating every APK (the APK
 *  itself is held under the in-app updater's cap by the app's gradle size gate). */
export const BUDGET_BYTES = 40 * 1000 * 1000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const FACES = [0, 1, 2, 3, 4, 5];

/**
 * The pack keys the native N3 lanes open for one realm, read from its realm.json exactly as the Kotlin loaders read it
 * (at fc0d490): GroundLoad opens fieldsA.png, fieldsBC.png and lines.json by name, then tone, plots (with yards),
 * map.atlas and map.mask (default mapmask.png), true.atlas, true.mask (default groundmask.png) and true.decals; LifeLoad
 * sprites.atlas, creatures.atlas and map.atlas; BasesLoad sprites.atlas, creatures.atlas, edges.atlas (default the sprite
 * atlas), plots (with minis) and true.atlas. chart8/deeds/realm.json are N2's first-frame set. Not read by any lane, so
 * not bundled: chart16-* (FAR stays chart8), the dprime/optionE map variants and notes/.
 */
export function laneReads(realm) {
  const keys = new Set(['fieldsA.png', 'fieldsBC.png', 'lines.json']);
  const add = k => { if (typeof k === 'string' && k) keys.add(k); };
  add(realm.tone?.file);
  if (realm.plots?.yards?.length || realm.plots?.minis != null) add(realm.plots?.file);
  if (realm.map) { add(realm.map.atlas?.file); add(realm.map.mask?.file ?? 'mapmask.png'); }
  if (realm.true) { add(realm.true.atlas?.file); add(realm.true.mask?.file ?? 'groundmask.png'); add(realm.true.decals?.file); }
  add(realm.sprites?.atlas);
  add(realm.creatures?.atlas);
  if (realm.edges?.pieces) add(realm.edges.atlas ?? realm.sprites?.atlas);
  return [...keys].sort();
}
/** The shared realm-map pack BASES and LIFE open (realm/shared): each JSON and the atlas it names (BasesLoad, LifeLoad). */
export const SHARED_JSON = [['keeps.json', 'keeps.png'], ['decor.json', 'decor.png'], ['fx.json', null]];

/**
 * The files the native world reads, as pack-relative paths.
 * - N1 globe: globe-v2.json, the a256/a1024 albedo cube, the ssg512 cube, one selection field per realm, the c512 cloud
 *   cube (GlobeContent) and the 8 realm paintings.
 * - D-172 (debug builds show the Phase E islands): each island's prebaked field globe-v2/phase-e/sel-<id>.png and its
 *   close-range art <id>.webp, for every island the pinned manifest carries a field for.
 * - N2 realms: realm/index.json and per realm realm.json, chart8.webp, deeds.png.
 * - N3 detail: per realm the laneReads() keys (`detail`), and the shared JSONs with their atlases (`shared`).
 * Deliberately left out: globe-v2/face-*.png (lossless QA masters of the a1024 cube), baked/a256|a1024 (the concept cube
 * with baked islets; globe-v2 replaces it), baked/h128|h512|m512 (the relief path's height and hint cubes: the native
 * globe draws globe-flat and no code reads them), the composite inputs (face-*, height-*, island-*, equirect), detail/**
 * (a 22 MB Crownlands prototype), keeps/** and every realm file no lane opens (chart16, variants, notes).
 */
export function selection(realmIds, { detail = new Map(), shared = [], islands = [] } = {}) {
  const globe = [
    'globe-v2/globe-v2.json',
    ...FACES.flatMap(f => [`globe-v2/a256-${f}.webp`, `globe-v2/a1024-${f}.webp`, `globe-v2/ssg512-${f}.png`]),
    ...realmIds.map(id => `globe-v2/sel-${id}.png`),
    ...FACES.map(f => `baked/c512-${f}.webp`), // the cloud shell (uCloud)
    ...realmIds.map(id => `${id}.webp`), // the 8 realm paintings
    ...islands.flatMap(id => [`globe-v2/phase-e/sel-${id}.png`, `${id}.webp`]),
  ];
  const realm = ['realm/index.json', ...realmIds.flatMap(id => ['realm.json', 'chart8.webp', 'deeds.png'].map(f => `realm/${id}/${f}`))];
  const lanes = [...realmIds.flatMap(id => (detail.get(id) ?? []).map(k => `realm/${id}/${k}`)), ...shared.map(k => `realm/shared/${k}`)];
  return [...new Set([...globe, ...realm, ...lanes])];
}

const git = (repo, args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 1 << 28 });
/** The pinned manifest, proven to be the one the shader lock names. */
export function pinnedManifest(repo, lock) {
  const pin = lock?.source?.commit, want = lock?.contentManifest;
  if (!/^[0-9a-f]{40}$/.test(pin ?? '')) throw new Error(`${LOCK_FILE} names no pin`);
  if (!want?.sha256) throw new Error(`${LOCK_FILE} records no contentManifest: re-pin at a commit that carries ${PACK_MANIFEST}`);
  let bytes;
  try { bytes = git(repo, ['show', `${pin}:${want.path ?? PACK_MANIFEST}`]); } catch { throw new Error(`${want.path ?? PACK_MANIFEST} is not in ${pin}`); }
  if (sha256(bytes) !== want.sha256) throw new Error(`the manifest at ${pin.slice(0, 8)} is not the one ${LOCK_FILE} pinned`);
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.schema !== 1 || manifest.kind !== 'shardkeep-globe-pack-manifest') throw new Error('not a schema-1 globe pack manifest');
  return { pin, manifest, sha256: want.sha256 };
}

/** Phase E islands with a prebaked field in the manifest (globe-v2/phase-e/sel-<id>.png), sorted. */
export const islandsOf = manifest => manifest.files.map(f => /^globe-v2\/phase-e\/sel-([a-z0-9-]+)\.png$/.exec(f.path)?.[1]).filter(Boolean).sort();

/**
 * The planned copy: [{ path, sha256, bytes }] in selection order, or an Error listing every file the pin cannot supply.
 * readJson(path) returns a pack JSON the selection is read from (realm.json, the shared JSONs), already verified against
 * the manifest. A lane key its realm.json does not pin in `files` is refused: the native loaders refuse it too.
 */
export function plan(manifest, readJson) {
  const realmIds = manifest.realms.map(r => r.id).sort();
  if (!realmIds.length) throw new Error('the pinned manifest lists no realm');
  const detail = new Map(), unpinned = [];
  for (const id of realmIds) {
    const realm = readJson(`realm/${id}/realm.json`), keys = laneReads(realm);
    for (const k of keys) if (!realm.files?.[k]?.sha256) unpinned.push(`realm/${id}/${k}`);
    detail.set(id, keys);
  }
  if (unpinned.length) throw new Error(`realm.json pins no sha256 for ${unpinned.length} file(s) the lanes read:\n  ${unpinned.join('\n  ')}`);
  const shared = SHARED_JSON.flatMap(([name, atlas]) => {
    const a = readJson(`realm/shared/${name}`).atlas ?? atlas;
    if (typeof a !== 'string' || !a) throw new Error(`realm/shared/${name} names no atlas`);
    return [name, a];
  });
  const byPath = new Map(manifest.files.map(f => [f.path, f])), missing = [], files = [], islands = islandsOf(manifest);
  for (const p of selection(realmIds, { detail, shared, islands })) { const f = byPath.get(p); if (!f) missing.push(p); else files.push({ path: p, sha256: f.sha256, bytes: f.bytes }); }
  if (missing.length) throw new Error(`the pinned manifest lacks ${missing.length} file(s) the native world reads:\n  ${missing.join('\n  ')}`);
  const total = files.reduce((s, f) => s + f.bytes, 0);
  if (total > BUDGET_BYTES) throw new Error(`the world content is ${total} bytes, over the ${BUDGET_BYTES}-byte budget`);
  return { realmIds, files, total, islands };
}

/** readJson over the pack on disk: a file the manifest does not pin, or pins with other bytes, is refused. */
export function packJson(repo, manifest) {
  const byPath = new Map(manifest.files.map(f => [f.path, f]));
  return rel => {
    const f = byPath.get(rel), src = path.join(repo, PACK_DIR, rel);
    if (!f) throw new Error(`the pinned manifest lacks ${rel}`);
    if (!fs.existsSync(src)) throw new Error(`REFUSED: missing on disk: ${rel}`);
    const b = fs.readFileSync(src);
    if (b.length !== f.bytes || sha256(b) !== f.sha256) throw new Error(`REFUSED: ${rel} on disk is not the pinned file`);
    return JSON.parse(b.toString('utf8'));
  };
}

const json = v => Buffer.from(JSON.stringify(v, null, 2) + '\n');
/**
 * `phaseEIslands` (D-172): true when the bundle carries the Phase E islands' fields and art (every island the pinned
 * manifest has a field for, both files, verified like the rest). The native globe turns its Phase E layer on only when
 * it reads exactly `true` here. Every build type carries this bundle (D-NEXT), and since the owner's 2026-09-26 call the
 * release shows the islands too: checkReleasePhaseEOn (app/build.gradle.kts) fails a release whose index is not true.
 */
export function indexOf({ pin, manifest, sha256: manifestSha }, { files, total, islands = [] }) {
  return json({
    schema: 1,
    kind: 'pkw-world-debug-content',
    note: 'Bundled in every build type (tools/world-debug-content.mjs). Paths are relative to the assets root world/. Verify each file against its sha256 before use.',
    pin,
    manifest: { path: PACK_MANIFEST, sha256: manifestSha, packVersion: manifest.packVersion },
    phaseEIslands: islands.length > 0,
    realms: manifest.realms.map(r => ({ id: r.id, status: r.status, packVersion: r.packVersion })),
    totals: { files: files.length, bytes: total },
    files,
  });
}

function checkedOut(root, out) {
  const rel = path.relative(root, path.resolve(root, out)).split(path.sep).join('/');
  // only the one directory every build type packages: another source set would leave a build type without the world or
  // shadow this copy, and anything wider would mix it into the client pack (assets/native) or the assets root
  if (!/^app\/src\/main\/assets\/world(?:\/|$)/.test(rel)) throw new Error(`world content goes only into ${OUT_DIR}, not ${rel}`);
  return path.resolve(root, out);
}

const legacyDrift = root => (fs.existsSync(path.join(root, LEGACY_DIR))
  ? [`legacy ${LEGACY_DIR} (a debug APK packages it over ${OUT_DIR}; re-run the tool with --source to retire it)`] : []);

/** Copy, verify and swap in atomically. Nothing is written unless every byte matches the pinned manifest. The retired
 *  debug-only copy (LEGACY_DIR) is removed with the previous generation, only after the new one is in place. */
export function install({ root, repo, out = OUT_DIR, lock }) {
  const pinned = pinnedManifest(repo, lock), p = plan(pinned.manifest, packJson(repo, pinned.manifest)), dest = checkedOut(root, out);
  const pack = path.join(repo, PACK_DIR), bad = [], blobs = [];
  for (const f of p.files) {
    const src = path.join(pack, f.path);
    if (!fs.existsSync(src)) { bad.push(`missing on disk: ${f.path}`); continue; }
    const b = fs.readFileSync(src);
    if (b.length !== f.bytes) bad.push(`size: ${f.path} ${b.length} ≠ ${f.bytes}`); else if (sha256(b) !== f.sha256) bad.push(`sha256: ${f.path}`);
    else blobs.push([f.path, b]);
  }
  if (bad.length) throw new Error(`REFUSED: the pack on disk is not the pinned pack (${bad.length} mismatch(es)); rebuild it or re-pin:\n  ${bad.join('\n  ')}`);
  // staged outside the assets tree (a crash never leaves a half copy where an APK would package it)
  const tmp = path.join(root, 'app/build/tmp'), stage = path.join(tmp, `world-debug-content-${process.pid}`), old = path.join(tmp, `world-debug-content-old-${process.pid}`);
  const legacy = path.join(root, LEGACY_DIR), retired = path.join(tmp, `world-debug-content-legacy-${process.pid}`);
  fs.mkdirSync(tmp, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    for (const [rel, b] of blobs) { const t = path.join(stage, rel); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, b); }
    fs.writeFileSync(path.join(stage, INDEX), indexOf(pinned, p));
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    fs.renameSync(stage, dest);
    if (fs.existsSync(legacy)) fs.renameSync(legacy, retired);
  } finally { for (const d of [stage, old, retired]) fs.rmSync(d, { recursive: true, force: true }); }
  return { ...p, pin: pinned.pin, packVersion: pinned.manifest.packVersion, dest };
}

const walk = (dir, rel = '') => fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
  .flatMap(e => (e.isDirectory() ? walk(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name])).sort();
/** Drift between the installed copy and what the pin names (empty = none). The manifest decides; the only pack bytes read
 *  are the pinned JSONs the selection is read from (realm.json, the shared JSONs). */
export function check({ root, repo, out = OUT_DIR, lock }) {
  const pinned = pinnedManifest(repo, lock), p = plan(pinned.manifest, packJson(repo, pinned.manifest)), dest = checkedOut(root, out), drift = [];
  if (!fs.existsSync(dest)) return [`missing ${out} (run the tool)`, ...legacyDrift(root)];
  const want = new Map(p.files.map(f => [f.path, f]));
  for (const rel of walk(dest)) {
    if (rel === INDEX) continue;
    const f = want.get(rel);
    if (!f) { drift.push(`extra ${rel}`); continue; }
    if (sha256(fs.readFileSync(path.join(dest, rel))) !== f.sha256) drift.push(`changed ${rel}`);
    want.delete(rel);
  }
  for (const rel of want.keys()) drift.push(`missing ${rel}`);
  const idx = path.join(dest, INDEX);
  if (!fs.existsSync(idx) || !fs.readFileSync(idx).equals(indexOf(pinned, p))) drift.push(`changed ${INDEX}`);
  return [...drift, ...legacyDrift(root)];
}
const short = v => (typeof v === 'string' ? v.slice(0, 8) : String(v));
/**
 * content.json against the checkout's shader lock (empty = the bundle is the content the lock pins). The bundle is
 * gitignored, so it outlives a re-pin: a copy from the old pin still matches its own content.json file by file, and would
 * ship the old realm packs beside the new pin's shaders. Needs no source: the lock names the pin and the pack manifest.
 */
export function pinDrift(index, lock) {
  const pin = lock?.source?.commit, manifest = lock?.contentManifest;
  if (!/^[0-9a-f]{40}$/.test(pin ?? '') || !/^[0-9a-f]{64}$/.test(manifest?.sha256 ?? '')) return [`${LOCK_FILE} names no pin and pack manifest`];
  const drift = [];
  if (index.pin !== pin) drift.push(`pin ${short(index.pin)} is not the lock's ${short(pin)} (re-run the tool with --source)`);
  if (index.manifest?.sha256 !== manifest.sha256) {
    drift.push(`pack manifest ${short(index.manifest?.sha256)} (${index.manifest?.packVersion}) is not the lock's ${short(manifest.sha256)} (${manifest.packVersion}) (re-run the tool with --source)`);
  }
  return drift;
}
/** Source-free: every file content.json lists is present with its sha256, nothing else is there, content.json names the
 *  pin and pack manifest [lock] (the checkout's world-shaders.lock.json) pins, and no retired debug-only copy is left to
 *  shadow it. */
export function verify({ root, out = OUT_DIR, lock }) {
  const dest = checkedOut(root, out), problems = [];
  const idx = JSON.parse(fs.readFileSync(path.join(dest, INDEX), 'utf8')), listed = new Set([INDEX]);
  for (const f of idx.files) {
    listed.add(f.path);
    const p = path.join(dest, f.path);
    if (!fs.existsSync(p)) problems.push(`missing ${f.path}`); else if (sha256(fs.readFileSync(p)) !== f.sha256) problems.push(`sha256 ${f.path}`);
  }
  for (const rel of walk(dest)) if (!listed.has(rel)) problems.push(`unlisted ${rel}`);
  return { index: idx, problems: [...problems, ...pinDrift(idx, lock), ...legacyDrift(root)] };
}

function main(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const root = path.resolve(opt('--root') ?? ROOT), out = opt('--out') ?? OUT_DIR;
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_FILE), 'utf8'));
  if (argv.includes('--verify')) {
    const { index, problems } = verify({ root, out, lock });
    if (problems.length) { console.error(problems.join('\n')); return 1; }
    console.log(`world content: ${index.totals.files} files, ${index.totals.bytes} bytes verified against ${INDEX} (pin ${index.pin.slice(0, 8)}, ${index.manifest.packVersion})`);
    return 0;
  }
  const repo = opt('--source') ?? process.env.PKW_GLOBE_SOURCE;
  if (!repo) throw new Error('Pass --source <SHARDKEEP-globe repo> (or PKW_GLOBE_SOURCE)');
  if (argv.includes('--check')) {
    const drift = check({ root, repo: path.resolve(repo), out, lock });
    if (drift.length) { console.error(`world content drift against ${lock.source.commit.slice(0, 8)}:\n  ${drift.join('\n  ')}`); return 1; }
    console.log(`world content: no drift (pin ${lock.source.commit.slice(0, 8)}, ${lock.contentManifest.packVersion})`);
    return 0;
  }
  const r = install({ root, repo: path.resolve(repo), out, lock });
  console.log(`world content: ${r.files.length} files, ${r.total} bytes (${r.realmIds.length} realms) from ${r.packVersion} at pin ${r.pin.slice(0, 8)} into ${out}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}

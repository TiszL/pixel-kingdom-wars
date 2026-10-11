import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_BYTES, INDEX, LEGACY_DIR, OUT_DIR, PACK_DIR, check, indexOf, install, laneReads, packJson, plan, verify } from './world-debug-content.mjs';
import { LOCK_FILE, PACK_MANIFEST } from './world-shaders.mjs';

// Why: every APK, release included, bundles the world content (D-NEXT; was D-171's debug-only copy). That content must
// be exactly the bytes the shader pin's pack manifest names (plan §6.1): a stale or rebuilt realm pack would draw art
// nobody pinned, in a store build. It lives in the one directory every build type packages, and no second copy may be
// left where a debug build would package it over the first. N3 (MAP/TRUE: "see bases") only draws when the files its
// lanes open are in the bundle, and the APK (held under the in-app updater's cap) should not grow by files nobody
// opens. These tests run on a throwaway globe repo; the real copy is checked by the local gate step
// `node tools/world-debug-content.mjs --source <SHARDKEEP-globe> --check`.
const sha = b => createHash('sha256').update(b).digest('hex');
const REALMS = ['beta', 'alpha'];
// Rewritten for N3 + D-172 (was: "no Phase E, detail or shared file is bundled"): the N3 lane files, the shared realm
// pack and the Phase E island art are bundled now; what must still never ship is what no native code opens.
const EXCLUDED = ['globe-v2/face-0.png', 'baked/a256-0.webp', 'baked/h128-0.webp', 'baked/h512-0.webp', 'baked/m512-0.webp', 'face-0.png',
  'island-0.png', 'detail/alpha/d00.webp', 'keeps/l1.png', 'realm/alpha/chart16-0.webp', 'realm/alpha/optionE/mapkit.png',
  'realm/alpha/notes/engine-owed.json', 'realm/beta/spr-unused.png'];
const LANE_KEYS = ['decals.png', 'fieldsA.png', 'fieldsBC.png', 'ground.png', 'groundmask.png', 'lines.json', 'mapkit.png', 'mapmask.png', 'plots.webp', 'spr.png', 'tone.webp'];
/** What the native world opens in this fixture, written out by hand (never derived by the code under test). */
const WANT = [
  'globe-v2/globe-v2.json', ...[0, 1, 2, 3, 4, 5].flatMap(f => [`globe-v2/a256-${f}.webp`, `globe-v2/a1024-${f}.webp`, `globe-v2/ssg512-${f}.png`, `baked/c512-${f}.webp`]),
  'globe-v2/sel-alpha.png', 'globe-v2/sel-beta.png', 'alpha.webp', 'beta.webp', 'globe-v2/phase-e/sel-seeker-island.png', 'seeker-island.webp',
  'realm/index.json', ...['alpha', 'beta'].flatMap(id => ['realm.json', 'chart8.webp', 'deeds.png'].map(k => `realm/${id}/${k}`)),
  ...LANE_KEYS.map(k => `realm/alpha/${k}`), ...LANE_KEYS.map(k => `realm/beta/${k}`), 'realm/beta/beasts.png',
  ...['keeps.json', 'keeps.png', 'decor.json', 'decor.png', 'fx.json', 'fx-atlas.png'].map(k => `realm/shared/${k}`),
].sort();
function realmJson(id) {
  const keys = [...LANE_KEYS, 'chart8.webp', 'deeds.png', 'chart16-0.webp', ...(id === 'beta' ? ['beasts.png'] : [])];
  return JSON.stringify({
    id, files: Object.fromEntries(keys.map(k => [k, { sha256: 'a'.repeat(64) }])), chart8: { file: 'chart8.webp' }, chart16: { tiles: [{ key: 'chart16-0.webp' }] },
    fields: { fieldsA: { file: 'fieldsA.png' }, fieldsBC: { file: 'fieldsBC.png' }, lines: { file: 'lines.json' } }, tone: { file: 'tone.webp' },
    plots: { file: 'plots.webp', minis: {}, yards: [[0, 0]] }, map: { atlas: { file: 'mapkit.png' }, mask: { file: 'mapmask.png' } },
    mapVariants: { optionE: { atlas: { file: 'mapkit.png' } } }, true: { atlas: { file: 'ground.png' }, mask: { file: 'groundmask.png' }, decals: { file: 'decals.png' } },
    sprites: { atlas: 'spr.png', rects: {} }, creatures: { atlas: id === 'beta' ? 'beasts.png' : 'spr.png', list: [] }, edges: { pieces: {} },
  });
}
const JSONS = {
  'realm/alpha/realm.json': realmJson('alpha'), 'realm/beta/realm.json': realmJson('beta'),
  'realm/shared/keeps.json': '{"atlas":"keeps.png"}', 'realm/shared/decor.json': '{"atlas":"decor.png"}', 'realm/shared/fx.json': '{"atlas":"fx-atlas.png"}',
};

function fixture() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'world-debug-src-')), root = fs.mkdtempSync(path.join(os.tmpdir(), 'world-debug-root-'));
  const g = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { stdio: 'pipe' }).toString().trim();
  g('init', '-q');
  const pack = path.join(repo, PACK_DIR), files = [];
  const put = (rel, text) => { const p = path.join(pack, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); files.push({ path: rel, sha256: sha(Buffer.from(text)), bytes: Buffer.byteLength(text) }); };
  for (const rel of [...WANT, ...EXCLUDED]) put(rel, JSONS[rel] ?? `bytes of ${rel}`);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  const manifest = { schema: 1, kind: 'shardkeep-globe-pack-manifest', packVersion: 'pm1-test', realms: REALMS.map(id => ({ id, status: 'preview', packVersion: `p-${id}` })), files };
  const writeManifest = m => { const p = path.join(repo, PACK_MANIFEST); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(m)); };
  writeManifest(manifest);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'concepts/globe3d-2026-09-23/pack/\n'); // as in the real repo: pack bytes are never in git
  g('add', '-A'); g('commit', '-q', '-m', 'pin');
  const pin = g('rev-parse', 'HEAD'), bytes = fs.readFileSync(path.join(repo, PACK_MANIFEST));
  const lock = { source: { commit: pin }, contentManifest: { path: PACK_MANIFEST, sha256: sha(bytes), packVersion: 'pm1-test' } };
  const cleanup = () => { fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); };
  return { repo, root, pack, pin, lock, manifest, writeManifest, cleanup };
}
const installed = root => {
  const walk = (d, r = '') => fs.readdirSync(path.join(d, r), { withFileTypes: true }).flatMap(e => (e.isDirectory() ? walk(d, r ? `${r}/${e.name}` : e.name) : [r ? `${r}/${e.name}` : e.name]));
  return walk(path.join(root, OUT_DIR)).sort();
};

test('install copies exactly what N1, N2, N3 and the D-172 islands read, verified against the manifest at the pin', () => {
  const f = fixture();
  try {
    const r = install({ root: f.root, repo: f.repo, lock: f.lock });
    assert.deepEqual(installed(f.root), [...WANT, INDEX].sort(), 'every file a native loader opens, and no other pack file');
    for (const ex of EXCLUDED) assert.ok(!installed(f.root).includes(ex), `${ex} is opened by no native code`);
    assert.equal(r.total, WANT.reduce((s, p) => s + Buffer.byteLength(JSONS[p] ?? `bytes of ${p}`), 0));
    const index = JSON.parse(fs.readFileSync(path.join(f.root, OUT_DIR, INDEX), 'utf8'));
    assert.equal(index.pin, f.pin);
    assert.equal(index.manifest.sha256, f.lock.contentManifest.sha256);
    assert.deepEqual(index.realms.map(x => x.id), ['beta', 'alpha'], 'realm provenance as the manifest states it');
    // LanePack refuses a shared file no manifest pins, and RealmLoader.detail a realm file content.json does not list
    for (const e of index.files) assert.equal(e.sha256, sha(fs.readFileSync(path.join(f.root, OUT_DIR, e.path))), e.path);
    assert.ok(index.files.some(e => e.path === 'realm/shared/fx-atlas.png'), 'the shared atlas the fx JSON names');
    assert.ok(index.files.some(e => e.path === 'realm/beta/beasts.png'), 'a realm whose creatures have their own atlas carries it');
    assert.deepEqual(check({ root: f.root, repo: f.repo, lock: f.lock }), []);
    assert.deepEqual(verify({ root: f.root, lock: f.lock }).problems, []);
    assert.ok(!fs.readdirSync(path.join(f.root, 'app/build/tmp')).length, 'no staging directory is left behind');
  } finally { f.cleanup(); }
});

test('content.json says phaseEIslands: true exactly when the bundle carries the Phase E fields and art (D-172), false otherwise (RG-3)', () => {
  // Why: the native globe turns its Phase E layer on only when its world index reads exactly `true`; a bundle without
  // the islands' files must say false so the layer never waits for art that is not there.
  const f = fixture();
  try {
    install({ root: f.root, repo: f.repo, lock: f.lock });
    const index = JSON.parse(fs.readFileSync(path.join(f.root, OUT_DIR, INDEX), 'utf8'));
    assert.equal(index.phaseEIslands, true);
    for (const p of ['globe-v2/phase-e/sel-seeker-island.png', 'seeker-island.webp'])
      assert.ok(index.files.some(e => e.path === p), `${p} is bundled and listed with its sha256`);
    // a pin whose manifest has no Phase E field: no island file is bundled, and the flag is false
    const without = { ...f.manifest, files: f.manifest.files.filter(x => !x.path.startsWith('globe-v2/phase-e/')) };
    const p = plan(without, packJson(f.repo, without));
    assert.deepEqual(p.islands, []);
    assert.ok(!p.files.some(e => e.path === 'seeker-island.webp'), 'the art rides only with its field');
    const idx = JSON.parse(indexOf({ pin: f.pin, manifest: without, sha256: f.lock.contentManifest.sha256 }, p).toString('utf8'));
    assert.equal(idx.phaseEIslands, false);
  } finally { f.cleanup(); }
});

test('laneReads opens what the Kotlin loaders open: literal field names, mask defaults, the edge atlas fallback, plots only with minis or yards', () => {
  assert.deepEqual(laneReads({}), ['fieldsA.png', 'fieldsBC.png', 'lines.json'], 'GroundLoad opens the fields by name');
  assert.deepEqual(laneReads({ map: { atlas: { file: 'mk.png' } }, true: { atlas: { file: 'g.png' } } }),
    ['fieldsA.png', 'fieldsBC.png', 'g.png', 'groundmask.png', 'lines.json', 'mapmask.png', 'mk.png'], 'mapmask.png / groundmask.png are the loaders\' defaults');
  assert.ok(laneReads({ sprites: { atlas: 's.png' }, edges: { pieces: {} } }).includes('s.png'), 'edge pieces fall back to the sprite atlas');
  assert.ok(!laneReads({ plots: { file: 'p.webp' } }).includes('p.webp'), 'plots art without minis or yards is opened by no lane');
  assert.ok(laneReads({ plots: { file: 'p.webp', minis: {} } }).includes('p.webp'));
  assert.ok(!laneReads(JSON.parse(realmJson('alpha'))).some(k => k.startsWith('chart16')), 'FAR stays chart8: no chart16 page is opened');
});

test('a pack that is not the pinned pack is refused, and the previous generation stays intact', () => {
  const f = fixture();
  try {
    install({ root: f.root, repo: f.repo, lock: f.lock });
    const victim = path.join(f.pack, 'realm/alpha/deeds.png'), text = fs.readFileSync(victim, 'utf8');
    fs.writeFileSync(victim, text.replace('bytes', 'bytez')); // same size, other bytes: a rebuilt realm
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: f.lock }), /REFUSED[\s\S]*sha256: realm\/alpha\/deeds.png/);
    fs.writeFileSync(victim, text + '!');
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: f.lock }), /size: realm\/alpha\/deeds.png/);
    fs.rmSync(victim);
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: f.lock }), /missing on disk: realm\/alpha\/deeds.png/);
    assert.deepEqual(verify({ root: f.root, lock: f.lock }).problems, [], 'a refused run writes nothing');
  } finally { f.cleanup(); }
});

test('only the manifest committed at the pin counts, and only the one the shader lock names', () => {
  const f = fixture();
  try {
    // an uncommitted manifest in the working tree (a rebuild in progress) cannot widen what is accepted
    f.writeManifest({ ...f.manifest, files: [] });
    assert.doesNotThrow(() => install({ root: f.root, repo: f.repo, lock: f.lock }));
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: { ...f.lock, contentManifest: { ...f.lock.contentManifest, sha256: '0'.repeat(64) } } }), /is not the one/);
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: { ...f.lock, contentManifest: null } }), /records no contentManifest/);
  } finally { f.cleanup(); }
});

test('the plan fails loudly on a missing file, an unpinned lane file, a rebuilt realm.json or an over-budget copy, and never writes outside the bundled world assets', () => {
  const f = fixture();
  try {
    const read = m => packJson(f.repo, m);
    const m = { ...f.manifest, files: f.manifest.files.filter(x => x.path !== 'realm/beta/chart8.webp' && x.path !== 'realm/alpha/tone.webp') };
    assert.throws(() => plan(m, read(m)), /lacks 2 file[\s\S]*realm\/beta\/chart8.webp[\s\S]*realm\/alpha\/tone.webp/);
    const big = { ...f.manifest, files: f.manifest.files.map(x => (x.path === 'alpha.webp' ? { ...x, bytes: BUDGET_BYTES } : x)) };
    assert.throws(() => plan(big, read(big)), /over the 40000000-byte budget/);
    // the selection is read from the pinned realm.json: a rebuilt one on disk is refused, never trusted
    const victim = path.join(f.pack, 'realm/alpha/realm.json'), text = fs.readFileSync(victim, 'utf8');
    fs.writeFileSync(victim, text.replace('"spr.png"', '"spX.png"'));
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: f.lock }), /REFUSED: realm\/alpha\/realm.json on disk is not the pinned file/);
    fs.writeFileSync(victim, text);
    // a key a lane opens but realm.json does not pin: the native loaders refuse it, so the bundle refuses it first
    const unpinned = JSON.parse(text); delete unpinned.files['decals.png'];
    assert.throws(() => plan(f.manifest, rel => (rel === 'realm/alpha/realm.json' ? unpinned : read(f.manifest)(rel))), /pins no sha256 for 1 file[\s\S]*realm\/alpha\/decals.png/);
    // Rewritten for D-NEXT (was: only app/src/debug/assets/world, never main): the world rides in every build type, so
    // only src/main/assets/world is allowed. A build-type directory would leave the other build type without it (or
    // shadow this copy), and anything wider would write into the imported client pack or the assets root.
    for (const out of ['app/src/debug/assets/world', 'app/src/release/assets/world', 'app/src/main/assets', 'app/src/main/assets/native', '../elsewhere'])
      assert.throws(() => install({ root: f.root, repo: f.repo, lock: f.lock, out }), /only into app\/src\/main\/assets\/world/, out);
  } finally { f.cleanup(); }
});

test('check and verify see every changed, extra or missing file', () => {
  const f = fixture();
  try {
    install({ root: f.root, repo: f.repo, lock: f.lock });
    const dir = path.join(f.root, OUT_DIR);
    fs.appendFileSync(path.join(dir, 'globe-v2/ssg512-0.png'), 'x');
    fs.writeFileSync(path.join(dir, 'stray.bin'), '');
    fs.rmSync(path.join(dir, 'realm/beta/realm.json'));
    assert.deepEqual(check({ root: f.root, repo: f.repo, lock: f.lock }).sort(), ['changed globe-v2/ssg512-0.png', 'extra stray.bin', 'missing realm/beta/realm.json']);
    assert.deepEqual(verify({ root: f.root, lock: f.lock }).problems.sort(), ['missing realm/beta/realm.json', 'sha256 globe-v2/ssg512-0.png', 'unlisted stray.bin']);
    install({ root: f.root, repo: f.repo, lock: f.lock });
    assert.deepEqual(check({ root: f.root, repo: f.repo, lock: f.lock }), [], 'a re-run restores the pinned copy exactly');
  } finally { f.cleanup(); }
});

test('--verify refuses a bundle from another pin or pack manifest, though every file matches its own content.json', () => {
  // Why: the bundle is gitignored, so it outlives a re-pin (the stage-B merge moves world-shaders.lock.json to a new pin
  // and pack manifest). A copy left from the old pin is consistent with itself: a check against content.json alone
  // passes it, and a release ships the old realm packs beside the new pin's shaders and renderer (realm maps stuck at
  // the overview or the legacy globe for every player, nothing logged). Only the checkout's lock says which content it
  // must carry, so the source-free check reads it too, and each of the two pinned names is checked on its own.
  const f = fixture();
  try {
    install({ root: f.root, repo: f.repo, lock: f.lock });
    assert.deepEqual(verify({ root: f.root, lock: f.lock }).problems, [], 'the copy the lock pins');
    const pin = 'b'.repeat(40), manifest = { ...f.lock.contentManifest, sha256: 'c'.repeat(64), packVersion: 'pm1-next' };
    assert.deepEqual(verify({ root: f.root, lock: { ...f.lock, source: { commit: pin } } }).problems,
      [`pin ${f.pin.slice(0, 8)} is not the lock's bbbbbbbb (re-run the tool with --source)`], 'a new pin, same pack manifest');
    assert.deepEqual(verify({ root: f.root, lock: { ...f.lock, contentManifest: manifest } }).problems,
      [`pack manifest ${f.lock.contentManifest.sha256.slice(0, 8)} (pm1-test) is not the lock's cccccccc (pm1-next) (re-run the tool with --source)`], 'a new pack manifest, same pin');
    assert.deepEqual(verify({ root: f.root, lock: {} }).problems, [`${LOCK_FILE} names no pin and pack manifest`], 'no lock, no pass');
    // the command line reads the checkout's own lock
    const cli = () => spawnSync(process.execPath, [fileURLToPath(new URL('./world-debug-content.mjs', import.meta.url)), '--verify', '--root', f.root], { encoding: 'utf8' });
    fs.writeFileSync(path.join(f.root, LOCK_FILE), JSON.stringify({ ...f.lock, source: { commit: pin }, contentManifest: manifest }));
    const stale = cli();
    assert.equal(stale.status, 1, stale.stdout);
    assert.match(stale.stderr, /pin [0-9a-f]{8} is not the lock's bbbbbbbb[\s\S]*pack manifest [0-9a-f]{8} \(pm1-test\) is not the lock's cccccccc/);
    fs.writeFileSync(path.join(f.root, LOCK_FILE), JSON.stringify(f.lock));
    const ok = cli();
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, new RegExp(`pin ${f.pin.slice(0, 8)}, pm1-test`));
  } finally { f.cleanup(); }
});

test('the retired debug-only copy is reported until the tool removes it, and only after a verified install', () => {
  // Why: a debug APK packages src/debug/assets over src/main/assets path by path, so the old D-171 copy would shadow the
  // pinned bundle with another pin's bytes (content.json included): the app would refuse or mix two generations. The
  // documented command migrates a checkout in one run; --check and --verify stay red while a copy is left.
  const f = fixture();
  try {
    const legacy = path.join(f.root, LEGACY_DIR);
    fs.mkdirSync(path.join(legacy, 'realm'), { recursive: true });
    fs.writeFileSync(path.join(legacy, INDEX), '{"stale":true}');
    fs.writeFileSync(path.join(legacy, 'realm/index.json'), 'old pin');
    const pack = path.join(f.root, 'app/src/debug/assets/native/pack.json');
    fs.mkdirSync(path.dirname(pack), { recursive: true });
    fs.writeFileSync(pack, 'debug client pack');
    const victim = path.join(f.pack, 'realm/alpha/deeds.png'), text = fs.readFileSync(victim, 'utf8');
    fs.writeFileSync(victim, text.replace('bytes', 'bytez'));
    assert.throws(() => install({ root: f.root, repo: f.repo, lock: f.lock }), /REFUSED/);
    assert.ok(fs.existsSync(path.join(legacy, INDEX)), 'a refused install leaves the old copy: the checkout keeps a world until a good one replaces it');
    fs.writeFileSync(victim, text);
    install({ root: f.root, repo: f.repo, lock: f.lock });
    fs.mkdirSync(path.join(legacy, 'realm'), { recursive: true });
    fs.writeFileSync(path.join(legacy, INDEX), '{"stale":true}');
    const stale = [`legacy ${LEGACY_DIR} (a debug APK packages it over ${OUT_DIR}; re-run the tool with --source to retire it)`];
    assert.deepEqual(check({ root: f.root, repo: f.repo, lock: f.lock }), stale, '--check sees the shadowing copy');
    assert.deepEqual(verify({ root: f.root, lock: f.lock }).problems, stale, '--verify sees it without the source');
    install({ root: f.root, repo: f.repo, lock: f.lock });
    assert.ok(!fs.existsSync(legacy), 'a verified install retires it');
    assert.equal(fs.readFileSync(pack, 'utf8'), 'debug client pack', 'and nothing else under the debug assets');
    assert.deepEqual(check({ root: f.root, repo: f.repo, lock: f.lock }), []);
    assert.deepEqual(verify({ root: f.root, lock: f.lock }).problems, []);
    assert.ok(!fs.readdirSync(path.join(f.root, 'app/build/tmp')).length, 'the retired copy is not parked in the build tree');
  } finally { f.cleanup(); }
});

test('the bundle directory is gitignored in this repo, as the imported client pack beside it is', () => {
  // Why: the bundle is 30+ MB of generated pack bytes reproducible from the pin; committed, it would bloat history and
  // drift from the pin unseen. Its parent (src/main/assets) is not ignored, so only this exact line keeps it out.
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n').map(l => l.trim());
  assert.ok(lines.includes('app/src/main/assets/native/'), 'the client pack rule this one mirrors');
  assert.ok(lines.includes(`${OUT_DIR}/`), `${OUT_DIR}/ is ignored`);
});

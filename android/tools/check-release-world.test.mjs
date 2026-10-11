import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  dexProblems, fileProblems, keptNames, manifestProblems, relativeResourceLookups, renamedClasses, RULES, shaderStages, WORLD_SHADERS,
  worldContentProblems,
} from './check-release-world.mjs';

// The N5 release audit's rules (D-NEXT: the GL30 world runs in release). The command itself runs over a built release
// APK and its mapping; these tests hold its rules and the keep rules to the sources they must agree with.
const read = rel => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const DECOR = 'gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorTables';
const LIFE = 'gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeTablesFile';

test('every class that opens a resource relative to its own package keeps its name in R8 builds', () => {
  // Why: Class.getResourceAsStream("life-tables.json") looks in the class's runtime package, and R8 renames packages.
  // The 1953cc8 release APK mapped DecorTables to f5.W and LifeTablesFile to h5.J, so both lookups missed, the realm
  // map's detail lanes (GROUND, LIFE, BASES) never loaded, and every release realm map stayed at the overview with
  // nothing logged. A new relative lookup without a rule would repeat that silently, so each one needs a rule.
  const lookups = relativeResourceLookups();
  assert.ok(lookups.some(l => l.className === DECOR) && lookups.some(l => l.className === LIFE), 'the scanner finds the known lookups');
  const kept = keptNames(read(RULES));
  for (const { className, file } of lookups) assert.ok(kept.has(className), `${RULES} keeps the name of ${className} (${file})`);
});

test('a keep rule that allows obfuscation, or a comment, does not keep a name', () => {
  assert.deepEqual([...keptNames(`-keepnames class ${DECOR}\n-keep class ${LIFE} { *; }`)], [DECOR, LIFE]);
  assert.equal(keptNames(`-keep,allowobfuscation class ${DECOR}\n# -keepnames class ${LIFE}`).size, 0);
});

test('the audit reads the mapping of the broken release as broken and a kept name as sound', () => {
  // Actual lines from the 1953cc8 release mapping, then the same class under a keep rule.
  const broken = `# compiler: R8\n${DECOR} -> f5.W:\n    void <init>() -> <init>\n${LIFE} -> h5.J:\n`;
  assert.deepEqual(renamedClasses(broken, [DECOR, LIFE]), [`${DECOR} -> f5.W`, `${LIFE} -> h5.J`]);
  assert.deepEqual(renamedClasses(`# compiler: R8\n${DECOR} -> ${DECOR}:\n${LIFE} -> ${LIFE}:\n`, [DECOR, LIFE]), []);
  assert.deepEqual(renamedClasses(`# compiler: R8\n${DECOR}Extra -> ${DECOR}Extra:\n`, [DECOR]), [`${DECOR} -> absent`], 'a prefix is not the class');
});

test('a world file the APK lost, cut short or changed fails the audit', () => {
  // Why: the app checks every bundled file against content.json at load; one bad file refuses the new world and sends
  // every player to the legacy globe, and release logs nothing. aapt also drops some names (a directory starting with
  // "_"), which the gradle gate over the source directory cannot see.
  const sha = 'a'.repeat(64);
  const want = [{ path: 'realm/index.json', bytes: 10, sha256: sha }, { path: 'globe-v2/globe-v2.json', bytes: 5, sha256: sha }];
  const good = new Map([['assets/world/realm/index.json', { size: 10, sha256: sha }], ['assets/world/globe-v2/globe-v2.json', { size: 5, sha256: sha }]]);
  assert.deepEqual(fileProblems(want, good, 'assets/world/'), []);
  const bad = new Map(good); bad.delete('assets/world/globe-v2/globe-v2.json'); bad.set('assets/world/realm/index.json', { size: 9, sha256: sha });
  assert.deepEqual(fileProblems(want, bad, 'assets/world/'), ['size assets/world/realm/index.json: 9, listed 10', 'missing assets/world/globe-v2/globe-v2.json']);
  assert.deepEqual(fileProblems(want.slice(0, 1), new Map([['assets/world/realm/index.json', { size: 10, sha256: 'b'.repeat(64) }]]), 'assets/world/'),
    ['sha256 assets/world/realm/index.json differs from its pin']);
  assert.deepEqual(fileProblems([], good, 'assets/world/'), ['assets/world/: nothing listed'], 'an empty index is not a pass');
});

test('the shader check covers every stage WorldShaders.kt pins, at the path the renderer opens', () => {
  // Why: WorldShaders.source throws on a missing or changed stage, and the engine then falls back to the legacy globe.
  const source = read(WORLD_SHADERS);
  const stages = shaderStages(source);
  assert.equal(stages.length, (source.match(/Stage\(/g) ?? []).length - 1, 'every Stage(...) but the class declaration');
  assert.ok(source.includes('RESOURCE_DIR: String = "world/shaders/"') && source.includes('classLoader?.getResourceAsStream(RESOURCE_DIR + stage.path)'),
    'the audit prefix is the classpath directory the renderer reads, through the class loader (never relative)');
  const [first] = stages;
  assert.deepEqual(fileProblems([first], new Map([[`world/shaders/${first.path}`, { size: 1, sha256: first.sha256 }]]), 'world/shaders/'), []);
  assert.deepEqual(fileProblems([first], new Map(), 'world/shaders/'), [`missing world/shaders/${first.path}`]);
});

test('the debug-only world activities and the world log tag are release failures', () => {
  // Why: the probe and smoke activities are exported debug harnesses (they would let any app start the engine), and
  // release must print nothing from the world (WorldLog is off there; a PKWWorldGL string in dex means a reachable line).
  assert.deepEqual(manifestProblems('<activity android:name="gg.pixelkingdomwars.nativeclient.MainActivity"/>'), []);
  assert.deepEqual(manifestProblems('<activity android:name="gg.pixelkingdomwars.nativeclient.scene.world.WorldEngineSmokeActivity"/>'),
    ['release manifest declares WorldEngineSmokeActivity']);
  assert.deepEqual(dexProblems([Buffer.from('dex\n035\0 Landroid/util/Log;')]), []);
  assert.equal(dexProblems([Buffer.from('x'), Buffer.from('..PKWWorldGL..')]).length, 1);
});

test('an APK built without the world bundle, as CI builds it, fails the audit', () => {
  // Why: CI cannot build the bundle, so native.yml assembles with -PpkwWorldContent=absent-ci and its APKs carry no
  // assets/world at all (the shaders still ride in the classpath). Such an APK sends every player to the legacy globe,
  // so this audit must refuse it however sound the rest is: it is the check that stands between a CI build and a release,
  // and it has no opt-out of its own.
  const sha = 'a'.repeat(64);
  const ciApk = new Map([['world/shaders/rm-map.fs.glsl', { size: 3, sha256: sha }]]);
  assert.deepEqual(worldContentProblems(null, ciApk), ['missing assets/world/content.json', 'assets/world/: nothing listed']);
  assert.deepEqual(worldContentProblems(Buffer.from('{"files":[]}'), ciApk), ['assets/world/: nothing listed'], 'an index listing nothing is no world either');
  const bundled = new Map([...ciApk, ['assets/world/realm/index.json', { size: 10, sha256: sha }]]);
  assert.deepEqual(worldContentProblems(Buffer.from(JSON.stringify({ files: [{ path: 'realm/index.json', bytes: 10, sha256: sha }] })), bundled), [],
    'the bundled APK passes');
});

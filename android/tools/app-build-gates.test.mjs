import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEX, LEGACY_DIR, OUT_DIR, indexOf } from './world-debug-content.mjs';
import { LOCK_FILE } from './world-shaders.mjs';

// The two app build gates of the new world's release (D-NEXT), read from app/build.gradle.kts as source text: the gradle
// code itself runs in every assemble (its pass and fail runs are recorded in the N5 handoff), these tests hold its
// numbers and paths to the code they must agree with.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gradle = fs.readFileSync(path.join(ROOT, 'app/build.gradle.kts'), 'utf8');
const updater = fs.readFileSync(path.join(ROOT, 'app/src/main/kotlin/gg/pixelkingdomwars/nativeclient/update/UpdateEligibility.kt'), 'utf8');

/** A Kotlin Long expression of integer literals, `*`, `+`, `-` and already-known names, evaluated exactly. */
function kotlinLong(expr, known = {}) {
  const src = expr.replace(/\b[A-Za-z_]\w*\b/g, n => (n in known ? `(${known[n]})` : n)).replace(/(\d)_(?=\d)/g, '$1').replace(/(\d+)L?\b/g, '$1n');
  assert.match(src, /^[\d\sn*+\-()]+$/, `only integer arithmetic: ${expr}`);
  return Function(`return ${src}`)();
}
const declared = (text, re, known) => { const m = re.exec(text); assert.ok(m, `declaration ${re}`); return kotlinLong(m[1], known); };

test('the APK size limit is the in-app updater\'s own cap less 10 MB', () => {
  // Why: from this release on, updates reach players through the in-app updater (D-NEXT), and every updater-capable client
  // refuses an APK over MAX_UPDATE_BYTES before downloading it. A gate with its own copy of that number could drift and
  // pass an APK no player can install; the 10 MB margin keeps a release offerable after a small late change.
  const cap = declared(updater, /const val MAX_UPDATE_BYTES: Long = ([^\n/]+)/);
  const gateCap = declared(gradle, /val nativeUpdaterCapBytes = ([^\n/]+)/);
  const limit = declared(gradle, /val nativeApkLimitBytes = ([^\n/]+)/, { nativeUpdaterCapBytes: gateCap });
  assert.equal(cap, 314572800n, 'M45 §1: size_bytes <= 314572800');
  assert.equal(gateCap, cap, 'the gradle cap is UpdateEligibility.kt\'s');
  assert.equal(limit, cap - 10000000n);
  assert.ok(/limitBytes\.set\(nativeApkLimitBytes\)/.test(gradle), 'the gate compares against that limit');
});

test('the size gate covers the release and the optimized-debug (candidate) APKs, after packaging', () => {
  // Why: those are the builds that reach the updater or the owner's Seeker; a plain debug APK is unminified and never offered.
  assert.ok(gradle.includes('if (variant.buildType == "release" || nativeOptimizedDebug.get()) {'));
  assert.ok(gradle.includes('apks.set(variant.artifacts.get(SingleArtifact.APK))'), 'reads the packaged APK, so it runs after packaging');
  assert.ok(gradle.includes('tasks.named { it == "assemble$cap" }.configureEach { dependsOn(gate) }'), 'assemble (and the release tool) cannot finish without it');
});

test('no variant merges its assets before the world check, and the check reads what the tool writes', () => {
  // Why: every APK carries the world (D-NEXT); an APK built without it, or with a file cut short, would ship a world
  // every device refuses at load, silently sending every player to the legacy globe. The gate must look at the tool's
  // own directory and index, and at the retired debug-only copy the tool removes.
  const hook = gradle.slice(gradle.indexOf('androidComponents.onVariants { variant ->'));
  assert.ok(hook.indexOf('tasks.named { it == "merge${cap}Assets" }.configureEach { dependsOn(verifyWorldContent) }') >= 0, 'hooked on every variant');
  assert.ok(hook.indexOf('dependsOn(verifyWorldContent)') < hook.indexOf('if (variant.buildType =='), 'not only on the size-gated ones');
  const app = p => p.replace(/^app\//, '');
  assert.ok(gradle.includes(`world.set(layout.projectDirectory.dir("${app(OUT_DIR)}")); legacy.set(layout.projectDirectory.dir("${app(LEGACY_DIR)}"))`));
  assert.ok(gradle.includes(`dir.resolve("${INDEX}")`));
  assert.ok(gradle.includes('file.length() != want'), 'every listed file at its listed size');
  assert.ok(gradle.includes('node tools/world-debug-content.mjs --source'), 'the failure names the command that fixes it');
});

test('the world gate holds the bundle to the tracked pin and hashes every file it lists', () => {
  // Why: the bundle is gitignored, so it outlives a re-pin (the stage-B merge moves world-shaders.lock.json). A copy from
  // the old pin is consistent with itself and passed a gate that checked it only against its own content.json: the
  // release shipped another pin's realm packs beside this pin's shaders and renderer, and logged nothing. D-175: the
  // bundled files are hash-verified at build time from the pinned pack manifest. The gate reads the names the tool
  // writes (content.json `pin`, `manifest.sha256`) and the ones the tool pins from (the lock's `source.commit`,
  // `contentManifest.sha256`).
  const gate = gradle.slice(gradle.indexOf('abstract class VerifyWorldContent'), gradle.indexOf('val verifyWorldContent ='));
  assert.ok(gradle.includes(`lock.set(rootProject.layout.projectDirectory.file("${LOCK_FILE}"))`), 'the lock the tool installs from');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, LOCK_FILE), 'utf8'));
  assert.match(lock.source.commit, /^[0-9a-f]{40}$/); assert.match(lock.contentManifest.sha256, /^[0-9a-f]{64}$/);
  assert.ok(gate.includes('val pin = (pinned?.get("source") as? Map<*, *>)?.get("commit")'), 'the lock\'s pin');
  assert.ok(gate.includes('val manifest = (pinned?.get("contentManifest") as? Map<*, *>)?.get("sha256")'), 'the lock\'s pack manifest');
  assert.ok(gate.includes('content["pin"] != pin'), 'content.json `pin` against it');
  assert.ok(gate.includes('(content["manifest"] as? Map<*, *>)?.get("sha256")') && gate.includes('got != manifest'), 'content.json `manifest.sha256` against it');
  assert.ok(gate.includes('if (pin == null || manifest == null)'), 'a lock that names neither passes nothing');
  assert.ok(gate.includes('sha256(file) != sha'), 'every listed file at its sha256, not only its size');
  const written = JSON.parse(indexOf({ pin: lock.source.commit, manifest: { packVersion: 'p', realms: [] }, sha256: lock.contentManifest.sha256 }, { files: [], total: 0 }));
  assert.equal(written.pin, lock.source.commit); assert.equal(written.manifest.sha256, lock.contentManifest.sha256);
});

test('a release APK packages the world index with the Phase E islands on (owner 2026-09-26)', () => {
  // Why: the owner wants Solana Island, Seeker Island and Divine Isle visible to players in the release build (2026-09-26,
  // overriding D-172's release-off). Every APK carries the one bundle, whose content.json says "phaseEIslands": true, the
  // only flag the native globe's Phase E layer and rail chips read. Nothing may rewrite that flag for release, and a gate
  // on the merged assets (what the APK packages) must fail the release if some other copy of content.json, or a bundle
  // without the islands, would hide them from players.
  const shared = indexOf({ pin: 'a'.repeat(40), manifest: { packVersion: 'p', realms: [] }, sha256: 'b'.repeat(64) }, { files: [], total: 0, islands: ['seeker-island'] }).toString('utf8');
  assert.equal(JSON.parse(shared).phaseEIslands, true, 'the shared bundle turns them on');
  assert.equal(JSON.parse(indexOf({ pin: 'a'.repeat(40), manifest: { packVersion: 'p', realms: [] }, sha256: 'b'.repeat(64) }, { files: [], total: 0, islands: [] }).toString('utf8')).phaseEIslands, false, 'a bundle without island art says so, and the gate then fails a release');
  assert.ok(!/ReleaseWorldIndex|PhaseEOffIndex|addGeneratedSourceDirectory/.test(gradle), 'no release copy of content.json overrides the bundle');
  const hook = gradle.slice(gradle.indexOf('androidComponents.onVariants { variant ->'));
  const release$ = hook.slice(hook.indexOf('if (variant.buildType == "release") {'));
  assert.ok(hook.includes('if (variant.buildType == "release") {'), 'the gate guards the release, the build players install');
  assert.ok(release$.includes('tasks.register<PhaseEOnGate>("check${cap}PhaseEOn")'));
  assert.ok(release$.includes('assets.set(variant.artifacts.get(SingleArtifact.ASSETS))'), 'the gate reads the merged assets the APK packages');
  assert.ok(release$.includes('tasks.named { it == "assemble$cap" }.configureEach { dependsOn(phaseEOn) }'), 'assemble (and the release tool) cannot finish without it');
  assert.ok(gradle.includes('if (flag != true) throw GradleException('), 'anything but a JSON true (false, absent, "true") fails: the tool writes a boolean');
});

test('CI\'s absent-ci opt-out skips the world check loudly, packages no world, and nothing else can skip it', () => {
  // Why: CI cannot build the world bundle (its pin names a web branch on no remote; the pack is a built, gitignored
  // output), so without an opt-out verifyWorldContent failed every CI run and CI proved nothing. The opt-out must be
  // explicit (one property value, honoured only under CI=true), logged (a GitHub warning annotation on every run), and
  // unable to ship: it builds an APK with NO world (a bundle present anyway fails, so no unverified byte is packaged),
  // tools/check-release-world.mjs fails that APK, and tools/release.mjs refuses the property. Every other build, with the
  // property unset (the default "required"), still fails without the bundle.
  const mode = gradle.slice(gradle.indexOf('val worldContentAbsentCi = '), gradle.indexOf('abstract class VerifyWorldContent'));
  assert.ok(mode.includes('providers.gradleProperty("pkwWorldContent").orElse("required")'), 'unset means required');
  assert.ok(mode.includes('"required" -> false') && mode.includes('"absent-ci" -> {'), 'the two values');
  assert.ok(mode.includes('require(providers.environmentVariable("CI").orNull == "true")'), 'absent-ci only where CI=true');
  assert.ok(mode.includes('else -> throw GradleException('), 'any other value is refused, never read as either');
  const gate = gradle.slice(gradle.indexOf('abstract class VerifyWorldContent'), gradle.indexOf('val verifyWorldContent ='));
  const skip = gate.slice(gate.indexOf('if (absentCi.get()) {'), gate.indexOf('return\n', gate.indexOf('if (absentCi.get()) {')));
  assert.ok(skip.length > 0 && gate.indexOf('if (absentCi.get()) {') < gate.indexOf('is missing: every APK carries the world content'), 'the skip is the only way past the checks');
  assert.ok(skip.includes('listOf(dir, legacy.get().asFile).filter { it.exists() }') && skip.includes('if (present.isNotEmpty()) throw GradleException('), 'a present bundle fails the opt-out');
  assert.ok(/logger\.warn\("::warning title=[^"]*::World content check SKIPPED/.test(skip) && skip.includes('must never ship'), 'loud: a warning annotation');
  assert.equal((gate.match(/\breturn\b/g) ?? []).length, 2, 'one early return (the opt-out) and sha256\'s');
  assert.ok(gradle.includes('absentCi.set(worldContentAbsentCi)'), 'the task reads the checked mode');
  assert.ok(gate.includes('problems += "$index is missing: every APK carries the world content"'), 'required mode still fails without the bundle');
  // release: the Phase E gate stays on the assemble path in both modes; without a bundle there is no index to check
  assert.ok(gradle.includes('if (!index.isFile && absentCi.get()) {') && gradle.includes('if (!index.isFile) throw GradleException'), 'a missing index is a failure unless absent-ci');
  // CI sets it on its one gradle command; nothing else in the repo does
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/native.yml'), 'utf8');
  const gradlew = workflow.split('\n').filter(l => l.includes('./gradlew'));
  assert.ok(gradlew.length > 0 && gradlew.every(l => l.includes('-PpkwWorldContent=absent-ci')), 'every CI gradle run opts out explicitly');
  assert.ok(!/check-release-world/.test(workflow.split('\n').filter(l => !l.trim().startsWith('#')).join('\n')), 'the release audit cannot pass in CI, so CI does not run it');
  assert.ok(!/pkwWorldContent/.test(fs.readFileSync(path.join(ROOT, 'gradle.properties'), 'utf8')), 'no checked-in default opts out');
});

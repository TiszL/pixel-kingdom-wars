import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The final merged manifest/optimized DEX audit is still required. These guards
// catch source drift before a build, without acquiring the shared Gradle slot.
test('remote origin is an exact debug-only choice and cannot borrow a local CA', () => {
  const gradle = readFileSync(new URL('../app/build.gradle.kts', import.meta.url), 'utf8');
  assert.match(gradle, /require\(nativeCandidateOrigin == "https:\/\/qa\.pixelkingdomwars\.com"\)/);
  assert.match(gradle, /nativeLocalOrigin == null && !providers\.gradleProperty\("nativeLocalCa"\)\.isPresent/);
  assert.match(gradle, /require\(nativeOptimizedDebug\.get\(\)\)/);
  assert.match(gradle, /applicationId = "gg\.pixelkingdomwars\.twa"/);
  const debug = gradle.slice(gradle.indexOf('debug {'), gradle.indexOf('release {'));
  assert.match(debug, /applicationIdSuffix = "\.debug"/);
  assert.match(debug, /isDebuggable = !nativeOptimizedDebug\.get\(\)/);
  assert.match(debug, /API_ORIGIN.*nativeCandidateOrigin/);
  assert.match(debug, /NATIVE_FCM_CONFIGURED.*, "false"/);
  assert.match(debug, /nativeAppLabel.*Pixel Kingdom Wars Test/);
  assert.match(gradle, /if \(nativeCandidateOrigin != null\) sourceSets\["debug"\]\.manifest\.srcFile\("src\/candidate\/AndroidManifest.xml"\)/);
  const release = gradle.slice(gradle.indexOf('release {'), gradle.indexOf('buildFeatures'));
  assert.doesNotMatch(release, /API_ORIGIN|nativeCandidateOrigin|signingConfig|applicationId/);
  assert.match(gradle, /API_ORIGIN.*, "\\"https:\/\/play\.pixelkingdomwars\.com\\""/);
});
test('candidate keeps system TLS; only MWA loopback is cleartext, no custom CA enters main resources', () => {
  const xml = readFileSync(new URL('../app/src/main/res/xml/network_security_config.xml', import.meta.url), 'utf8');
  assert.match(xml, /base-config cleartextTrafficPermitted="false"/);
  assert.doesNotMatch(xml, /trust-anchors|src="user"|qa\.pixelkingdomwars/);
  const manifest = readFileSync(new URL('../app/src/main/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(manifest, /android:host="\$\{nativeLinkHost\}"/);
  assert.match(manifest, /android:allowBackup="false"/);
  const candidateManifest = readFileSync(new URL('../app/src/candidate/AndroidManifest.xml', import.meta.url), 'utf8');
  assert.match(candidateManifest, /PrivyRedirectActivity" tools:node="remove"/);
});

test('instrumentation ABI retention belongs only to the exact optimized candidate debug branch', () => {
  const gradle = readFileSync(new URL('../app/build.gradle.kts', import.meta.url), 'utf8');
  const debug = gradle.slice(gradle.indexOf('debug {'), gradle.indexOf('release {'));
  const candidate = debug.slice(debug.indexOf('if (nativeCandidateOrigin != null) {'));
  assert.match(candidate, /proguardFiles\("candidate-test-api\.pro"\)/);
  assert.equal(gradle.match(/proguardFiles\("candidate-test-api\.pro"\)/g)?.length, 1);
  assert.doesNotMatch(debug.slice(0, debug.indexOf('if (nativeCandidateOrigin != null) {')), /candidate-test-api/);
  assert.doesNotMatch(gradle.slice(gradle.indexOf('release {')), /candidate-test-api/);
  assert.match(gradle, /require\(nativeOptimizedDebug\.get\(\)\)/);
  assert.match(debug, /isMinifyEnabled = nativeOptimizedDebug\.get\(\)/);
  assert.match(debug, /isDebuggable = !nativeOptimizedDebug\.get\(\)/);
  const mainRules = readFileSync(new URL('../app/proguard-rules.pro', import.meta.url), 'utf8');
  assert.doesNotMatch(mainRules, /candidate-test-api|SecretStore|CandidateSessionHarness/);
});

test('candidate rules retain named bootstrap API shapes without disabling package optimization', () => {
  const rules = readFileSync(new URL('../app/candidate-test-api.pro', import.meta.url), 'utf8');
  const active = rules.split('\n').filter(line => !line.trim().startsWith('#')).join('\n');
  const declarations = [...active.matchAll(/^(-\S+)\s+(?:class|interface)\s+(\S+)/gm)];
  assert.ok(declarations.length > 0);
  for (const [_, flags, name] of declarations) {
    assert.ok(!/[*?!]/.test(name), `Only named classes belong to this ABI: ${name}`);
    assert.match(flags, /^-keep,allowobfuscation(?:,includedescriptorclasses)?$/,
      'ABI entry points may be renamed but not removed or have their signatures optimized');
    assert.doesNotMatch(name, /Harness|AppGraph|MainActivity|BuildConfig/,
      'Bootstrap code and application-wide entry points do not belong in this keep surface');
  }
  assert.equal(declarations.length, (active.match(/^-\S+/gm) ?? []).length,
    'No global optimization, shrinking or warning suppression directives');
  assert.match(active, /interface gg\.pixelkingdomwars\.nativeclient\.network\.SecretStore\s*\{[\s\S]*?read\(\);[\s\S]*?write\(java\.lang\.String\);[\s\S]*?clear\(\);/);
  assert.match(active, /<init>\(okhttp3\.HttpUrl,gg\.pixelkingdomwars\.nativeclient\.network\.SecretStore,kotlin\.jvm\.functions\.Function0,int,kotlin\.jvm\.internal\.DefaultConstructorMarker\)/,
    'The externally implemented store and default constructor must not narrow to EncryptedStore');
  for (const name of ['okhttp3.Cookie$Builder', 'okhttp3.Cookie$Companion', 'okhttp3.HttpUrl$Companion',
    'kotlin.collections.MapsKt', 'kotlin.collections.MapsKt__MapsKt',
    'kotlin.collections.CollectionsKt', 'kotlin.collections.CollectionsKt__CollectionsJVMKt',
    'kotlinx.coroutines.BuildersKt', 'kotlin.coroutines.jvm.internal.BaseContinuationImpl',
    'kotlinx.serialization.json.Json', 'kotlinx.serialization.json.Json$Default']) {
    assert.ok(declarations.some(([, , declared]) => declared === name), `Missing externally called class: ${name}`);
  }
});

test('candidate instrumentation failure handling does not invoke the removed Result companion', () => {
  const runner = readFileSync(new URL('../app/src/androidTest/kotlin/gg/pixelkingdomwars/nativeclient/LocalUiHarness.kt', import.meta.url), 'utf8');
  // Chat acquired its own intervening debug-only mode in 0.5.5. Check just the optimized candidate's branch;
  // unrelated debug harnesses may use Result, while this entry point must still link against the shrunk APK.
  const start = runner.indexOf('if (mode == "candidate-session")');
  const end = runner.indexOf('\n        if (mode ==', start + 1);
  assert.ok(start >= 0 && end > start, 'The candidate-session branch and its following mode must exist');
  const branch = runner.slice(start, end);
  assert.doesNotMatch(branch, /runCatching|\.isSuccess|\.fold\(/);
  assert.match(branch, /CandidateSessionHarness\.bootstrap\(this\);succeeded=true/);
  assert.match(branch, /catch \(_: LinkageError\)/);
  assert.match(branch, /catch \(_: Throwable\)/);
  assert.match(branch, /if\(succeeded\) Activity\.RESULT_OK else Activity\.RESULT_CANCELED/);
  assert.doesNotMatch(branch, /printStackTrace|\.message|exceptionOrNull/,
    'Cross-APK failures must not print credential-bearing exception details');
});

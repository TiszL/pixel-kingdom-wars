import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { APPLICATION_ID, STORE_CERT, REQUIRED_GATES, parseBadging, parseCertificate, assertNextCode, assertReadiness, assertOwnerTestReadiness, canonicalStoreFilename, assertCurrentCandidate, RELEASE_WORLD_CONTENT, assertReleaseWorldContent } from './release-policy.mjs';
test('native update advances the same listing across both release pipelines', () => {
  const previous = parseBadging(`package: name='${APPLICATION_ID}' versionCode='12' versionName='0.3.3'`);
  assertNextCode([previous], 13);
  assert.throws(() => assertNextCode([previous, { versionCode: 13 }], 13));
  assert.throws(() => assertNextCode([], 13));
});
test('wrong or multiple signing identities cannot produce an update', () => {
  assert.equal(parseCertificate(`Signer #1 certificate SHA-256 digest: ${STORE_CERT}`), STORE_CERT);
  assert.throws(() => parseCertificate('Signer #1 certificate SHA-256 digest: ' + '0'.repeat(64)));
  assert.throws(() => parseCertificate(`Signer #1 certificate SHA-256 digest: ${STORE_CERT}\nSigner #2 certificate SHA-256 digest: ${STORE_CERT}`));
});
test('an unfinished foundation or evidence for another commit cannot be signed', () => {
  assert.throws(() => assertReadiness({ nativeCommit: 'a', gates: {} }, 'b'), /exact/);
  assert.throws(() => assertReadiness({ nativeCommit: 'a', gates: {} }, 'a'), /playerParity/);
});
test('native inventory remains a valid prior witness for the unchanged TWA release command', () => {
  assert.equal(canonicalStoreFilename('0.4.0'), 'pixel-kingdom-wars-v0.4.0-dappstore.apk');
  assert.throws(() => canonicalStoreFilename('0.4.0-native'));
  assert.throws(() => canonicalStoreFilename('00.4.0'));
});
test('a native candidate cannot be promoted after either release pipeline advances', () => {
  assertCurrentCandidate([{ versionCode: 12 }, { versionCode: 13 }], 13);
  assert.throws(() => assertCurrentCandidate([{ versionCode: 13 }, { versionCode: 14 }], 13), /stale/);
});
test('a replacement cannot be signed without proving installed clients work during store review', () => {
  const report = { nativeCommit: 'reviewed', gates: Object.fromEntries(REQUIRED_GATES.map((key) => [key,
    { status: 'passed', evidence: `${key}.json`, sha256: 'a'.repeat(64) }])) };
  report.gates.storeReviewCompatibility.status = 'pending';
  assert.throws(() => assertReadiness(report,'reviewed',true), /storeReviewCompatibility/);
  report.gates.storeReviewCompatibility.status = 'passed';
  assertReadiness(report,'reviewed',true);
});

function ownerTestReport() {
  return { nativeCommit: 'reviewed', purpose: 'private-owner-test', gates: {
    ...Object.fromEntries(['nativeBuild', 'backendDeployment', 'battleEquivalence', 'backendCapacity', 'securityReview', 'storeReviewCompatibility']
      .map((key) => [key, { status: 'passed', evidence: `${key}.json`, sha256: 'a'.repeat(64) }])),
    ...Object.fromEntries(['playerParity', 'seekerWallet', 'socialAccountContinuity', 'seekerPerformance', 'signedUpgrade']
      .map((key) => [key, { status: 'pending', reason: `Owner will verify ${key} using this private APK` }])),
  } };
}
test('private owner testing can precede physical acceptance without claiming it passed', () => {
  const report = ownerTestReport();
  const before = structuredClone(report);
  assert.deepEqual(assertOwnerTestReadiness(report, 'reviewed'),
    ['playerParity', 'seekerWallet', 'socialAccountContinuity', 'seekerPerformance', 'signedUpgrade']
      .map((gate) => ({ gate, reason: report.gates[gate].reason })));
  assert.deepEqual(report, before);
  // The owner-test exception must never apply to an ordinary candidate or .ready receipt.
  assert.throws(() => assertReadiness(report, 'reviewed', true), /playerParity/);
  assert.throws(() => assertReadiness(report, 'reviewed'), /playerParity/);
});
test('owner testing needs explicit purpose and evidence for the exact commit', () => {
  const report = ownerTestReport();
  assert.throws(() => assertOwnerTestReadiness(report, 'different'), /exact/);
  delete report.purpose;
  assert.throws(() => assertOwnerTestReadiness(report, 'reviewed'), /private-owner-test/);
  report.purpose = 'release';
  assert.throws(() => assertOwnerTestReadiness(report, 'reviewed'), /private-owner-test/);
});
for (const key of ['nativeBuild', 'backendDeployment', 'battleEquivalence', 'backendCapacity', 'securityReview', 'storeReviewCompatibility']) {
  test(`private owner testing cannot defer or omit technical proof: ${key}`, () => {
    for (const invalid of [undefined, { status: 'pending', reason: 'Owner will test later' },
      { status: 'failed', evidence: `${key}.json`, sha256: 'a'.repeat(64) },
      { status: 'passed', evidence: `${key}.json`, sha256: 'invalid' },
      { status: 'passed', sha256: 'a'.repeat(64) }]) {
      const report = ownerTestReport();
      report.gates[key] = invalid;
      assert.throws(() => assertOwnerTestReadiness(report, 'reviewed'), new RegExp(key));
    }
  });
}
for (const key of ['playerParity', 'seekerWallet', 'socialAccountContinuity', 'seekerPerformance', 'signedUpgrade']) {
  test(`deferred owner acceptance must be explicit and must not hide failure: ${key}`, () => {
    for (const invalid of [undefined, { status: 'pending' }, { status: 'pending', reason: ' ' },
      { status: 'failed', reason: 'Known failing acceptance' }, { status: 'passed' }]) {
      const report = ownerTestReport();
      report.gates[key] = invalid;
      assert.throws(() => assertOwnerTestReadiness(report, 'reviewed'), new RegExp(key));
    }
  });
}
test('ordinary candidates defer only signed upgrade and final readiness still requires it', () => {
  const report = ownerTestReport();
  for (const key of ['playerParity', 'seekerWallet', 'socialAccountContinuity', 'seekerPerformance']) {
    report.gates[key] = { status: 'passed', evidence: `${key}.json`, sha256: 'a'.repeat(64) };
  }
  assert.deepEqual(assertOwnerTestReadiness(report, 'reviewed'), [
    { gate: 'signedUpgrade', reason: report.gates.signedUpgrade.reason },
  ]);
  assertReadiness(report, 'reviewed', true);
  assert.throws(() => assertReadiness(report, 'reviewed'), /signedUpgrade/);
  report.gates.signedUpgrade = { status: 'passed', evidence: 'signedUpgrade.json', sha256: 'a'.repeat(64) };
  assert.deepEqual(assertOwnerTestReadiness(report, 'reviewed'), []);
  assertReadiness(report, 'reviewed');
});
test('a signed release builds with the verified world bundle and refuses CI\'s absent-ci opt-out', () => {
  // Why: CI assembles with -PpkwWorldContent=absent-ci because it cannot build the world bundle; that APK has no world and
  // sends every player to the legacy globe. The signed release must never be that build: release.mjs puts the property on
  // the gradle command line as "required" (it outranks gradle.properties and ORG_GRADLE_PROJECT_ variables), and refuses
  // up front an environment or gradle.properties that sets it at all, so a leftover opt-out fails loudly before any lock.
  assert.equal(RELEASE_WORLD_CONTENT, '-PpkwWorldContent=required');
  assertReleaseWorldContent({ PATH: '/usr/bin', CI: 'true', GRADLE_OPTS: '-Xmx2g' }, [{ file: 'gradle.properties', text: 'org.gradle.caching=true\n' }]);
  for (const env of [{ ORG_GRADLE_PROJECT_pkwWorldContent: 'absent-ci' }, { GRADLE_OPTS: '-Dorg.gradle.project.pkwWorldContent=absent-ci' },
    { JAVA_TOOL_OPTIONS: '-Dorg.gradle.project.pkwWorldContent=absent-ci' }, { ORG_GRADLE_PROJECT_pkwWorldContent: 'required' }]) {
    assert.throws(() => assertReleaseWorldContent(env), new RegExp(`Release blocked[\\s\\S]*environment ${Object.keys(env)[0]}`), JSON.stringify(env));
  }
  assert.throws(() => assertReleaseWorldContent({}, [{ file: '/home/u/.gradle/gradle.properties', text: '# user\npkwWorldContent = absent-ci\n' }]),
    /\/home\/u\/\.gradle\/gradle\.properties/);
  const release = fs.readFileSync(new URL('./release.mjs', import.meta.url), 'utf8');
  const build = release.indexOf("':app:assembleRelease'");
  assert.ok(release.slice(build, release.indexOf('\n', build)).includes('RELEASE_WORLD_CONTENT'), 'the release assemble passes the property itself');
  const refuse = release.indexOf('await refuseWorldContentOptOut();');
  assert.ok(refuse > 0 && refuse < release.indexOf('await acquireReleaseLock(lock, owner)') && refuse < build, 'the refusal runs before the lock and the build');
  assert.ok(/assertReleaseWorldContent\(process\.env, texts\)/.test(release), 'over the environment gradle inherits');
  const gradle = fs.readFileSync(new URL('../app/build.gradle.kts', import.meta.url), 'utf8');
  assert.ok(gradle.includes('providers.gradleProperty("pkwWorldContent").orElse("required")') && gradle.includes('"required" -> false'),
    'the gradle script reads "required" as the verified bundle');
});

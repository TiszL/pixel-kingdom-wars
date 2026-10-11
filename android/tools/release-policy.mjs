export const APPLICATION_ID = 'gg.pixelkingdomwars.twa';
export const STORE_CERT = 'fca0a857470ff9b9eea34348fa5d419e793408683b6cdfbf1555f5792be12329';
export const REQUIRED_GATES = ['playerParity', 'seekerWallet', 'socialAccountContinuity', 'battleEquivalence',
  'seekerPerformance', 'signedUpgrade', 'backendCapacity', 'securityReview', 'storeReviewCompatibility'];
export const OWNER_TEST_PENDING_GATES = ['playerParity', 'seekerWallet', 'socialAccountContinuity', 'seekerPerformance', 'signedUpgrade'];
export const OWNER_TEST_REQUIRED_GATES = ['nativeBuild', 'backendDeployment',
  ...REQUIRED_GATES.filter((key) => !OWNER_TEST_PENDING_GATES.includes(key))];
export function canonicalStoreFilename(version) {
  // The unchanged TWA tool requires the highest APK to use this exact vocabulary.
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Store version must be numeric major.minor.patch');
  return `pixel-kingdom-wars-v${version}-dappstore.apk`;
}
export function parseBadging(text) {
  const match = /^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m.exec(text);
  if (!match) throw new Error('Cannot read Android package identity');
  const versionCode = Number(match[2]);
  if (!Number.isSafeInteger(versionCode) || versionCode < 1) throw new Error('Invalid APK version code');
  return { applicationId: match[1], versionCode, versionName: match[3] };
}
export function assertNextCode(known, next) {
  if (!known.length) throw new Error('Original signed APK is required to establish release continuity');
  const maximum = Math.max(...known.map((a) => a.versionCode));
  if (!Number.isSafeInteger(next) || next !== maximum + 1) throw new Error(`Next versionCode must be ${maximum + 1}; no code is reserved`);
}
export function assertCurrentCandidate(known, code) {
  if (!known.length || code !== Math.max(...known.map((a) => a.versionCode))) throw new Error('Candidate is stale; a newer APK or legacy configuration already exists');
}
export function parseCertificate(text) {
  const matches = [...text.matchAll(/^Signer #\d+ certificate SHA-256 digest: ([a-f0-9]+)$/gmi)];
  if (matches.length !== 1 || matches[0][1].toLowerCase() !== STORE_CERT) throw new Error('APK signer does not match the preserved store key');
  return matches[0][1].toLowerCase();
}
export function assertReadiness(report, commit, candidate = false) {
  if (report.nativeCommit !== commit) throw new Error('Release acceptance does not match this exact native commit');
  for (const key of REQUIRED_GATES) {
    // A signed candidate must exist before its actual in-place upgrade can be tested.
    if (candidate && key === 'signedUpgrade') continue;
    const gate = report.gates?.[key];
    if (gate?.status !== 'passed' || !gate.evidence || !/^[a-f0-9]{64}$/.test(gate.sha256 ?? '')) {
      throw new Error(`Release blocked: ${key} has no verified acceptance evidence`);
    }
  }
}

/** A private, original-package APK lets the owner perform these physical gates;
 * pending acceptance is recorded honestly and never grants release readiness. */
export function assertOwnerTestReadiness(report, commit) {
  if (report.nativeCommit !== commit) throw new Error('Release acceptance does not match this exact native commit');
  if (report.purpose !== 'private-owner-test') throw new Error('Owner-test evidence must declare purpose private-owner-test');
  const pending = [];
  for (const key of [...OWNER_TEST_REQUIRED_GATES, ...OWNER_TEST_PENDING_GATES]) {
    const gate = report.gates?.[key];
    if (OWNER_TEST_PENDING_GATES.includes(key) && gate?.status === 'pending' && typeof gate.reason === 'string' && gate.reason.trim()) {
      pending.push({ gate: key, reason: gate.reason });
    } else if (gate?.status !== 'passed' || !gate.evidence || !/^[a-f0-9]{64}$/.test(gate.sha256 ?? '')) {
      throw new Error(`Owner-test candidate blocked: ${key} needs verified evidence or an allowed explicit pending reason`);
    }
  }
  return pending;
}

/** How a signed release builds its world content (app/build.gradle.kts `pkwWorldContent`): always the verified bundle.
 *  On the gradle command line it outranks every gradle.properties and ORG_GRADLE_PROJECT_ variable, so no ambient
 *  setting can turn a release into CI's `absent-ci` build, which packages no world (every player on the legacy globe). */
export const RELEASE_WORLD_CONTENT = '-PpkwWorldContent=required';
/** Refuses a release whose environment or gradle.properties ([{ file, text }]) sets the world-content property at all:
 *  the release tool alone decides it, and a leftover CI opt-out must fail loudly here, not be silently overridden. */
export function assertReleaseWorldContent(env, gradleProperties = []) {
  const found = [
    ...Object.entries(env).filter(([key, value]) => /pkwWorldContent/i.test(key) || /pkwWorldContent/i.test(String(value)))
      .map(([key]) => `environment ${key}`),
    ...gradleProperties.filter(({ text }) => /^\s*pkwWorldContent\s*[=:]/m.test(text)).map(({ file }) => file),
  ];
  if (found.length) {
    throw new Error(`Release blocked: a signed release builds with the verified world bundle (${RELEASE_WORLD_CONTENT}); `
      + `remove the world-content setting from ${found.join(', ')}`);
  }
}

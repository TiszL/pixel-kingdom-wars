#!/usr/bin/env node
/** Owner-approved private Seeker acceptance shell. This cannot build or sign the
 * store identity. All keys, DAL and artifacts stay under ignored mobile/build/qa. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const origin = new URL(process.argv[2] ?? 'about:blank');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
  || origin.pathname !== '/' || origin.search || origin.hash
  || !/\.(trycloudflare\.com|ts\.net)$/.test(origin.hostname)) {
  throw new Error('QA requires a bare HTTPS test origin under trycloudflare.com or ts.net');
}
const out = resolve(root, 'mobile/build/qa');
const packageId = 'gg.pixelkingdomwars.privateqa';
const config = JSON.parse(readFileSync(resolve(root, 'mobile/twa.config.json'), 'utf8'));
const productionHash = createHash('sha256').update(JSON.stringify(config)).digest('hex');
if (config.applicationId === packageId || config.domain === origin.hostname) throw new Error('QA must differ from production');
mkdirSync(out, { recursive: true, mode: 0o700 });
const passwordFile = resolve(out, 'signing-password');
const keyStore = resolve(out, 'private-qa.keystore');
if (!existsSync(passwordFile)) writeFileSync(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
const password = readFileSync(passwordFile, 'utf8').trim();
const javaHome = '/opt/homebrew/opt/openjdk/libexec/openjdk.jdk/Contents/Home';
const env = { ...process.env, JAVA_HOME: javaHome, PATH: `${javaHome}/bin:${process.env.PATH}` };
// Release credentials must never reach the QA builder or its dependency tools.
for (const key of Object.keys(env)) if (/KEYSTORE|KEY_PASSWORD|STORE_PASSWORD|PKW_.*PASSWORD/.test(key)) delete env[key];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: out, env, encoding: 'utf8', stdio: 'pipe', ...options });
  if (result.status !== 0) throw new Error(`QA tool failed: ${command} (exit ${result.status ?? 'unavailable'})`);
  return result.stdout;
}
const keytool = resolve(javaHome, 'bin/keytool');
const keyEnv = { ...env, PKW_QA_SIGNING_PASSWORD: password };
if (!existsSync(keyStore)) run(keytool, ['-genkeypair', '-noprompt', '-alias', 'pkw-qa', '-keystore', keyStore,
  '-keyalg', 'RSA', '-keysize', '2048', '-validity', '365', '-dname', 'CN=PKW Private QA',
  '-storepass:env', 'PKW_QA_SIGNING_PASSWORD', '-keypass:env', 'PKW_QA_SIGNING_PASSWORD'], { env: keyEnv });
const certificate = run(keytool, ['-exportcert', '-alias', 'pkw-qa', '-keystore', keyStore,
  '-storepass:env', 'PKW_QA_SIGNING_PASSWORD'], { env: keyEnv, encoding: null });
const fingerprint = createHash('sha256').update(certificate).digest('hex').toUpperCase().match(/../g).join(':');
const dal = [{ relation: ['delegate_permission/common.handle_all_urls'], target: {
  namespace: 'android_app', package_name: packageId, sha256_cert_fingerprints: [fingerprint],
} }];
mkdirSync(resolve(out, 'public/.well-known'), { recursive: true });
writeFileSync(resolve(out, 'public/.well-known/assetlinks.json'), JSON.stringify(dal, null, 2) + '\n');
const manifest = {
  packageId, host: origin.hostname, name: 'Pixel Kingdom Wars — Private QA', launcherName: 'PKW QA',
  display: config.display, orientation: config.orientation, themeColor: config.themeColor,
  themeColorDark: config.themeColor, navigationColor: config.navigationColor,
  navigationColorDark: config.navigationColor, navigationDividerColor: config.navigationColor,
  navigationDividerColorDark: config.navigationColor, backgroundColor: config.backgroundColor,
  enableNotifications: config.enableNotifications, startUrl: '/?client=solana-mobile',
  iconUrl: 'http://127.0.0.1:18888/icons/icon-512.png',
  maskableIconUrl: 'http://127.0.0.1:18888/icons/icon-512.png', splashScreenFadeOutDuration: 300,
  signingKey: { path: keyStore, alias: 'pkw-qa' }, appVersion: `${config.appVersionName}-qa`, appVersionCode: 1,
  shortcuts: [], generatorApp: 'pkw-private-qa', fallbackType: 'customtabs', features: {},
  enableSiteSettingsShortcut: true, isChromeOSOnly: false, isMetaQuest: false, minSdkVersion: 23,
  fingerprints: [], additionalTrustedOrigins: [], retainedBundles: [], alphaDependencies: { enabled: false },
};
writeFileSync(resolve(out, 'twa-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(resolve(out, 'qa-receipt.json'), JSON.stringify({ origin: origin.origin, packageId, fingerprint,
  productionConfigHash: productionHash, gitSha: run('git', ['rev-parse', 'HEAD']).trim(), preparedAt: new Date().toISOString() }, null, 2) + '\n');
if (!process.argv.includes('--prepare')) {
  const cli = resolve(root, 'scripts/node_modules/.bin/bubblewrap');
  const cliPackage = JSON.parse(readFileSync(resolve(root, 'scripts/node_modules/@bubblewrap/cli/package.json'), 'utf8'));
  if (cliPackage.version !== '1.25.0') throw new Error('QA requires repository-pinned Bubblewrap 1.25.0');
  run(cli, ['update', '--skipVersionUpgrade']);
  run(cli, ['build', '--directory', out, '--skipSigning']);
  const apksigner = resolve(process.env.HOME, '.bubblewrap/android_sdk/build-tools/35.0.0/apksigner');
  const apk = resolve(out, 'pkw-private-qa.apk');
  run(apksigner, ['sign', '--ks', keyStore, '--ks-key-alias', 'pkw-qa', '--ks-pass', 'env:PKW_QA_SIGNING_PASSWORD',
    '--key-pass', 'env:PKW_QA_SIGNING_PASSWORD', '--out', apk, resolve(out, 'app-release-unsigned-aligned.apk')], { env: keyEnv });
  run(apksigner, ['verify', '--verbose', apk]);
  console.log(apk);
}
const afterConfig = JSON.parse(readFileSync(resolve(root, 'mobile/twa.config.json'), 'utf8'));
if (createHash('sha256').update(JSON.stringify(afterConfig)).digest('hex') !== productionHash) throw new Error('Production config changed during QA build');
console.log(JSON.stringify({ origin: origin.origin, packageId, fingerprint, preparedOnly: process.argv.includes('--prepare') }));

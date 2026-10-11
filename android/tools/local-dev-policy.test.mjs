import test from 'node:test';
import assert from 'node:assert/strict';
import { localOrigin, contentRequest, checkedDatabase, runtimeEnvironment, nightDevnetEnvironment } from './local-dev-policy.mjs';

test('local native configuration refuses public origins and production databases', () => {
  for (const host of ['127.0.0.1', 'localhost', '10.0.0.2', '172.16.0.1', '192.168.1.8']) {
    assert.equal(localOrigin(`https://${host}:18443`).hostname, host);
  }
  for (const url of ['https://play.pixelkingdomwars.com:18443', 'http://127.0.0.1:18443', 'https://192.168.0.1:18443/path',
    'https://127.0.0.1:18443/', 'https://user@127.0.0.1:18443', 'https://8.8.8.8:18443', 'https://172.32.0.1:18443',
    'https://10.bad.1.2.3:18443']) {
    assert.throws(() => localOrigin(url));
  }
  const local = 'postgresql://pkw_native:local@127.0.0.1:55473/pkw_native_local';
  assert.equal(checkedDatabase(local).pathname, '/pkw_native_local');
  for (const url of [local.replace('55473', '5433'), local.replace('pkw_native_local', 'shardkeep'),
    local.replace('127.0.0.1', 'example.com'), `${local}?options=unsafe`]) assert.throws(() => checkedDatabase(url));
});

test('only manifest-listed content is reachable through the local HTTPS server', () => {
  const allowed = new Set(['manifest.json', 'atlas/a.png']);
  assert.equal(contentRequest('/native-content/atlas/a.png', allowed), 'atlas/a.png');
  for (const path of ['/native-content/../secret', '/native-content/%2e%2e/secret', '/native-content/atlas%2fa.png',
    '/native-content/manifest.json?secret', '/native-content/unlisted.pem', '/native-content/%ZZ', '/native-content/atlas\\a.png']) {
    assert.equal(contentRequest(path, allowed), null);
  }
});

test('child API environment is explicit and never inherits production credentials or enables money workers', () => {
  const env = runtimeEnvironment({ origin: 'https://127.0.0.1:18443', databaseUrl: 'postgresql://pkw_native:test@127.0.0.1:55473/pkw_native_local',
    jwtSecret: 'a'.repeat(64), twofaKey: Buffer.alloc(32, 7).toString('base64') });
  assert.equal(env.NODE_ENV, 'production'); // Real Secure cookies over HTTPS.
  assert.equal(env.ENABLE_WORKERS, 'false');
  assert.equal(env.DEV_LOGIN, 'false');
  assert.equal(env.WITHDRAWALS_ENABLED, 'false');
  assert.equal(env.SOLANA_RPC_URL, 'http://127.0.0.1:9');
  assert.equal(env.NATIVE_CONTENT_MANIFEST_URL, `${env.WEB_ORIGIN}/native-content/manifest.json`);
  assert.equal(env.NATIVE_PRESENTATION_ENABLED, 'true');
  // M45: the local lane must advertise channel rows so the emulator acceptance can run offline.
  assert.equal(env.NATIVE_UPDATE_CHANNEL_ENABLED, 'true');
  // Production runs the fantasy world (land gate, parcels, SOL checkout); the harness must too,
  // or the M-A1 journey cannot be exercised locally. Multi-base is its config prerequisite.
  assert.equal(env.FANTASY_WORLD_ENABLED, 'true');
  assert.equal(env.MULTI_BASE_ENABLED, 'true');
  assert.equal(env.HERO_RECRUITMENT_ENABLED, 'true'); // Isolated parity journey, no public wallet transport.
  assert.equal(env.WALL_BATCH_V1_ENABLED, 'true');
  // Exercise the reviewed receipt/claim routes locally. Enabling the contracts
  // must not supply an external RPC, signer or background payment worker.
  assert.equal(env.BASE_PURCHASE_V1_ENABLED, 'true');
  assert.equal(env.SHIELD_PURCHASE_V1_ENABLED, 'true');
  assert.equal(env.ENERGY_PURCHASE_V1_ENABLED, 'true');
  assert.equal(env.BASE_CLAIM_V1_ENABLED, 'true');
  assert.equal(env.SOLANA_MAINNET_RPC_URL, undefined);
  assert.equal(env.PRIVY_APP_ID, undefined);
  assert.equal(env.HOT_WALLET_KEYPAIR, undefined);
});

// 2026-10-06 devnet TEST lane. The opt-in environment may carry only
// public pins of the test deployment; a key path or token in that file must never reach the API process,
// and the ordinary lane must keep its dead RPC so it can never read or send to a public cluster.
const nightLocal = { origin: 'https://127.0.0.1:18443', databaseUrl: 'postgresql://pkw_native:owner@127.0.0.1:55473/pkw_native_local',
  jwtSecret: 'a'.repeat(64), twofaKey: Buffer.alloc(32, 7).toString('base64') };
const nightRequestUrl = `postgresql://pkw_native_night_api:${'b'.repeat(64)}@127.0.0.1:55473/pkw_native_local`;
const nightProgram = 'Night1111111111111111111111111111111111111';
const nightPins = (rpc = 'https://api.devnet.solana.com') => [
  '# written by pins.ts from deployments.json', '', `SOLANA_CLUSTER=devnet`, `SOLANA_RPC_URL=${rpc}`,
  `SEEKER_REALM_SALE_PROGRAM_ID=${nightProgram}`, 'SEEKER_REALM_SALE_DEPLOYMENT_SLOT=123456',
  `SEEKER_REALM_SALE_PROGRAM_DATA_SHA256=${'c'.repeat(64)}`, 'SEEKER_REALM_SALE_UPGRADE_AUTHORITY=NightUa111111111111111111111111111111111111',
  'SEEKER_REALM_SALE_AUCTION_MINT=NightSkr11111111111111111111111111111111111', 'SEEKER_REALM_SALE_PRIZE_OWNER=NightTreasury1111111111111111111111111111111',
  'SEEKER_REALM_SALE_DEVELOPER=NightTreasury1111111111111111111111111111111', 'SEEKER_REALM_SALE_ROUND=0',
  'SEEKER_REALM_SALE_POLICY_REVISION=night-devnet-test-2026-10-06', 'SEEKER_REALM_SALE_STATE_PROVENANCE=fresh-reviewed-deployment',
].join('\n') + '\n';

test('night devnet lane takes the public test pins and gives Phase E the owner login while requests use the runtime login', () => {
  const base = runtimeEnvironment(nightLocal);
  for (const rpc of ['https://api.devnet.solana.com', 'http://127.0.0.1:8899']) {
    const env = nightDevnetEnvironment(base, nightPins(rpc), `${nightRequestUrl}\n`);
    assert.equal(env.SOLANA_RPC_URL, rpc);
    assert.equal(env.SOLANA_CLUSTER, 'devnet');
    assert.equal(env.SEEKER_REALM_SALE_PROGRAM_ID, nightProgram);
    assert.equal(env.SEEKER_REALM_SALE_ROUND, '0');
    assert.equal(env.PKW_DEVNET_TEST_PROFILE, 'night-devnet-test-2026-10-06');
    assert.equal(env.PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID, nightProgram);
    // phaseEServices.ts refuses unless the request login is not the journal owner and both share one database.
    assert.equal(env.DATABASE_URL, nightRequestUrl);
    assert.equal(env.PHASE_E_SERVICE_DATABASE_URL, nightLocal.databaseUrl);
    for (const name of ['PHASE_E_BUILDINGS_ENABLED', 'MULTI_BASE_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'HARVESTERS_ENABLED']) {
      assert.equal(env[name], 'true');
    }
    // The money and worker switches of the ordinary lane stay off.
    assert.equal(env.ENABLE_WORKERS, 'false');
    assert.equal(env.WITHDRAWALS_ENABLED, 'false');
    assert.equal(env.DEVNET_FAUCET_ENABLED, 'false');
    assert.equal(env.PHASE_E_SEEKER_ENABLED, undefined);
    assert.equal(env.SEEKER_AUCTION_CRANK_ENABLED, undefined);
  }
  const explicit = nightPins() + `PKW_DEVNET_TEST_PROFILE=night-devnet-test-2026-10-06\nPKW_DEVNET_TEST_ECONOMY_PROGRAM_ID=${nightProgram}\n`;
  assert.equal(nightDevnetEnvironment(base, explicit, nightRequestUrl).PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID, nightProgram);
  assert.throws(() => nightDevnetEnvironment(base, nightPins() + 'PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID=Other111111111111111111111111111111111111111\n', nightRequestUrl));
  assert.throws(() => nightDevnetEnvironment(base, nightPins().replace('night-devnet-test-2026-10-06', 'production-r12'), nightRequestUrl));
  assert.throws(() => nightDevnetEnvironment(base, nightPins().replace('SEEKER_REALM_SALE_ROUND=0\n', ''), nightRequestUrl));
  // The request URL must be the provisioned runtime login on this lane database, never the owner or another database.
  for (const url of [nightLocal.databaseUrl, nightRequestUrl.replace('pkw_native_local', 'shardkeep'),
    nightRequestUrl.replace('55473', '5433'), nightRequestUrl.replace(`:${'b'.repeat(64)}`, ''), `${nightRequestUrl}?sslmode=disable`, '']) {
    assert.throws(() => nightDevnetEnvironment(base, nightPins(), url));
  }
});

test('night devnet lane refuses secret-looking and unlisted names in the public env file', () => {
  const base = runtimeEnvironment(nightLocal);
  for (const line of ['SEEKER_AUCTION_CRANK_KEYPAIR_FILE=/keys/auction-crank.json', 'DEVNET_SKR_FAUCET_KEYPAIR_PATH=/keys/skr-faucet.json',
    'HOT_WALLET_KEY_FILE=/keys/hot.json', 'JWT_SECRET=override', 'HELIUS_API_TOKEN=abc', 'PGPASSWORD=abc']) {
    assert.throws(() => nightDevnetEnvironment(base, nightPins() + line + '\n', nightRequestUrl), /secret-looking/);
  }
  for (const line of ['PHASE_E_SERVICE_DATABASE_URL=postgresql://pkw_native@127.0.0.1:55473/pkw_native_local',
    'SEEKER_AUCTION_CRANK_ENABLED=true', 'PHASE_E_SEEKER_ENABLED=true', 'ENABLE_WORKERS=true', 'DATABASE_URL=postgresql://x@h/db']) {
    assert.throws(() => nightDevnetEnvironment(base, nightPins() + line + '\n', nightRequestUrl), /unlisted/);
  }
  for (const line of ['export SOLANA_CLUSTER=devnet', 'SEEKER_REALM_SALE_ROUND="0"', 'lowercase_name=1', 'NO_EQUALS_SIGN']) {
    assert.throws(() => nightDevnetEnvironment(base, nightPins() + line + '\n', nightRequestUrl));
  }
  assert.throws(() => nightDevnetEnvironment(base, nightPins() + 'SEEKER_REALM_SALE_ROUND=1\n', nightRequestUrl), /repeats/);
});

test('night devnet lane refuses any RPC other than public devnet or the local validator', () => {
  const base = runtimeEnvironment(nightLocal);
  for (const rpc of ['https://api.mainnet-beta.solana.com', 'https://api.testnet.solana.com', 'http://127.0.0.1:9',
    'https://api.devnet.solana.com/', 'http://127.0.0.1:8899/', 'http://localhost:8899', 'https://devnet.helius-rpc.com/?api-key=abc', '']) {
    assert.throws(() => nightDevnetEnvironment(base, nightPins(rpc), nightRequestUrl), /SOLANA_RPC_URL/);
  }
  assert.throws(() => nightDevnetEnvironment(base, nightPins().replace(/^SOLANA_RPC_URL=.*\n/m, ''), nightRequestUrl), /SOLANA_RPC_URL/);
  assert.throws(() => nightDevnetEnvironment(base, nightPins().replace('SOLANA_CLUSTER=devnet', 'SOLANA_CLUSTER=mainnet-beta'), nightRequestUrl));
});

test('night devnet lane leaves the ordinary runtimeEnvironment output unchanged', () => {
  const before = runtimeEnvironment(nightLocal);
  const snapshot = structuredClone(before);
  nightDevnetEnvironment(before, nightPins(), nightRequestUrl);
  assert.deepEqual(before, snapshot); // The base object is never mutated.
  const after = runtimeEnvironment(nightLocal);
  assert.deepEqual(after, snapshot);
  assert.equal(after.SOLANA_RPC_URL, 'http://127.0.0.1:9');
  assert.equal(after.DATABASE_URL, nightLocal.databaseUrl);
  for (const name of ['PHASE_E_SERVICE_DATABASE_URL', 'PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'HARVESTERS_ENABLED',
    'PKW_DEVNET_TEST_PROFILE', 'SEEKER_REALM_SALE_PROGRAM_ID']) {
    assert.equal(Object.hasOwn(after, name), false, name);
  }
});

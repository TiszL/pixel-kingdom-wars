import { isIP } from 'node:net';
import path from 'node:path';

export const PORTS = Object.freeze({ postgres: 55473, redis: 56389, api: 18871, https: 18443 });
// Opt-in override so a second isolated lane (fresh volumes) can run beside a retained one whose
// credentials this profile does not hold; unset keeps the ordinary project name.
export const PROJECT = process.env.PKW_NATIVE_LOCAL_PROJECT || 'pkw-native-local';

export function localHost(host) {
  if (host === 'localhost') return host;
  if (isIP(host) !== 4) throw new Error('Use localhost, loopback or a private IPv4 address belonging to this Mac');
  const [a, b] = host.split('.').map(Number);
  if (host !== '127.0.0.1' && a !== 10 && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168)) {
    throw new Error('Public addresses are forbidden for the local testing server');
  }
  return host;
}

export function localOrigin(raw) {
  const url = new URL(raw);
  localHost(url.hostname);
  if (url.protocol !== 'https:' || url.origin !== raw || url.port !== String(PORTS.https)) {
    throw new Error(`Use a bare local HTTPS origin on port ${PORTS.https}`);
  }
  return url;
}

export function contentRequest(raw, allowed) {
  // Validate the raw path before URL normalization can hide traversal.
  if (raw.includes('?') || raw.includes('#') || /%2f|%5c/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (!decoded.startsWith('/native-content/')) return null;
  const relative = decoded.slice('/native-content/'.length);
  if (relative.split('/').some((part) => !part || part === '.' || part === '..') || relative.includes('\\')) return null;
  return allowed.has(relative) ? relative : null;
}

export function checkedDatabase(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'postgresql:' || parsed.hostname !== '127.0.0.1' || parsed.port !== String(PORTS.postgres)
      || parsed.pathname !== '/pkw_native_local' || parsed.username !== 'pkw_native' || parsed.search || parsed.hash) {
    throw new Error('The local lane can only use its isolated pkw_native_local database');
  }
  return parsed;
}

export function runtimeEnvironment(config) {
  checkedDatabase(config.databaseUrl);
  const origin = localOrigin(config.origin).origin;
  if (!/^[a-f0-9]{64}$/.test(config.jwtSecret) || !/^[A-Za-z0-9+/]{43}=$/.test(config.twofaKey)) {
    throw new Error('Local session keys are missing; prepare a fresh local configuration');
  }
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '',
    NODE_ENV: 'production', DATABASE_URL: config.databaseUrl,
    REDIS_URL: `redis://127.0.0.1:${PORTS.redis}`, JWT_SECRET: config.jwtSecret,
    TWOFA_ENCRYPTION_KEYS: `native-local:${config.twofaKey}`,
    WEB_ORIGIN: origin, PLAY_URL: origin, LANDING_ORIGINS: origin,
    HOST: '127.0.0.1', PORT: String(PORTS.api), SOLANA_CLUSTER: 'devnet',
    // No public network economy reads or transaction submission in this lane.
    SOLANA_RPC_URL: 'http://127.0.0.1:9', ENABLE_WORKERS: 'false', RUN_INPROC_SCHEDULERS: 'false',
    DEV_LOGIN: 'false', WITHDRAWALS_ENABLED: 'false', DEVNET_FAUCET_ENABLED: 'false', KEEP_VEND_ENABLED: 'false',
    PUSH_NOTIFICATIONS_ENABLED: 'false', MINE_FULL_NOTIFICATIONS_ENABLED: 'false', SOCIAL_TOKEN_LOGIN_ENABLED: 'false',
    FREE_ONBOARDING: 'true', MULTI_BASE_ENABLED: 'true', LIVE_RAID_V2_ENABLED: 'true', FANTASY_WORLD_ENABLED: 'true',
    // Reviewed parity contract in the retained synthetic environment; source
    // startup still requires its immutable receipt migration. Production stays opt-in.
    HERO_RECRUITMENT_ENABLED: 'true',
    WALL_BATCH_V1_ENABLED: 'true',
    BASE_PURCHASE_V1_ENABLED: 'true', SHIELD_PURCHASE_V1_ENABLED: 'true', ENERGY_PURCHASE_V1_ENABLED: 'true', BASE_CLAIM_V1_ENABLED: 'true',
    NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_OPEN: 'true', NATIVE_PRESENTATION_WORKERS: '1',
    NATIVE_CONTENT_MANIFEST_URL: `${origin}/native-content/manifest.json`,
    // M45 update channel: the lane advertises only rows the operator inserts into the
    // local database; the proxy serves `.reports/local-dev/releases/<code>-<sha256>.apk`.
    NATIVE_UPDATE_CHANNEL_ENABLED: 'true',
  };
}

// 2026-10-06 devnet TEST lane only; opt-in from local-dev.mjs.
export const NIGHT_DEVNET_PROFILE = 'night-devnet-test-2026-10-06';
export const NIGHT_DEVNET_RPC = Object.freeze(['https://api.devnet.solana.com', 'http://127.0.0.1:8899']);
// Written 0600 by the server's scripts/night-devnet-local-api.mjs prepare-phase-e-role.
export const NIGHT_DEVNET_REQUEST_URL_FILE = 'night-devnet-request-database-url';
export const NIGHT_DEVNET_REQUEST_LOGIN = 'pkw_native_night_api';
const NIGHT_REALM_SALE = ['PROGRAM_ID', 'DEPLOYMENT_SLOT', 'PROGRAM_DATA_SHA256', 'UPGRADE_AUTHORITY', 'AUCTION_MINT',
  'PRIZE_OWNER', 'DEVELOPER', 'ROUND', 'POLICY_REVISION', 'STATE_PROVENANCE'].map((name) => `SEEKER_REALM_SALE_${name}`);
const NIGHT_SWITCHES = ['PHASE_E_BUILDINGS_ENABLED', 'MULTI_BASE_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'HARVESTERS_ENABLED'];
// Chain plan section H "What a server needs", public values only. PHASE_E_SERVICE_DATABASE_URL is
// listed there too but carries a password, so it never comes from the public file.
const NIGHT_PUBLIC_NAMES = new Set(['SOLANA_CLUSTER', 'SOLANA_RPC_URL', ...NIGHT_REALM_SALE, ...NIGHT_SWITCHES,
  'PKW_DEVNET_TEST_PROFILE', 'PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID']);

/** `base` is runtimeEnvironment(config), never mutated. The request login replaces DATABASE_URL and the
 * lane's owner login becomes the Phase E private service login (same DB, separate LOGIN). */
export function nightDevnetEnvironment(base, publicEnvText, requestDatabaseUrl) {
  const owner = checkedDatabase(base.DATABASE_URL);
  const parsed = {};
  for (const raw of String(publicEnvText).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Z][A-Z0-9_]*)=([^\s'"`]*)$/.exec(line);
    if (!match) throw new Error('The night public env file holds only NAME=value lines without spaces or quotes');
    const [, name, value] = match;
    if (/KEY_FILE|KEYPAIR|SECRET|TOKEN|PASSWORD/.test(name)) throw new Error(`The night public env file refuses a secret-looking name: ${name}`);
    if (!NIGHT_PUBLIC_NAMES.has(name)) throw new Error(`The night public env file refuses an unlisted name: ${name}`);
    if (Object.hasOwn(parsed, name)) throw new Error(`The night public env file repeats ${name}`);
    parsed[name] = value;
  }
  if (!NIGHT_DEVNET_RPC.includes(parsed.SOLANA_RPC_URL)) {
    throw new Error(`The night lane SOLANA_RPC_URL must be exactly ${NIGHT_DEVNET_RPC.join(' or ')}`);
  }
  if ((parsed.SOLANA_CLUSTER ?? 'devnet') !== 'devnet') throw new Error('The night lane runs on SOLANA_CLUSTER=devnet only');
  for (const name of NIGHT_REALM_SALE) if (!parsed[name]) throw new Error(`The night public env file is missing ${name}`);
  if ((parsed.PKW_DEVNET_TEST_PROFILE ?? NIGHT_DEVNET_PROFILE) !== NIGHT_DEVNET_PROFILE
      || parsed.SEEKER_REALM_SALE_POLICY_REVISION !== NIGHT_DEVNET_PROFILE) {
    throw new Error(`The night lane serves only the ${NIGHT_DEVNET_PROFILE} test profile`);
  }
  const testProgram = parsed.PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID ?? parsed.SEEKER_REALM_SALE_PROGRAM_ID;
  if (testProgram !== parsed.SEEKER_REALM_SALE_PROGRAM_ID) {
    throw new Error('PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID must equal SEEKER_REALM_SALE_PROGRAM_ID');
  }
  const requestUrl = String(requestDatabaseUrl).trim();
  let request;
  try { request = new URL(requestUrl); } catch { request = null; } // Never echo a URL that carries a password.
  if (!request || request.protocol !== owner.protocol || request.hostname !== owner.hostname || request.port !== owner.port
      || request.pathname !== owner.pathname || request.username !== NIGHT_DEVNET_REQUEST_LOGIN || !request.password
      || request.search || request.hash) {
    throw new Error('Run the server prepare-phase-e-role step: the night request login URL is missing or not this lane');
  }
  return {
    ...base, ...parsed,
    PKW_DEVNET_TEST_PROFILE: NIGHT_DEVNET_PROFILE, PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID: testProgram,
    DATABASE_URL: requestUrl, PHASE_E_SERVICE_DATABASE_URL: base.DATABASE_URL,
    ...Object.fromEntries(NIGHT_SWITCHES.map((name) => [name, 'true'])),
  };
}

export function inside(root, filename) {
  const relative = path.relative(root, filename);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path must remain inside its declared root');
  return filename;
}

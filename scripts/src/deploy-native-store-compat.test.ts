/**
 * M45 D1, rewritten for G6 Path A (owner D1, 2026-10-10). The API only echoes what
 * infra/.env.prod says, so deploy.sh is where installed Android builds are protected.
 *
 * WHY, in the owner's words (2026-10-10, 14:20Z): "no problem to deploy new code 33
 * because we have autoupdater so anyone who has code 25 or installs it can autoupdate
 * so ship it", and 14:50Z, with a screenshot of the dApp Store publisher portal: "that
 * means production is running code 32 rn now not code 25". The store's LIVE build is
 * 0.6.6 / code 32 (28 Sep 2026); 0.5.8 / code 25 and below are Deprecated there. The
 * old pin (store code 25) was a stale repository record, not the store.
 *
 * The rule these tests hold deploy.sh to:
 *  1. Every build compiles ONE SIM and compares it by strict equality. Codes 25-32
 *     compile SIM 17; code 33 is the first SIM-18 build. A SIM-18 tree ships only with
 *     NATIVE_MIN_VERSION_CODE >= 33, so every SIM-17 build gets "update required"
 *     instead of a server it cannot fight or order on. No flag overrides that, and a
 *     SIM-18 legacy manifest is not a way around it (the forbidden shortcut).
 *  2. A floor above the store's live code (32) stops every order from the store build
 *     until it takes the update, so it needs the explicit DEPLOY_ALLOW_FLOOR_RAISE=1
 *     (the owner's acceptance) until code 33 is live on the store.
 *  3. Header-less code 25 (no updater) reads the legacy manifest and refuses any pack
 *     above renderer contract 14 or on a SIM other than its own 17, so that manifest
 *     stays a SIM-17 pack whatever the tree compiles: below the floor it still signs
 *     in and shows the base with a clean "update required".
 * deploy.sh must refuse a violation (1) before the build or maintenance window,
 * fetching the manifest code 25 will be served, and (2) prove what the NEW api
 * container actually serves before traffic returns — an image that ignores
 * NATIVE_CONTENT_MANIFEST_URL_LEGACY (pre-PR #136) or the floor would break it while
 * every env value looks right.
 *
 * Both node probes run for real; only `fetch` is replaced (NODE_OPTIONS --import)
 * so the tests never reach the network or a docker daemon. The SIM a scenario runs
 * on is written into the scratch copy of packages/sim/src/version.ts; the tree's own
 * SIM is used where a test says so.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../../packages/sim/src/version.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');

function at(marker: string, from = 0): number {
  const index = DEPLOY.indexOf(marker, from);
  expect(index, `infra/deploy.sh must contain ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

const PREFLIGHT_START = '# --- pre-flight: the installed store build keeps working (M45 D1)';
const PREFLIGHT_END = '# A deploy must be reproducible from a commit.';
const PROBE_START = 'native_capabilities_proven() {';
const PROBE_END = 'traffic remains stopped."\n';
const preflightBlock = () => DEPLOY.slice(at(PREFLIGHT_START), at(PREFLIGHT_END));
const probeBlock = () => { const start = at(PROBE_START); return DEPLOY.slice(start, at(PROBE_END, start) + PROBE_END.length); };

const LEGACY = 'https://content.example/native-content/794a074d/manifest.json';
const MAIN = 'https://content.example/native-content/new-pack/manifest.json';
const CAPABILITIES = 'http://127.0.0.1:3001/native/capabilities';

/** Code 25's own SIM and generation: frozen forever (it has no updater). */
const CODE25_SIM = 17;
/** The SIM the G6 Path A server runs and code 33 is the first build to compile. */
const PATH_A_SIM = 18;

interface Route { url: string; contract?: string | null; status?: number; body: unknown }
interface Call { url: string; client: string | null; contract: string | null }
interface Options { env?: Record<string, string>; sim?: number; block?: (block: string) => string }

const FETCH_STUB = `import { appendFileSync, readFileSync } from 'node:fs';
const routes = JSON.parse(readFileSync(process.env.FETCH_STUB, 'utf8'));
globalThis.fetch = async (url, init = {}) => {
  const headers = new Headers(init.headers);
  const call = { url: String(url), client: headers.get('x-pkw-client'), contract: headers.get('x-pkw-renderer-contract') };
  appendFileSync(process.env.FETCH_LOG, JSON.stringify(call) + '\\n');
  const route = routes.find((r) => r.url === call.url && (r.contract ?? null) === call.contract);
  if (!route) throw new TypeError('fetch failed');
  return new Response(typeof route.body === 'string' ? route.body : JSON.stringify(route.body), { status: route.status ?? 200 });
};
`;

/** Runs `script` under bash in a scratch copy of the files the block reads,
 * with deploy.sh's die/say and a compose that runs `exec -T api <cmd>` locally.
 * `sim` writes that SIM into the scratch version.ts; without it the tree's file is copied. */
function run(script: string, envFile: string, routes: Route[], { env = {}, sim }: Options = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'native-store-compat-'));
  try {
    for (const file of ['packages/sim/src/version.ts', 'apps/api/src/native/contracts.ts']) {
      mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      copyFileSync(path.join(ROOT, file), path.join(directory, file));
    }
    if (sim !== undefined) writeFileSync(path.join(directory, 'packages/sim/src/version.ts'), `export const SIM_VERSION = ${sim};\n`);
    writeFileSync(path.join(directory, 'env'), envFile);
    writeFileSync(path.join(directory, 'stub.mjs'), FETCH_STUB);
    writeFileSync(path.join(directory, 'routes.json'), JSON.stringify(routes));
    writeFileSync(path.join(directory, 'fetch.log'), '');
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('DEPLOY_') && name !== 'NODE_OPTIONS'));
    const result = spawnSync('bash', ['-c', `set -euo pipefail
ENV_FILE=env
die() { echo "FAIL: $*"; exit 1; }
say() { echo "SAY: $*"; }
API_DOMAIN=play.example
fake_compose() { if [ "$1" = ps ]; then printf '%s\\n' "\${FAKE_RUNNING_SERVICES:-caddy}"; return 0; fi; shift 3; "$@"; }
COMPOSE=fake_compose
${script}
echo PASSED`], {
      cwd: directory, encoding: 'utf8',
      env: { ...inherited, ...env, NODE_OPTIONS: `--import ${pathToFileURL(path.join(directory, 'stub.mjs')).href}`,
        FETCH_STUB: path.join(directory, 'routes.json'), FETCH_LOG: path.join(directory, 'fetch.log') },
    });
    const calls = readFileSync(path.join(directory, 'fetch.log'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Call);
    return { status: result.status, out: result.stdout + result.stderr, calls };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

const VALUES = 'echo "VALUES $NATIVE_FLOOR_LIMIT|$NATIVE_CONTENT_SERVED_LEGACY|$NATIVE_CONTENT_MAIN|$TREE_SIM_VERSION|$NATIVE_REALM_KIT_CONTRACT|$NATIVE_SIM_FIRST_CODE"';
const preflight = (envFile: string, routes: Route[] = [], options: Options = {}) =>
  run(`${(options.block ?? ((b: string) => b))(preflightBlock())}\n${VALUES}`, envFile, routes, options);
const onSim17 = (envFile: string, routes: Route[] = [], options: Options = {}) => preflight(envFile, routes, { sim: CODE25_SIM, ...options });
const onSim18 = (envFile: string, routes: Route[] = [], options: Options = {}) => preflight(envFile, routes, { sim: PATH_A_SIM, ...options });
const RAISE = { DEPLOY_ALLOW_FLOOR_RAISE: '1' };

/** Code 25's own generation (794a074d…): SIM 17, contract 14. */
const storeManifest = { contentVersion: '794a074d', simVersion: CODE25_SIM, rendererContractVersion: 14 };
const sim18Pack = { contentVersion: '711f2eb0', simVersion: PATH_A_SIM, rendererContractVersion: 15 };
// Production today: SIM 17, floor 24, two-URL cutover done (main = contract-15 pack, LEGACY = code 25's).
const production = `NATIVE_MIN_VERSION_CODE=24\nNATIVE_CONTENT_MANIFEST_URL=${LEGACY}\n`;
const cutover = `NATIVE_MIN_VERSION_CODE=24\nNATIVE_CONTENT_MANIFEST_URL=${MAIN}\nNATIVE_CONTENT_MANIFEST_URL_LEGACY=${LEGACY}\n`;
// G6 Path A: the same two URLs, the floor at the first SIM-18 build.
const pathA = `NATIVE_MIN_VERSION_CODE=33\nNATIVE_CONTENT_MANIFEST_URL=${MAIN}\nNATIVE_CONTENT_MANIFEST_URL_LEGACY=${LEGACY}\n`;
const pathARoutes: Route[] = [{ url: LEGACY, body: storeManifest }, { url: MAIN, body: sim18Pack }];

describe('deploy.sh pre-flight: what installed native builds can use (M45 D1, G6 Path A)', () => {
  it('runs before the build, the writer drain and the maintenance window', () => {
    // A refusal after any of these would already have cost players the release window.
    const guard = at(PREFLIGHT_START);
    expect(guard).toBeLessThan(at('pnpm install --frozen-lockfile'));
    expect(guard).toBeLessThan(at('say "entering maintenance'));
    expect(guard).toBeLessThan(at('say "running migrations"'));
  });

  it('records the store\'s live build (code 32, owner screenshot 2026-10-10), header-less code 25 on SIM 17, and code 33 as the first SIM-18 build', () => {
    // WHY: the old value 25 came from a stale repository record and nearly decided the launch path
    // (owner 14:50Z: "production is running code 32 rn now not code 25"). Each number is a fact about
    // installed phones; moving one is an owner-visible release decision, never a way to pass a gate.
    const block = preflightBlock();
    expect(block).toMatch(/^STORE_NATIVE_VERSION_CODE=32$/m);
    expect(block).toMatch(/^LEGACY_NATIVE_VERSION_CODE=25$/m);
    expect(block).toMatch(/^LEGACY_NATIVE_SIM_VERSION=17$/m);
    expect(block).toMatch(/^ {2}18\) NATIVE_SIM_FIRST_CODE=33 ;;/m);
  });

  it('reads the tree SIM, the realm-kit contract and the first build on that SIM', () => {
    expect(onSim17(production, [{ url: LEGACY, body: storeManifest }]).out).toContain(`VALUES 32|${LEGACY}|${LEGACY}|17|15|0`);
    expect(onSim18(pathA, pathARoutes, { env: RAISE }).out).toContain(`VALUES 33|${LEGACY}|${MAIN}|18|15|33`);
  });

  describe('a SIM-17 tree (today\'s production server)', () => {
    it.each(['', 'NATIVE_MIN_VERSION_CODE=\n', 'NATIVE_MIN_VERSION_CODE=24\n', 'NATIVE_MIN_VERSION_CODE=25\n',
      'NATIVE_MIN_VERSION_CODE="25"\n', 'NATIVE_MIN_VERSION_CODE=32\n'])(
      'accepts a floor the store\'s live code 32 still clears, with no override: %j', (envFile) => {
        expect(onSim17(envFile)).toMatchObject({ status: 0, calls: [] });
      });

    it('refuses a floor above 32 because the store build would stop every order until it updates', () => {
      const result = onSim17('NATIVE_MIN_VERSION_CODE=33\n');
      expect(result.status).toBe(1);
      expect(result.out).toContain('FAIL: NATIVE_MIN_VERSION_CODE=33 is above 32, the dApp Store\'s live build');
      expect(result.out).toContain('stops ALL orders');
      expect(result.out).toContain('installed code 32 must take the mandatory update before it can order');
      expect(result.out).toContain('Nothing was changed');
      expect(result.out).not.toContain('PASSED');
    });

    it('lets the owner raise the floor only with the explicit override, says what it costs, and then expects that floor served', () => {
      const result = onSim17('NATIVE_MIN_VERSION_CODE=33\n', [], { env: RAISE });
      expect(result.status).toBe(0);
      expect(result.out).toContain('SAY: DEPLOY_ALLOW_FLOOR_RAISE=1 — native floor 33 is above store code 32: installed code 32 must take the mandatory update before it can order');
      expect(result.out).toContain('VALUES 33|');
      expect(onSim17('NATIVE_MIN_VERSION_CODE=33\n', [], { env: { DEPLOY_ALLOW_FLOOR_RAISE: 'yes' } }).out)
        .toContain('FAIL: DEPLOY_ALLOW_FLOOR_RAISE must be 0 or 1.');
    });
  });

  describe('a SIM-18 tree (G6 Path A: ships only with Android code 33 and NATIVE_MIN_VERSION_CODE=33)', () => {
    it('the tree as committed compiles SIM 18, so production\'s floor 24 is refused for it', () => {
      // WHY: ties the gate to the real tree, not only to a scratch SIM: shipping this tree with the
      // current production .env.prod would put codes 25-32 (SIM 17, strict equality) on a SIM-18 server.
      expect(SIM_VERSION).toBe(PATH_A_SIM);
      const result = preflight(cutover, pathARoutes, { env: RAISE });
      expect(result.status).toBe(1);
      expect(result.out).toContain('FAIL: this tree compiles SIM 18, but NATIVE_MIN_VERSION_CODE=24 still admits builds below code 33');
    });

    it.each(['', 'NATIVE_MIN_VERSION_CODE=0\n', 'NATIVE_MIN_VERSION_CODE=24\n', 'NATIVE_MIN_VERSION_CODE=25\n', 'NATIVE_MIN_VERSION_CODE=32\n'])(
      'refuses a floor that still admits a SIM-17 build, even with DEPLOY_ALLOW_FLOOR_RAISE=1 and before any fetch: %j', (envFile) => {
        const result = onSim18(envFile, pathARoutes, { env: RAISE });
        expect(result.status).toBe(1);
        expect(result.out).toContain('still admits builds below code 33');
        expect(result.out).toContain('Code 33 is the first Android build on SIM 18');
        expect(result.out).toContain('No flag overrides this');
        expect(result.calls).toEqual([]);
        expect(result.out).not.toContain('PASSED');
      });

    it('refuses the forbidden shortcut: a SIM-18 legacy manifest while the floor still admits SIM-17 builds', () => {
      // WHY: making the legacy manifest SIM 18 would satisfy a "manifest SIM == tree SIM" check while
      // codes 25-32 (all SIM 17) keep ordering against a server they cannot fight on.
      const shortcut = `NATIVE_MIN_VERSION_CODE=32\nNATIVE_CONTENT_MANIFEST_URL=${MAIN}\nNATIVE_CONTENT_MANIFEST_URL_LEGACY=${LEGACY}\n`;
      const result = onSim18(shortcut, [{ url: LEGACY, body: { ...storeManifest, simVersion: PATH_A_SIM } }, { url: MAIN, body: sim18Pack }], { env: RAISE });
      expect(result.status).toBe(1);
      expect(result.out).toContain('a SIM-18 legacy content\n  manifest does not make an older build compatible');
      expect(result.calls).toEqual([]);
    });

    it('refuses floor 33 without the override: installed code 32 must take the mandatory update before it can order', () => {
      const result = onSim18(pathA, pathARoutes);
      expect(result.status).toBe(1);
      expect(result.out).toContain('FAIL: NATIVE_MIN_VERSION_CODE=33 is above 32, the dApp Store\'s live build');
      expect(result.out).toContain('installed code 32 must take the mandatory update before it can order');
      expect(result.out).toContain('rerun with DEPLOY_ALLOW_FLOOR_RAISE=1');
      expect(result.calls).toEqual([]);
    });

    it('passes floor 33 with the owner\'s override, code 25\'s own SIM-17 legacy pack and a SIM-18 main pack', () => {
      const result = onSim18(pathA, pathARoutes, { env: RAISE });
      expect(result.status).toBe(0);
      expect(result.out).toContain('SAY: DEPLOY_ALLOW_FLOOR_RAISE=1 — native floor 33 is above store code 32: installed code 32 must take the mandatory update before it can order');
      expect(result.out).toContain('native content manifests verified (code 25: SIM 17, renderer contract 14; tree SIM 18)');
      expect(result.calls.map(c => c.url)).toEqual([LEGACY, MAIN]);
      expect(onSim18('NATIVE_MIN_VERSION_CODE=40\n', [], { env: RAISE }).out).toContain('VALUES 40|');
    });

    it('needs no override once code 33 is live on the store and STORE_NATIVE_VERSION_CODE follows it', () => {
      // WHY: DEPLOY_ALLOW_FLOOR_RAISE is the owner's acceptance of a floor above the store's live
      // build; it must not become a permanent part of every later deploy.
      const storeAt33 = (block: string) => block.replace(/^STORE_NATIVE_VERSION_CODE=32$/m, 'STORE_NATIVE_VERSION_CODE=33');
      expect(onSim18(pathA, pathARoutes, { block: storeAt33 })).toMatchObject({ status: 0 });
      expect(onSim18('NATIVE_MIN_VERSION_CODE=32\n', [], { block: storeAt33 }).out).toContain('still admits builds below code 33');
    });

    it('refuses a SIM-18 legacy manifest even above the floor: code 25 refuses it and would lose its base view', () => {
      const result = onSim18(pathA, [{ url: LEGACY, body: { ...storeManifest, simVersion: PATH_A_SIM } }, { url: MAIN, body: sim18Pack }], { env: RAISE });
      expect(result.status).toBe(1);
      expect(result.out).toContain(`has simVersion 18, but installed code 25 compiles SIM_VERSION 17 and requires strict equality (this tree compiles SIM 18)`);
      expect(result.out).toContain('FAIL: a native content manifest cannot serve installed code 25');
    });

    it('enforces the SIM floor even when the manifest fetch is deferred (caddy down) or break-glass skipped', () => {
      // WHY: the deferral hole (G6 report §1.2) skips the manifest comparison on a rerun; the SIM
      // floor is read from the env file alone, so no rerun path can ship SIM 18 to SIM-17 builds.
      expect(onSim18(cutover, pathARoutes, { env: { ...RAISE, FAKE_RUNNING_SERVICES: 'api\npostgres' } }).out)
        .toContain('still admits builds below code 33');
      expect(onSim18(cutover, [], { env: { ...RAISE, DEPLOY_SKIP_CONTENT_PROBE: '1' } }).out)
        .toContain('still admits builds below code 33');
    });
  });

  it('refuses a tree SIM with no recorded first Android code', () => {
    const result = preflight(pathA, pathARoutes, { env: RAISE, sim: 19 });
    expect(result.status).toBe(1);
    expect(result.out).toContain('FAIL: this tree compiles SIM 19, and infra/deploy.sh records no first Android version code for it');
  });

  it.each(['NATIVE_MIN_VERSION_CODE=abc\n', 'NATIVE_MIN_VERSION_CODE=24\nNATIVE_MIN_VERSION_CODE=30\n', 'NATIVE_MIN_VERSION_CODE=99999999999\n'])(
    'refuses a floor it cannot compare: %j', (envFile) => {
      expect(onSim17(envFile).out).toContain('FAIL: NATIVE_MIN_VERSION_CODE must appear at most once');
    });

  it('fetches the manifest code 25 is served today (main, LEGACY unset) and accepts SIM 17, contract <= 14', () => {
    const result = onSim17(production, [{ url: LEGACY, body: storeManifest }]);
    expect(result).toMatchObject({ status: 0, calls: [{ url: LEGACY }] });
    expect(onSim17(production, [{ url: LEGACY, body: { simVersion: CODE25_SIM } }]).status).toBe(0);
  });

  it('after the two-URL cutover checks LEGACY for code 25 and still requires the main pack to answer', () => {
    const main = { simVersion: CODE25_SIM, rendererContractVersion: 15 };
    const ok = onSim17(cutover, [{ url: LEGACY, body: storeManifest }, { url: MAIN, body: main }]);
    expect(ok).toMatchObject({ status: 0, calls: [{ url: LEGACY }, { url: MAIN }] });
    const missing = onSim17(cutover, [{ url: LEGACY, body: storeManifest }, { url: MAIN, status: 404, body: 'no' }]);
    expect(missing.status).toBe(1);
    expect(missing.out).toContain(`main content manifest ${MAIN} returned HTTP 404, not 200`);
  });

  it.each([
    [{ ...storeManifest, rendererContractVersion: 15 }, 'has rendererContractVersion 15; installed code 25 refuses any pack above 14'],
    [{ ...storeManifest, rendererContractVersion: '14' }, 'has rendererContractVersion "14"'],
    [{ ...storeManifest, simVersion: 16 }, 'has simVersion 16, but installed code 25 compiles SIM_VERSION 17 and requires strict equality (this tree compiles SIM 17)'],
    [{ contentVersion: '794a074d' }, 'has simVersion undefined'],
    ['<html>not json</html>', 'is not a JSON object'],
  ])('refuses a code-25 manifest it cannot load: %j', (body, reason) => {
    const result = onSim17(production, [{ url: LEGACY, body }]);
    expect(result.status).toBe(1);
    expect(result.out).toContain(reason);
    expect(result.out).toContain('FAIL: a native content manifest cannot serve installed code 25');
  });

  it('refuses a code-25 manifest that is unreachable or not HTTP 200', () => {
    expect(onSim17(production, []).out).toContain(`code-25 content manifest ${LEGACY} could not be fetched`);
    expect(onSim17(production, [{ url: LEGACY, status: 503, body: 'down' }]).out).toContain('returned HTTP 503, not 200');
  });

  it.each([
    `NATIVE_CONTENT_MANIFEST_URL=http://content.example/m.json\n`,
    `NATIVE_CONTENT_MANIFEST_URL_LEGACY=${LEGACY}\nNATIVE_CONTENT_MANIFEST_URL_LEGACY=${MAIN}\n`,
  ])('refuses a URL the API itself would not boot with, or a duplicate: %j', (envFile) => {
    expect(onSim17(envFile, [{ url: LEGACY, body: storeManifest }]).out).toMatch(/FAIL: NATIVE_CONTENT_MANIFEST_URL(_LEGACY)? must appear at most once/);
  });

  it('defers the manifest check when caddy is not running, because the rerun after a failed gate is what restores traffic', () => {
    // WHY: a late gate that dies leaves caddy stopped; if this pre-flight then died on
    // ECONNREFUSED, no rerun could ever bring the site back without the break-glass flag.
    const result = onSim17(production, [{ url: LEGACY, body: storeManifest }], { env: { FAKE_RUNNING_SERVICES: 'api\npostgres' } });
    expect(result).toMatchObject({ status: 0, calls: [] });
    expect(result.out).toContain('caddy is not running');
    expect(result.out).toContain('checked by the in-container gate instead');
  });

  it('defers when the public origin serves the maintenance page (every non-/api path answers 503 there)', () => {
    const result = onSim17(production, [
      { url: LEGACY, status: 503, body: 'Service Unavailable' },
      { url: 'https://play.example/api/version', status: 503, body: { error: { code: 'MAINTENANCE' } } },
    ]);
    expect(result.status).toBe(0);
    expect(result.out).toContain('serves the maintenance page');
    expect(result.calls.map(c => c.url)).toEqual([LEGACY, 'https://play.example/api/version']);
  });

  it('still refuses a 503 that is not the maintenance page', () => {
    const result = onSim17(production, [
      { url: LEGACY, status: 503, body: 'Service Unavailable' },
      { url: 'https://play.example/api/version', status: 200, body: { gitSha: 'abc' } },
    ]);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`code-25 content manifest ${LEGACY} returned HTTP 503, not 200`);
  });

  it('derives the contract cap for installed code 25 from the tree, never from a second constant', () => {
    expect(preflightBlock()).toContain('LEGACY_NATIVE_MAX_RENDERER_CONTRACT=$((NATIVE_REALM_KIT_CONTRACT - 1))');
    expect(preflightBlock()).not.toMatch(/NATIVE_MAX_RENDERER_CONTRACT=14/);
  });

  it('skips only the network fetch under the break-glass DEPLOY_SKIP_CONTENT_PROBE=1, and says so', () => {
    const result = onSim17(production, [], { env: { DEPLOY_SKIP_CONTENT_PROBE: '1' } });
    expect(result).toMatchObject({ status: 0, calls: [] });
    expect(result.out).toContain('BREAK-GLASS: native content manifests were NOT fetched');
    // The URL shape and floor checks are not break-glass.
    expect(onSim17('NATIVE_MIN_VERSION_CODE=33\n', [], { env: { DEPLOY_SKIP_CONTENT_PROBE: '1' } }).status).toBe(1);
  });
});

describe('deploy.sh proves the served native capabilities before traffic returns (M45 D1, G6 Path A)', () => {
  it('runs after the new api is verified and before the dist is published or traffic returns', () => {
    const call = at('native_capabilities_proven "$TREE_SIM_VERSION"');
    expect(call).toBeGreaterThan(at('verify_serving_health\n\nsay "verifying the served browser RPC relay'));
    expect(call).toBeLessThan(at('rsync -a --delete'));
    expect(call).toBeLessThan(at('$COMPOSE exec -T caddy caddy reload --config /etc/caddy/Caddyfile \\'));
    expect(probeBlock()).toContain('$COMPOSE exec -T api node - "$@"');
  });

  const served = (store: Record<string, unknown>, modernUrl: string | null = MAIN, sim = CODE25_SIM, floor = 24): Route[] => [
    { url: CAPABILITIES, contract: null, body: { simVersion: sim, minimumVersionCode: floor, contentManifestUrl: LEGACY, presentation: { enabled: true }, ...store } },
    { url: CAPABILITIES, contract: '15', body: { simVersion: sim, minimumVersionCode: floor, contentManifestUrl: modernUrl, presentation: { enabled: true } } },
  ];
  const deployWith = (envFile: string, routes: Route[], options: Options = { sim: CODE25_SIM }) =>
    run(`${preflightBlock()}\n${probeBlock()}`, envFile, [{ url: LEGACY, body: storeManifest }, { url: MAIN, body: {} }, ...routes], options);

  it('passes when code 25 (no renderer header) gets LEGACY, SIM and floor <= 32, and contract 15 gets main', () => {
    const result = deployWith(cutover, served({}));
    expect(result.status).toBe(0);
    expect(result.out).toContain('served native capabilities keep installed code 25 working');
    expect(result.calls.filter(c => c.url === CAPABILITIES)).toEqual([
      { url: CAPABILITIES, client: 'android-native', contract: null },
      { url: CAPABILITIES, client: 'android-native', contract: '15' },
    ]);
  });

  it('expects main for both when LEGACY is unset (today\'s production)', () => {
    expect(deployWith(production, served({}, LEGACY)).status).toBe(0);
  });

  it.each([
    // An image older than PR #136 ignores LEGACY and serves main to everyone.
    [{ contentManifestUrl: MAIN }, `contentManifestUrl "${MAIN}", expected "${LEGACY}"`],
    [{ simVersion: CODE25_SIM + 1 }, `simVersion ${CODE25_SIM + 1}, expected ${CODE25_SIM}`],
    [{ minimumVersionCode: 33 }, 'minimumVersionCode 33, expected <= 32'],
  ])('refuses served capabilities the env file and tree do not allow: %j', (store, reason) => {
    const result = deployWith(cutover, served(store));
    expect(result.status).toBe(1);
    expect(result.out).toContain(reason);
    expect(result.out).toContain('FAIL: the new api does not serve installed native builds');
    expect(result.out).toContain('traffic remains stopped');
  });

  it('G6 Path A: passes SIM 18 with floor 33 served to both views, and says every older build must update', () => {
    const result = deployWith(pathA, served({}, MAIN, PATH_A_SIM, 33), { sim: PATH_A_SIM, env: RAISE });
    expect(result.status).toBe(0);
    expect(result.out).toContain('served native capabilities: SIM 18, every build below code 33 must take the update before it can order');
  });

  it('G6 Path A: refuses a served floor that admits SIM-17 builds, whatever the env file said', () => {
    // WHY: the env file is not the proof; an image or config that drops the floor would let codes
    // 25-32 order against a SIM-18 server. The served value must clear the first SIM-18 build.
    const result = deployWith(pathA, served({ minimumVersionCode: 24 }, MAIN, PATH_A_SIM, 33), { sim: PATH_A_SIM, env: RAISE });
    expect(result.status).toBe(1);
    expect(result.out).toContain('minimumVersionCode 24 admits builds below code 33, the first on SIM 18');
    expect(result.out).toContain('FAIL: the new api does not serve installed native builds');
  });

  it('refuses when a realm-kit renderer is not served the main pack', () => {
    const result = deployWith(cutover, served({}, LEGACY));
    expect(result.status).toBe(1);
    expect(result.out).toContain(`renderer contract 15: contentManifestUrl "${LEGACY}", expected "${MAIN}"`);
  });

  it('refuses when the capabilities route fails or the api cannot be reached', () => {
    const failing: Route[] = [{ url: CAPABILITIES, contract: null, status: 500, body: { error: 'boom' } }];
    expect(deployWith(cutover, failing).out).toContain('no renderer header (code 25): /native/capabilities returned HTTP 500');
    expect(deployWith(cutover, []).out).toContain('native capabilities probe failed: fetch failed');
  });
});

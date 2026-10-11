/**
 * Production hardening (2026-10-10) — production runs SOLANA_CLUSTER=devnet with
 * NODE_ENV=production, exactly like the QA chain lane. The lane's devnet TEST
 * profile (PKW_DEVNET_TEST_*), its TEST league pot (LEAGUE_SEASON_TEST_POT_ENABLED=true)
 * and its deedless faucet admission (DEVNET_SKR_FAUCET_DEEDLESS_OK) are therefore not
 * refused by the API itself (only the last one is, at boot). A line copied from the
 * lane's env into infra/.env.prod would point production money paths at the TEST
 * programs or TEST pot. deploy.sh must refuse that file before anything is built,
 * drained or migrated, and must never echo the value it found.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');
const PROD_EXAMPLE = readFileSync(path.join(ROOT, 'infra/.env.prod.example'), 'utf8');

function at(marker: string): number {
  const index = DEPLOY.indexOf(marker);
  expect(index, `infra/deploy.sh must contain ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

const PREFLIGHT_START = '# --- pre-flight: no devnet TEST profile on production';
const PREFLIGHT_END = '# --- pre-flight: required custody/account-security configuration';

function runPreflight(envFile: string): { status: number | null; stdout: string } {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'devnet-test-preflight-'));
  try {
    writeFileSync(path.join(directory, 'env'), envFile);
    const block = DEPLOY.slice(at(PREFLIGHT_START), at(PREFLIGHT_END));
    const result = spawnSync('bash', ['-c', `set -euo pipefail
ENV_FILE=env
die() { echo "FAIL: $*"; exit 1; }
${block}
echo PASSED`], { cwd: directory, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

describe('deploy.sh refuses a devnet TEST profile in infra/.env.prod', () => {
  it('runs before the build, the maintenance window, the backup and every migration', () => {
    // A refusal after any of these would leave production drained or half-built.
    const preflight = at(PREFLIGHT_START);
    expect(preflight).toBeLessThan(at('disk_space_preflight\n\n# --- web dist'));
    expect(preflight).toBeLessThan(at('pnpm install --frozen-lockfile'));
    expect(preflight).toBeLessThan(at('docker build \\'));
    expect(preflight).toBeLessThan(at('say "entering maintenance'));
    expect(preflight).toBeLessThan(at('say "quiescent pre-migration backup"'));
    expect(preflight).toBeLessThan(at('if [ "${HOLD_BEFORE_MIGRATE:-0}" = "1" ]; then'));
  });

  it('accepts the committed production example, so copying it never trips the check', () => {
    expect(runPreflight(PROD_EXAMPLE)).toMatchObject({ status: 0, stdout: 'PASSED\n' });
  });

  it.each([
    'SOLANA_CLUSTER=devnet\nNODE_ENV=production\n',
    // The example carries the flag as false; unset/empty/false are all inert, in
    // each assignment form compose reads (KEY=value, KEY: value, export, CRLF).
    'LEAGUE_SEASON_TEST_POT_ENABLED=false\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED="false"\n',
    "LEAGUE_SEASON_TEST_POT_ENABLED='false'\n",
    'LEAGUE_SEASON_TEST_POT_ENABLED=\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED=""\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED=false # never on production\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED: false\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED: "false"\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED:\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED = false\n',
    '  export LEAGUE_SEASON_TEST_POT_ENABLED=false\n',
    'LEAGUE_SEASON_TEST_POT_ENABLED=false\r\n',
    // Comments (in every form) and look-alike names are not variables compose delivers.
    '# PKW_DEVNET_TEST_PROFILE=phase-e-devnet-test\n# DEVNET_SKR_FAUCET_DEEDLESS_OK=true\n',
    '  # PKW_DEVNET_TEST_PROFILE: phase-e-devnet-test\n#DEVNET_SKR_FAUCET_DEEDLESS_OK\n# LEAGUE_SEASON_TEST_POT_ENABLED=true\n',
    'MY_PKW_DEVNET_TEST_PROFILE=x\nDEVNET_SKR_FAUCET_ENABLED=false\n',
    'MY_PKW_DEVNET_TEST_PROFILE: x\nDEVNET_SKR_FAUCET_DEEDLESS_OK_NOTE=x\nLEAGUE_SEASON_TEST_POT_ENABLED_NOTE=true\n',
  ])('accepts an env without the TEST profile: %j', (envFile) => {
    expect(runPreflight(envFile)).toMatchObject({ status: 0, stdout: 'PASSED\n' });
  });

  // docker compose's env_file reader (compose-go dotenv) delivers a variable from
  // more than KEY=value. Each form below was checked with `docker compose config`
  // (v2.29.7, 2026-10-10) to put the named key into the service environment, so a
  // check that only reads KEY=value lines lets a pasted lane line through.
  // [env line(s), key that must be named, value that must never be echoed]
  it.each([
    // KEY=value
    ['PKW_DEVNET_TEST_PROFILE=phase-e-devnet-test\n', 'PKW_DEVNET_TEST_PROFILE', 'phase-e-devnet-test'],
    ['PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID=7Hc8placeholder\n', 'PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID', '7Hc8placeholder'],
    // Any member of the group, even blank: it has no business in a production file.
    ['PKW_DEVNET_TEST_ANYTHING=\n', 'PKW_DEVNET_TEST_ANYTHING', null],
    ['  export PKW_DEVNET_TEST_PROFILE=x1secret\n', 'PKW_DEVNET_TEST_PROFILE', 'x1secret'],
    ['PKW_DEVNET_TEST_PROFILE = spacedsecret\n', 'PKW_DEVNET_TEST_PROFILE', 'spacedsecret'],
    ['PKW_DEVNET_TEST_PROFILE=crlfsecret\r\n', 'PKW_DEVNET_TEST_PROFILE', 'crlfsecret'],
    ['DEVNET_SKR_FAUCET_DEEDLESS_OK=true\n', 'DEVNET_SKR_FAUCET_DEEDLESS_OK', null],
    ['DEVNET_SKR_FAUCET_DEEDLESS_OK=false\n', 'DEVNET_SKR_FAUCET_DEEDLESS_OK', null],
    ['LEAGUE_SEASON_TEST_POT_ENABLED=true\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    ['LEAGUE_SEASON_TEST_POT_ENABLED="true"\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    ["LEAGUE_SEASON_TEST_POT_ENABLED='true'\n", 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    // Anything other than an exact empty/false is a pasted lane line, not a production choice.
    ['LEAGUE_SEASON_TEST_POT_ENABLED=TRUE\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    // compose reads these as "false#x" and "# c", not false / empty.
    ['LEAGUE_SEASON_TEST_POT_ENABLED=false#x\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    ['LEAGUE_SEASON_TEST_POT_ENABLED= # c\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    // KEY: value (YAML-style), with or without the space, exported or not.
    ['PKW_DEVNET_TEST_PROFILE: yamlsecret\n', 'PKW_DEVNET_TEST_PROFILE', 'yamlsecret'],
    ['PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID:7Hc8nospace\n', 'PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID', '7Hc8nospace'],
    ['export PKW_DEVNET_TEST_PROFILE: exportyaml\n', 'PKW_DEVNET_TEST_PROFILE', 'exportyaml'],
    ['DEVNET_SKR_FAUCET_DEEDLESS_OK: true\n', 'DEVNET_SKR_FAUCET_DEEDLESS_OK', null],
    ['LEAGUE_SEASON_TEST_POT_ENABLED: true\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    ['LEAGUE_SEASON_TEST_POT_ENABLED: "true"\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    // Bare KEY: compose passes the deploying shell's value through, which this
    // file cannot show, so the line itself is refused.
    ['PKW_DEVNET_TEST_PROFILE\n', 'PKW_DEVNET_TEST_PROFILE', null],
    ['export PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID\n', 'PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID', null],
    ['DEVNET_SKR_FAUCET_DEEDLESS_OK\n', 'DEVNET_SKR_FAUCET_DEEDLESS_OK', null],
    ['LEAGUE_SEASON_TEST_POT_ENABLED\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    ['  export LEAGUE_SEASON_TEST_POT_ENABLED\n', 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
    // A second assignment after a closing quote on the same line.
    ['API_NOTE="x" PKW_DEVNET_TEST_PROFILE=afterquote\n', 'PKW_DEVNET_TEST_PROFILE', 'afterquote'],
    ["API_NOTE='x' LEAGUE_SEASON_TEST_POT_ENABLED=true\n", 'LEAGUE_SEASON_TEST_POT_ENABLED', null],
  ])('refuses %j and names only the key', (envFile, key, value) => {
    const result = runPreflight(`API_DOMAIN=play.example\n${envFile}`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('FAIL: env carries the devnet TEST profile');
    expect(result.stdout).toContain(`line 2: ${key}\n`);
    expect(result.stdout).not.toContain('PASSED');
    // Values are never echoed (a lane file may carry key paths or ids).
    if (value) expect(result.stdout).not.toContain(value);
  });

  it('refuses an assignment on a "#" line that closes a multi-line quoted value', () => {
    // compose reads NOTE as "abc\n#" and then PKW_DEVNET_TEST_PROFILE=hidden, so a
    // quote-bearing '#' line is not a comment the check may skip.
    const result = runPreflight('NOTE="abc\n#" PKW_DEVNET_TEST_PROFILE=hiddensecret\n');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('line 2: PKW_DEVNET_TEST_PROFILE\n');
    expect(result.stdout).not.toContain('hiddensecret');
  });

  it('lists every offending line at once, in any form, so one edit fixes the file', () => {
    const result = runPreflight('PKW_DEVNET_TEST_PROFILE=a\nOK=1\nLEAGUE_SEASON_TEST_POT_ENABLED=true\nDEVNET_SKR_FAUCET_DEEDLESS_OK=true\n'
      + 'PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID: b\nPKW_DEVNET_TEST_RPC\n');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('line 1: PKW_DEVNET_TEST_PROFILE');
    expect(result.stdout).toContain('line 3: LEAGUE_SEASON_TEST_POT_ENABLED');
    expect(result.stdout).toContain('line 4: DEVNET_SKR_FAUCET_DEEDLESS_OK');
    expect(result.stdout).toContain('line 5: PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID');
    expect(result.stdout).toContain('line 6: PKW_DEVNET_TEST_RPC');
  });

  it('fails closed when the env file cannot be read', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'devnet-test-preflight-'));
    try {
      const block = DEPLOY.slice(at(PREFLIGHT_START), at(PREFLIGHT_END));
      const result = spawnSync('bash', ['-c', `set -euo pipefail
ENV_FILE=missing
die() { echo "FAIL: $*"; exit 1; }
${block}
echo PASSED`], { cwd: directory, encoding: 'utf8' });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain('FAIL: could not read missing');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

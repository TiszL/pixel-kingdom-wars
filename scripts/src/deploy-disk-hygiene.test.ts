/**
 * K-082 — a deploy must neither fill the production disk nor eat its own rollback.
 *
 * Every deploy.sh run leaves a ~2 GB shardkeep-api:<sha> image and its BuildKit
 * cache. 37 images + 34.6 GB of cache filled the 75 GB root disk on 2026-09-18
 * and the deploy died at the proof-of-reserves preflight with ENOSPC. Postgres
 * and Redis share that disk and keep player balances in Docker VOLUMES, so both
 * directions are dangerous: no cleanup ends in a full disk under the database,
 * and a careless cleanup deletes the data or the image a rollback needs.
 *
 * These tests run the real shell from infra/deploy.sh against a stub `docker`
 * and `df`, and read the script as text to pin WHERE the cleanup may run.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEPLOY = readFileSync(path.join(ROOT, 'infra/deploy.sh'), 'utf8');

function at(marker: string, from = 0): number {
  const index = DEPLOY.indexOf(marker, from);
  expect(index, `infra/deploy.sh must contain ${JSON.stringify(marker)}`).toBeGreaterThan(-1);
  return index;
}

const BLOCK = DEPLOY.slice(at('# --- disk hygiene (K-082)'), at('# --- end disk hygiene'));
const PREFLIGHT_CALL = DEPLOY.slice(
  at('# --- pre-flight: room for one build (K-082)'),
  at('# --- web dist, built ON this box'),
);
const HOUSEKEEPING_CALL = DEPLOY.slice(at('# --- post-deploy housekeeping (K-082)'));

const id = (char: string) => `sha256:${char.repeat(64)}`;
const LIVE = id('a');
const IN_USE_OLD = id('f');
const GIB_KB = 1024 * 1024;

/**
 * Build order deliberately disagrees with alphabetical tag order, and the rows
 * are shuffled: a git sha sorts randomly, so any name-based "keep the last N"
 * would discard a recent release and keep an ancient one.
 */
const IMAGES: Array<[created: string, image: string, tags: string]> = [
  ['2026-09-16T09:00:00.100000000Z', id('e'), 'shardkeep-api:2222cccc'],
  ['2026-09-18T16:40:11.123456789Z', LIVE, 'shardkeep-api:0a11aaaa,shardkeep-api:latest'],
  ['2026-09-04T09:00:00.100000000Z', id('9'), 'shardkeep-api:3333dddd,shardkeep-api:3333dddd9'],
  ['2026-09-18T11:30:00Z', id('c'), 'shardkeep-api:1111bbbb'],
  ['2026-09-10T09:00:00.100000000Z', IN_USE_OLD, 'shardkeep-api:dddd0003'],
  ['2026-09-18T14:02:00.500000000Z', id('b'), 'shardkeep-api:ffff0001'],
  ['2026-09-01T09:00:00.100000000Z', id('8'), 'shardkeep-api:local'],
  ['2026-09-17T09:00:00.100000000Z', id('d'), 'shardkeep-api:eeee0002'],
  ['2026-08-01T09:00:00.100000000Z', id('7'), 'shardkeep-native-content:1234abcd'],
];
// Exactly what `docker image inspect` prints for deploy.sh's template: tags end in a comma.
const listing = (rows = IMAGES) => rows.map(([created, image, tags]) => `${created}\t${image}\t${tags},`).join('\n') + '\n';

const STUBS = `
set -euo pipefail
say() { printf '> %s\\n' "$*"; }
die() { printf 'DIE: %s\\n' "$*" >&2; exit 1; }
ROOT=/srv/shardkeep
COMPOSE="docker compose --env-file infra/.env.prod -f infra/docker-compose.prod.yml"
df() {
  [ "\${DF_BROKEN:-0}" = 1 ] && return 1
  printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
  printf '/dev/sda1 78000000 1 %s %s%% /\\n' "$DF_FREE_KB" "$DF_USED_PCT"
}
docker() {
  printf '%s\\n' "$*" >> "$CALL_LOG"
  [ "\${DOCKER_BROKEN:-0}" = 1 ] && return 1
  case "$*" in
    info*) echo /nonexistent/docker-root ;;
    compose*' ps -q api') printf '%s\\n' "\${LIVE_CONTAINER:-}" ;;
    'ps --all --quiet --no-trunc') awk '{ print $1 }' "$CONTAINER_MAP" ;;
    'container inspect'*)
      shift 4
      for container in "$@"; do
        awk -v c="$container" '$1 == c { print $2 }' "$CONTAINER_MAP"
      done ;;
    'image ls --quiet --no-trunc shardkeep-api') awk -F '\\t' '{ print $2 }' "$LISTING" ;;
    'image inspect'*) cat "$LISTING" ;;
    'image rm '*) return "\${RM_EXIT:-0}" ;;
    'builder prune'*) printf 'ID\\tRECLAIMABLE\\nTotal reclaimed space: 3.1GB\\n' ;;
    *) printf 'unexpected docker call: %s\\n' "$*" >&2; return 97 ;;
  esac
}
`;

interface Scenario {
  script: string;
  env?: Record<string, string>;
  rows?: typeof IMAGES;
  containers?: Array<[container: string, image: string]>;
}

function run({ script, env = {}, rows = IMAGES, containers }: Scenario) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'deploy-disk-hygiene-'));
  const callLog = path.join(directory, 'docker-calls.log');
  const listingFile = path.join(directory, 'images.tsv');
  const containerMap = path.join(directory, 'containers.txt');
  writeFileSync(listingFile, listing(rows));
  writeFileSync(
    containerMap,
    (containers ?? [['c-api', LIVE], ['c-worker', LIVE], ['c-stopped-old', IN_USE_OLD], ['c-postgres', id('1')]])
      .map((row) => row.join(' ')).join('\n') + '\n',
  );
  try {
    const result = spawnSync('bash', ['-c', `${STUBS}\n${script}`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CALL_LOG: callLog,
        LISTING: listingFile,
        CONTAINER_MAP: containerMap,
        LIVE_CONTAINER: 'c-api',
        DF_FREE_KB: String(28 * GIB_KB),
        DF_USED_PCT: '62',
        ...env,
      },
    });
    const calls = existsSync(callLog) ? readFileSync(callLog, 'utf8').split('\n').filter(Boolean) : [];
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const select = (live: string, inUse: string[], rows = IMAGES, previous = '') => {
  const result = run({
    rows,
    script: `${BLOCK}\nselect_release_tags_to_remove "$KEEP_RELEASE_IMAGES" '${live}' '${inUse.join(' ')}' '${previous}' < "$LISTING"`,
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.split('\n').filter(Boolean).sort();
};

const removals = (calls: string[]) => calls.filter((call) => call.startsWith('image rm ')).sort();

describe('deploy.sh disk hygiene (K-082)', () => {
  it('keeps the live release plus the three newest others, by build time and not by name', () => {
    // WHY: DEPLOYMENT.md's rollback is `API_IMAGE=shardkeep-api:<previous-sha>`.
    // It is only "immediate" while that tag still exists, so the window the
    // owner chose (live + three before it) is a recovery guarantee, not tidying.
    expect(BLOCK).toMatch(/^KEEP_RELEASE_IMAGES=4$/m);
    expect(select(LIVE, [LIVE])).toEqual([
      'shardkeep-api:2222cccc',
      'shardkeep-api:3333dddd',
      'shardkeep-api:3333dddd9',
      'shardkeep-api:dddd0003',
    ]);
  });

  it('never selects an image that any container, running or stopped, still uses', () => {
    // WHY: an untag succeeds silently when the image has a second tag, so
    // Docker's own in-use refusal is not enough to protect a pinned container.
    const doomed = select(LIVE, [LIVE, IN_USE_OLD, id('1')]);
    expect(doomed).not.toContain('shardkeep-api:dddd0003');
    expect(doomed).toEqual(['shardkeep-api:2222cccc', 'shardkeep-api:3333dddd', 'shardkeep-api:3333dddd9']);
  });

  it('keeps the live image even when it is the OLDEST build on the box', () => {
    // WHY: redeploying an earlier commit can serve from an image older than
    // every other tag. "Newest N" alone would delete the release taking traffic.
    const doomed = select(id('9'), [id('9')]);
    expect(doomed).not.toContain('shardkeep-api:3333dddd');
    expect(doomed).not.toContain('shardkeep-api:3333dddd9');
    expect(doomed).toEqual(['shardkeep-api:2222cccc', 'shardkeep-api:dddd0003', 'shardkeep-api:eeee0002']);
  });

  describe('an incident day: three candidates built, failed a later gate, and never served', () => {
    // Release P is live. Three fix-forward commits each pass `docker build` and
    // die at a later gate (signer identity, PoR, traffic-return proof ...); the
    // fourth attempt goes live. `compose up` recreated api/worker/signer, so no
    // container names P any more and the in-use guard cannot save it.
    const PREVIOUS = id('5');
    const INCIDENT: typeof IMAGES = [
      ['2026-09-17T09:00:00.100000000Z', PREVIOUS, 'shardkeep-api:11111111'],
      ['2026-09-18T09:00:00.100000000Z', id('2'), 'shardkeep-api:f1f1f1f1'],
      ['2026-09-18T10:00:00.100000000Z', id('3'), 'shardkeep-api:f2f2f2f2'],
      ['2026-09-18T11:00:00.100000000Z', id('4'), 'shardkeep-api:f3f3f3f3'],
      ['2026-09-18T12:00:00.100000000Z', LIVE, 'shardkeep-api:0a11aaaa,shardkeep-api:latest'],
    ];

    it('keeps the release this deploy replaced, however many newer builds exist', () => {
      // WHY: P is the only image on the box PROVEN to serve production, and this
      // is the day a rollback is most likely. Losing it turns DEPLOYMENT.md's
      // "immediate" rollback into "no such image" plus an ~18 min rebuild. The
      // window stays four, so the slot comes from the oldest never-served build.
      expect(select(LIVE, [LIVE], INCIDENT, PREVIOUS)).toEqual(['shardkeep-api:f1f1f1f1']);
      // A replaced release that is already inside the window costs nothing extra.
      expect(select(LIVE, [LIVE], IMAGES, id('b'))).toEqual(select(LIVE, [LIVE]));
      // Redeploying the same image: live and replaced coincide, no slot is lost.
      expect(select(LIVE, [LIVE], INCIDENT, LIVE)).toEqual(['shardkeep-api:11111111']);
    });

    it('housekeeping hands the selector the replaced release, captured before the build', () => {
      const result = run({
        rows: INCIDENT,
        containers: [['c-api', LIVE], ['c-worker', LIVE]],
        script: `OLD_RELEASE_IMAGE_ID='${PREVIOUS}'\n${BLOCK}\n${HOUSEKEEPING_CALL}`,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(removals(result.calls)).toEqual(['image rm shardkeep-api:f1f1f1f1']);
      // WHY an id and WHY before the build: `docker build` re-points
      // shardkeep-api:latest, and compose recreates the old container, so
      // afterwards neither a tag nor the container can name the old release.
      const capture = at(`OLD_RELEASE_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$OLD_API_CONTAINER"`);
      expect(capture).toBeLessThan(at('docker build \\'));
      expect(capture).toBeLessThan(at('$COMPOSE stop api'));
    });

    it('a first boot or an unreadable replaced release changes nothing about retention', () => {
      for (const previous of ['', 'shardkeep-api:latest']) {
        const result = run({
          rows: INCIDENT,
          containers: [['c-api', LIVE]],
          script: `OLD_RELEASE_IMAGE_ID='${previous}'\n${BLOCK}\n${HOUSEKEEPING_CALL}`,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(removals(result.calls)).toEqual(['image rm shardkeep-api:11111111']);
      }
    });
  });

  it('only ever names shardkeep-api:<git sha> tags', () => {
    // WHY: the box also hosts other compose projects. :latest, :local and
    // foreign repositories must be invisible to the release retention rule,
    // and must not consume a rollback slot either.
    for (const live of [LIVE, id('9')]) {
      for (const tag of select(live, [])) expect(tag).toMatch(/^shardkeep-api:[0-9a-f]{7,40}$/);
    }
    expect(BLOCK).toContain('RELEASE_REPOSITORY="shardkeep-api"');
    expect(DEPLOY).toContain('RELEASE_IMAGE="shardkeep-api:$SHORT"');
  });

  it('removes nothing while the box holds no more than the rollback window', () => {
    expect(select(LIVE, [LIVE], IMAGES.filter(([, image]) => [LIVE, id('b'), id('c'), id('d'), id('8')].includes(image))))
      .toEqual([]);
  });

  it('removes by tag, unforced, and trims only aged build cache after a verified deploy', () => {
    const result = run({ script: `${BLOCK}\n${HOUSEKEEPING_CALL}` });
    expect(result.status, result.stderr).toBe(0);
    expect(removals(result.calls)).toEqual([
      'image rm shardkeep-api:2222cccc',
      'image rm shardkeep-api:3333dddd',
      'image rm shardkeep-api:3333dddd9',
    ]);
    // WHY: an age bound keeps every layer this release's build just reused, so
    // the next build stays warm; -a / unbounded pruning would make it cold.
    expect(result.calls.filter((call) => call.startsWith('builder prune'))).toEqual([
      'builder prune --force --filter until=24h',
    ]);
    // WHY: verified against Docker 27.3 — `{{join .RepoTags ","}}` aborts with
    // "wrong type for value", which would silently disable retention forever.
    expect(BLOCK).toContain('{{range .RepoTags}}{{.}},{{end}}');
    expect(BLOCK).not.toMatch(/\{\{\s*join\s+\.RepoTags/);
    expect(result.stdout).toContain('Total reclaimed space: 3.1GB');
    expect(result.stdout).toContain('disk after deploy: 62 % used, 28 GB free');
    expect(result.stdout).not.toContain('WARNING');
  });

  it('can never touch volumes, containers, or other projects (script-wide)', () => {
    // WHY: Postgres and Redis hold player balances in named volumes. One
    // convenient catch-all prune in this script is an unrecoverable data loss.
    // The one permitted mention of an unbounded cache prune is the operator
    // remedy printed by the early abort: text inside die, never executed.
    const REMEDY = 'docker builder prune -af';
    expect(DEPLOY.split(REMEDY).length - 1).toBe(1);
    const executable = DEPLOY.split('\n').filter((line) => !line.includes(REMEDY)).join('\n');
    for (const forbidden of [
      /system\s+prune/, /--volumes/, /\bvolume\s+(rm|prune)\b/, /\bimage\s+prune\b/,
      /\bdocker\s+rmi\b/, /\bcontainer\s+(rm|prune)\b/, /\bimage\s+rm\b[^\n]*(\s-f\b|--force)/,
      /\bdown\b[^\n]*\s(-v|--volumes)\b/, /builder\s+prune[^\n]*\s(-a|--all|-af|-fa)\b/,
    ]) expect(executable).not.toMatch(forbidden);
    expect(at('docker builder prune -af')).toBeGreaterThan(at('disk_space_preflight() {'));
    expect(at('docker builder prune -af')).toBeLessThan(at('select_release_tags_to_remove() {'));
    const executed = run({ script: `${BLOCK}\n${HOUSEKEEPING_CALL}` }).calls;
    for (const call of executed) expect(call).not.toMatch(/system|volume|\brmi\b|container (rm|prune)|image prune/);
    // Destructive docker verbs live in the hygiene block and nowhere else.
    const elsewhere = DEPLOY.replace(BLOCK, '');
    expect(elsewhere).not.toMatch(/image\s+rm|builder\s+prune/);
  });

  it('runs housekeeping exactly once, after the public release proof and the success banner', () => {
    // WHY: a failed or staged (KEEP_MAINTENANCE=1) run must leave every image in
    // place — the previous release is what the operator rolls back to.
    expect(DEPLOY.split('( post_deploy_housekeeping )').length - 1).toBe(1);
    expect(DEPLOY.match(/^\s*(prune_old_release_images|prune_build_cache)\b(?!\(\))/gm)?.length).toBe(2);
    const housekeeping = at('( post_deploy_housekeeping )');
    const stagedExit = at('exit 0', at('if [ "$KEEP_MAINTENANCE" = 1 ]; then'));
    for (const earlier of [
      stagedExit,
      at('|| ! traffic_returned_proven; then'),
      at('$COMPOSE exec -T caddy rm -f /config/shardkeep-maintenance'),
      at("deployed v%s (%s), sim v%s"),
    ]) expect(earlier).toBeLessThan(housekeeping);
    expect(DEPLOY.slice(housekeeping)).not.toMatch(/\bdie\s+["']/);
    // Nothing that runs after success may abort: no die below the preflight.
    expect(BLOCK.slice(BLOCK.indexOf('select_release_tags_to_remove() {'))).not.toMatch(/\bdie\s+["']/);
  });

  it.each<[string, Record<string, string>]>([
    ['docker failing every call', { DOCKER_BROKEN: '1' }],
    ['disk usage being unmeasurable', { DF_BROKEN: '1' }],
    ['every image removal being refused', { RM_EXIT: '1' }],
    ['no live api container being found', { LIVE_CONTAINER: '' }],
  ])('never fails a deploy that already succeeded, despite %s', (_label, env) => {
    // WHY: deploy.sh's exit code is the operator's release verdict. Traffic is
    // already back on the new release here; a non-zero exit would invite a
    // needless rerun or rollback of a healthy production.
    const result = run({ env, script: `${BLOCK}\n${HOUSEKEEPING_CALL}\nprintf 'script ended normally\\n'` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('script ended normally');
    expect(result.stdout).toContain('The deploy itself SUCCEEDED');
    if (env.LIVE_CONTAINER === '' || env.DOCKER_BROKEN) expect(removals(result.calls)).toEqual([]);
  });

  it('removes nothing when the running api is not one of the listed release images', () => {
    // WHY: retention reasons about "live + three others". If the live image
    // cannot be placed in that list the premise is wrong, and the only safe
    // action on a production box is none.
    const result = run({
      containers: [['c-api', id('0')]],
      script: `${BLOCK}\n${HOUSEKEEPING_CALL}\nprintf 'script ended normally\\n'`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('the live image is not a listed shardkeep-api image');
    expect(removals(result.calls)).toEqual([]);
    expect(result.stdout).toContain('script ended normally');
  });

  it('survives an unset variable inside housekeeping under set -u', () => {
    const result = run({
      script: `${BLOCK}\nreport_disk_usage() { printf '%s' "$NEVER_DEFINED"; }\n${HOUSEKEEPING_CALL}\nprintf 'script ended normally\\n'`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('script ended normally');
  });

  it('DEPLOY_SKIP_PRUNE=1 removes nothing but still reports the disk', () => {
    const result = run({ env: { DEPLOY_SKIP_PRUNE: '1', DF_USED_PCT: '62' }, script: `${BLOCK}\n${HOUSEKEEPING_CALL}` });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls.filter((call) => /image rm|builder prune/.test(call))).toEqual([]);
    expect(result.stdout).toContain('disk after deploy: 62 % used');
    // Documented where an operator looks first, and validated like KEEP_MAINTENANCE.
    expect(DEPLOY.slice(0, at('set -euo pipefail'))).toContain('DEPLOY_SKIP_PRUNE=1 ./infra/deploy.sh');
    const invalid = run({ env: { DEPLOY_SKIP_PRUNE: 'yes' }, script: BLOCK });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain('DEPLOY_SKIP_PRUNE must be 0 or 1');
  });

  it('warns loudly above 80 % without failing the deploy', () => {
    expect(BLOCK).toMatch(/^DISK_WARN_PERCENT=80$/m);
    const warned = run({ env: { DF_USED_PCT: '81' }, script: `${BLOCK}\n${HOUSEKEEPING_CALL}` });
    expect(warned.status, warned.stderr).toBe(0);
    expect(warned.stdout).toContain('WARNING — DISK IS 81 % FULL');
    const quiet = run({ env: { DF_USED_PCT: '80' }, script: `${BLOCK}\n${HOUSEKEEPING_CALL}` });
    expect(quiet.stdout).not.toContain('WARNING');
  });

  it('refuses to build on a short disk, before anything is installed, built or drained', () => {
    // WHY: the 2026-09-18 deploy found ENOSPC only at the proof-of-reserves
    // preflight. The same condition during the backup or a migration would hit
    // Postgres on a full disk. 8 GB = one measured deploy (~3 GB) with >2x margin.
    expect(BLOCK).toMatch(/^MIN_FREE_GB_BEFORE_BUILD=8$/m);
    const preflight = at('\ndisk_space_preflight\n');
    for (const later of [
      'pnpm install --frozen-lockfile', 'pnpm assets', 'docker build \\',
      'say "entering maintenance', '$COMPOSE stop api', 'say "running migrations"',
    ]) expect(at(later)).toBeGreaterThan(preflight);

    const script = `${BLOCK}\n${PREFLIGHT_CALL}\nprintf 'later deployment steps reached\\n'`;
    const short = run({ env: { DF_FREE_KB: String(8 * GIB_KB - 1), DF_USED_PCT: '90' }, script });
    expect(short.status).toBe(1);
    expect(short.stdout).not.toContain('later deployment steps reached');
    expect(short.stderr).toContain('only 7 GB free');
    expect(short.stderr).toContain('Nothing was built, drained or migrated');
    expect(short.stderr).toContain('docker builder prune -af');
    expect(short.stderr).toContain('docker image rm shardkeep-api:<old-sha>');
    expect(removals(short.calls)).toEqual([]);

    const enough = run({ env: { DF_FREE_KB: String(8 * GIB_KB) }, script });
    expect(enough.status, enough.stderr).toBe(0);
    expect(enough.stdout).toContain('later deployment steps reached');

    // Unknown free space is not "enough": stop while stopping is still free.
    const blind = run({ env: { DF_BROKEN: '1' }, script });
    expect(blind.status).toBe(1);
    expect(blind.stderr).toContain('could not measure free disk space');
    expect(blind.stdout).not.toContain('later deployment steps reached');
  });
});

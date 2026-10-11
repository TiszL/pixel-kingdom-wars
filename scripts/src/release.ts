/**
 * `pnpm release` — cut a version, write the changelog, tag the commit.
 *
 *   pnpm release            # work out the bump from the commits, do it
 *   pnpm release --dry-run  # print what it would do and change nothing
 *   pnpm release --as 1.2.0 # override the computed version
 *
 * What it refuses to do is the point. A release that is not reproducible from a
 * tag is not a release — during the devnet launch the only reliable question is
 * "what exactly is running", and the answer has to be a sha. So:
 *
 *   - dirty tree            → stop. The tag would not describe the build.
 *   - no commits since tag  → stop. Nothing to release.
 *   - failing tests         → stop, unless --skip-tests, which prints a warning
 *                             loud enough to be embarrassing.
 *
 * It does NOT push. Cutting a release and publishing it are different decisions
 * and the second one should take a deliberate `git push --follow-tags`.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyBump, bumpFor, insertRelease, parseCommit, renderRelease } from './changelog';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const git = (...args: string[]): string =>
  // stderr piped, not inherited: `git describe` with no tags yet writes a scary
  // "fatal: No names found" that is a normal, expected state on a first release.
  // The throw is the signal; the noise is not.
  execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const valueOf = (f: string): string | undefined => {
  const i = argv.indexOf(f);
  return i === -1 ? undefined : argv[i + 1];
};

const dryRun = has('--dry-run');

function die(msg: string): never {
  console.error(`\n  release: ${msg}\n`);
  process.exit(1);
}

// --- preflight -------------------------------------------------------------

if (!dryRun && git('status', '--porcelain') !== '') {
  die('working tree is dirty. A tag must describe exactly what was built —\n' +
      '  commit or stash first, then release.');
}

const pkgPath = join(ROOT, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
const current = pkg.version;

// Last tag, or the root commit if this is the first release ever.
let range: string;
let lastTag: string | null = null;
try {
  lastTag = git('describe', '--tags', '--abbrev=0');
  range = `${lastTag}..HEAD`;
} catch {
  range = git('rev-list', '--max-parents=0', 'HEAD');
  range = `${range}..HEAD`;
}

const rawLog = git('log', range, '--no-merges', '--format=%H%x00%s%x00%b%x1e');
const commits = rawLog
  .split('\x1e')
  .map((s) => s.trim())
  .filter((s) => s !== '')
  .map(parseCommit);

if (commits.length === 0) die(`no commits since ${lastTag ?? 'the beginning'} — nothing to release.`);

const next = valueOf('--as') ?? applyBump(current, bumpFor(commits, current));

// --- did the replay protocol move? -----------------------------------------
// Read SIM_VERSION out of the source rather than importing it: this script must
// stay runnable without building the sim package, and a regex over a `export
// const SIM_VERSION = N` line is not the kind of thing that rots.
const simSrc = readFileSync(join(ROOT, 'packages/sim/src/version.ts'), 'utf8');
const simVersion = Number(/export const SIM_VERSION = (\d+)/.exec(simSrc)?.[1] ?? '0');
let simVersionChanged = false;
if (lastTag) {
  try {
    const prevSrc = git('show', `${lastTag}:packages/sim/src/version.ts`);
    const prev = Number(/export const SIM_VERSION = (\d+)/.exec(prevSrc)?.[1] ?? '0');
    simVersionChanged = prev !== simVersion;
  } catch {
    // The file did not exist at that tag — this is the release that introduced
    // versioning, so the protocol is new by definition.
    simVersionChanged = true;
  }
}

// --- tests -----------------------------------------------------------------

if (has('--skip-tests')) {
  console.warn('\n  ⚠ RELEASING WITHOUT RUNNING TESTS (--skip-tests)\n');
} else if (!dryRun) {
  console.log('  running the suite…');
  try {
    execFileSync('pnpm', ['-r', 'test'], { cwd: ROOT, stdio: 'inherit' });
  } catch {
    die('tests failed. Fix them, or use --skip-tests and explain yourself in the tag.');
  }
}

// --- write -----------------------------------------------------------------

const date = new Date().toISOString().slice(0, 10);
const rendered = renderRelease(next, date, commits, { simVersion, simVersionChanged });

if (dryRun) {
  console.log(`\n  ${current} → ${next}   (${commits.length} commits since ${lastTag ?? 'the beginning'})\n`);
  console.log(rendered);
  console.log('  --dry-run: nothing written.\n');
  process.exit(0);
}

const clPath = join(ROOT, 'CHANGELOG.md');
writeFileSync(clPath, insertRelease(readFileSync(clPath, 'utf8'), rendered));

pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

git('add', 'CHANGELOG.md', 'package.json');
git('commit', '-m', `chore(release): v${next}`);
git('tag', '-a', `v${next}`, '-m', `v${next}\n\n${rendered}`);

console.log(`\n  released v${next}${simVersionChanged ? `  (replay protocol → sim v${simVersion})` : ''}`);
console.log('  push it when you mean it:  git push --follow-tags\n');

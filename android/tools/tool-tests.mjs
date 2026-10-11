// The Node tool-test gate: the native CI step and the local "Node tool tests" gate step.
//
//   node tools/tool-tests.mjs    runs every tools/*.test.mjs as `node --test tools/*.test.mjs` does (one process per
//                                file, the CLI's default concurrency), then compares the failures with
//                                tools/tool-tests.expected.json
//
// Why it exists: seven battle-reference tests inherited from the realm-kit r5 line fail at the globe port's fork point
// (their references pin source b271e033; the pack lock moved to 65b7f936). A plain `node --test` step is red on those
// seven alone, so CI never reached the gradle gate, and a NEW tool-test failure could not be told apart from them.
// Every test still runs and every listed failure is printed by name on every run. The gate is red when
//   - a test fails that is not listed (a new failure),
//   - a listed test passes (the list is stale: delete the entry so the fixed test guards again),
//   - a listed test did not run at all (renamed or deleted: the count must not drop silently),
//   - a test is skipped or marked todo (never skip a test to pass),
//   - a test file reports no test at all (a file that runs nothing proves nothing; node:test also refuses to run
//     files when run() is called from inside a test process, and that must not read as green).
// The list only records which red is already known and who owns it. It never makes a test pass.
import fs from 'node:fs';
import path from 'node:path';
import { run } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EXPECTED_FILE = 'tools/tool-tests.expected.json';

/** The same files, in the same order, as the shell glob `tools/*.test.mjs`. */
export function testFiles(root = ROOT) {
  return fs.readdirSync(path.join(root, 'tools')).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(root, 'tools', f));
}

/** A file's repo-relative path. Both sides are resolved first: test processes report real paths (macOS /var → /private/var). */
export function relFile(root, file) {
  const real = p => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return path.relative(real(root), real(file)).split(path.sep).join('/');
}

/** A test's identity: its repo-relative file and name. A file that fails to load reports under the name `<file>`. */
export function testKey(root, file, name) {
  return `${relFile(root, file)} :: ${name === file ? '<file>' : name}`;
}

/** Reads and validates the list: every entry needs a unique `test` key, an `owner` and a `reason`. */
export function readExpected(root = ROOT) {
  const doc = JSON.parse(fs.readFileSync(path.join(root, EXPECTED_FILE), 'utf8'));
  if (!Array.isArray(doc.failures)) throw new Error(`${EXPECTED_FILE}: "failures" must be an array`);
  const seen = new Set();
  for (const e of doc.failures) {
    for (const field of ['test', 'owner', 'reason']) if (typeof e[field] !== 'string' || !e[field].trim()) throw new Error(`${EXPECTED_FILE}: an entry has no ${field}: ${JSON.stringify(e)}`);
    if (!/^tools\/[^/]+\.test\.mjs :: .+/.test(e.test)) throw new Error(`${EXPECTED_FILE}: "${e.test}" is not "tools/<file>.test.mjs :: <test name>"`);
    if (seen.has(e.test)) throw new Error(`${EXPECTED_FILE}: "${e.test}" is listed twice`);
    seen.add(e.test);
  }
  return doc.failures;
}

/**
 * Compares run results ({ key, status: 'pass' | 'fail' | 'skip' | 'todo', message? }) with the expected failures.
 * `files` are the repo-relative test files that were run. `ok` is true only when every failure is listed, every listed
 * test ran and failed, nothing was skipped and every file reported at least one test.
 */
export function classify(results, expected, files = []) {
  const listed = new Map(expected.map(e => [e.test, e]));
  const counts = { tests: results.length, pass: 0, fail: 0, skip: 0, todo: 0 };
  const unexpected = [], known = [], skipped = [], statuses = new Map();
  for (const r of results) {
    counts[r.status]++;
    if (!statuses.has(r.key)) statuses.set(r.key, new Set());
    statuses.get(r.key).add(r.status);
    if (r.status === 'fail') (listed.has(r.key) ? known : unexpected).push(r);
    else if (r.status !== 'pass') skipped.push(r);
  }
  const missing = [], stale = [];
  for (const e of expected) {
    const seen = statuses.get(e.test);
    if (!seen) missing.push(e);
    else if (!seen.has('fail')) stale.push(e);
  }
  const silent = files.filter(f => !results.some(r => r.key.startsWith(`${f} :: `)));
  const ok = !unexpected.length && !skipped.length && !missing.length && !stale.length && !silent.length;
  return { ok, counts, unexpected, known, skipped, missing, stale, silent };
}

/** Runs the files with node:test's runner and returns one result per finished test (subtests included). */
export async function runTests(files, root = ROOT) {
  const results = [];
  for await (const event of run({ files, concurrency: true })) {
    const d = event.data;
    if (event.type === 'test:pass') results.push({ key: testKey(root, d.file, d.name), status: d.skip !== undefined ? 'skip' : d.todo !== undefined ? 'todo' : 'pass' });
    else if (event.type === 'test:fail') {
      const error = d.details?.error, cause = error?.cause ?? error;
      results.push({ key: testKey(root, d.file, d.name), status: 'fail', message: String(cause?.message ?? cause ?? error?.failureType ?? 'failed') });
    }
  }
  return results;
}

export function report(verdict) {
  const { counts, unexpected, known, skipped, missing, stale, silent } = verdict, lines = [];
  lines.push(`tool tests: ${counts.tests} tests, ${counts.pass} pass, ${counts.fail} fail (${known.length} known, ${unexpected.length} new), ${counts.skip} skipped, ${counts.todo} todo`);
  for (const r of known) lines.push(`  known failure (${EXPECTED_FILE}): ${r.key}`);
  for (const r of unexpected) lines.push(`  NEW FAILURE: ${r.key}\n    ${String(r.message).split('\n').slice(0, 12).join('\n    ')}`);
  for (const r of skipped) lines.push(`  ${r.status.toUpperCase()}: ${r.key} (never skip a test to pass)`);
  for (const e of stale) lines.push(`  STALE: ${e.test} passes now; delete its entry from ${EXPECTED_FILE}`);
  for (const e of missing) lines.push(`  MISSING: ${e.test} did not run (renamed or deleted?); a listed test must still run`);
  for (const f of silent) lines.push(`  NO TESTS: ${f} reported no test`);
  lines.push(verdict.ok ? 'tool tests: gate passed' : 'tool tests: gate FAILED');
  return lines.join('\n');
}

async function main() {
  const expected = readExpected(ROOT), files = testFiles(ROOT);
  const rel = files.map(f => relFile(ROOT, f));
  const verdict = classify(await runTests(files, ROOT), expected, rel);
  console.log(report(verdict));
  return verdict.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();

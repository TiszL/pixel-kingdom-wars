import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EXPECTED_FILE, classify, readExpected, runTests, testFiles, testKey } from './tool-tests.mjs';

// Why: the native CI's Node step used to be a plain `node --test`, red on seven inherited reference failures, so CI never
// reached the gradle gate and a new failure hid among the known seven. The gate replaces it. If it ever let a new failure,
// a skipped test, a silently deleted listed test or a stale entry through, the list would turn into a way to hide red.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = (test) => ({ test, owner: 'r5 battle presentation', reason: 'reference pins b271e033' });
const KNOWN = 'tools/a.test.mjs :: known drift';

test('only listed failures keep the gate green, and they are still reported by name', () => {
  const v = classify([{ key: KNOWN, status: 'fail' }, { key: 'tools/a.test.mjs :: fine', status: 'pass' }], [entry(KNOWN)]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.known.map(r => r.key), [KNOWN]);
  assert.deepEqual(v.counts, { tests: 2, pass: 1, fail: 1, skip: 0, todo: 0 });
});

test('a new failure turns the gate red even when every known failure is present', () => {
  const v = classify([{ key: KNOWN, status: 'fail' }, { key: 'tools/b.test.mjs :: new', status: 'fail' }], [entry(KNOWN)]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.unexpected.map(r => r.key), ['tools/b.test.mjs :: new']);
});

test('a listed test that passes turns the gate red, so the fixed test guards again once its entry is deleted', () => {
  const v = classify([{ key: KNOWN, status: 'pass' }], [entry(KNOWN)]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.stale.map(e => e.test), [KNOWN]);
});

test('a listed test that did not run turns the gate red, so the count cannot drop by deleting it', () => {
  const v = classify([{ key: 'tools/a.test.mjs :: fine', status: 'pass' }], [entry(KNOWN)]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing.map(e => e.test), [KNOWN]);
});

test('a skipped or todo test turns the gate red: skipping is never a way to pass', () => {
  for (const status of ['skip', 'todo']) {
    const v = classify([{ key: 'tools/a.test.mjs :: fine', status }], []);
    assert.equal(v.ok, false, status);
    assert.equal(v.skipped.length, 1, status);
  }
});

test('a test file that reports nothing turns the gate red', () => {
  const v = classify([{ key: 'tools/a.test.mjs :: fine', status: 'pass' }], [], ['tools/a.test.mjs', 'tools/b.test.mjs']);
  assert.equal(v.ok, false);
  assert.deepEqual(v.silent, ['tools/b.test.mjs']);
});

test('run() inside a test process runs no file, and the gate calls that red, not green', async () => {
  // node:test refuses a recursive run() and yields no results; an empty expected list must not turn that into a pass.
  const results = await runTests([fileURLToPath(import.meta.url)], ROOT);
  assert.deepEqual(results, []);
  assert.equal(classify(results, [], ['tools/tool-tests.test.mjs']).ok, false);
});

/**
 * Runs runTests in a fresh top-level process, as CI does (a nested run() would be refused, see above). The driver is a
 * file, not `-e`: run() hands its own execArgv to every test process, and `-e <code>` there would replace the test file.
 */
function runTopLevel(root) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const driver = path.join(root, 'driver.mjs'), gate = pathToFileURL(path.join(ROOT, 'tools/tool-tests.mjs')).href;
  fs.writeFileSync(driver, `import { runTests, testFiles } from ${JSON.stringify(gate)};
    const root = ${JSON.stringify(root)};
    process.stdout.write(JSON.stringify(await runTests(testFiles(root), root)));\n`);
  return JSON.parse(execFileSync(process.execPath, [driver], { env, encoding: 'utf8' }));
}

test('the real runner maps pass, fail, skip and a file that cannot load onto the right keys', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-tests-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    fs.writeFileSync(path.join(root, 'tools/a.test.mjs'), [
      "import test from 'node:test';",
      "test('fine', () => {});",
      "test('known drift', () => { throw new Error('reference drift'); });",
      "test('skipped', { skip: 'why' }, () => {});",
    ].join('\n'));
    fs.writeFileSync(path.join(root, 'tools/b.test.mjs'), "throw new Error('cannot load');\n");
    fs.writeFileSync(path.join(root, 'tools/helper.mjs'), "throw new Error('not a test file');\n");
    const files = testFiles(root);
    assert.deepEqual(files.map(f => path.basename(f)), ['a.test.mjs', 'b.test.mjs']);
    const results = runTopLevel(root);
    const status = Object.fromEntries(results.map(r => [r.key, r.status]));
    assert.deepEqual(status, {
      'tools/a.test.mjs :: fine': 'pass',
      [KNOWN]: 'fail',
      'tools/a.test.mjs :: skipped': 'skip',
      'tools/b.test.mjs :: <file>': 'fail',
    });
    assert.match(results.find(r => r.key === KNOWN).message, /reference drift/);
    const v = classify(results, [entry(KNOWN)], ['tools/a.test.mjs', 'tools/b.test.mjs']);
    assert.equal(v.ok, false);
    assert.deepEqual(v.unexpected.map(r => r.key), ['tools/b.test.mjs :: <file>']);
    assert.deepEqual(v.silent, []);
    assert.deepEqual(v.skipped.map(r => r.key), ['tools/a.test.mjs :: skipped']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the committed list names real tests, each with an owner and a reason, and none of the gate\'s own', () => {
  const expected = readExpected(ROOT);
  for (const e of expected) {
    const [file, name] = e.test.split(' :: ');
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${EXPECTED_FILE}: ${file} does not exist`);
    assert.ok(fs.readFileSync(path.join(ROOT, file), 'utf8').includes(name), `${EXPECTED_FILE}: no test named "${name}" in ${file}`);
    assert.notEqual(file, 'tools/tool-tests.test.mjs');
  }
  assert.equal(testKey(ROOT, path.join(ROOT, 'tools/x.test.mjs'), 'n'), 'tools/x.test.mjs :: n');
});

test('an invalid list fails loudly instead of letting failures through', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-tests-'));
  try {
    fs.mkdirSync(path.join(root, 'tools'));
    const write = (doc) => fs.writeFileSync(path.join(root, EXPECTED_FILE), JSON.stringify(doc));
    write({ failures: [{ test: KNOWN, owner: 'x' }] });
    assert.throws(() => readExpected(root), /no reason/);
    write({ failures: [entry(KNOWN), entry(KNOWN)] });
    assert.throws(() => readExpected(root), /listed twice/);
    write({ failures: [entry('a.test.mjs')] });
    assert.throws(() => readExpected(root), /is not/);
    write({});
    assert.throws(() => readExpected(root), /must be an array/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

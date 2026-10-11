import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const source = readFileSync(new URL('../app/src/androidTest/kotlin/gg/pixelkingdomwars/nativeclient/CandidateSessionHarness.kt', import.meta.url), 'utf8');
const script = JSON.parse(source.match(/private const val CLEANUP_SCRIPT = ("[^\n]+")/)[1]);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const at = filename => script.replaceAll("'$INPUT'", quote(filename));

test('compound cleanup is sent to shell stdin, never treated as a Runtime.exec executable', () => {
  const words = script.trim().split(/\s+/);
  const direct = spawnSync(words[0], words.slice(1), { encoding: 'utf8', shell: false });
  assert.equal(direct.error?.code, 'ENOENT', 'Runtime.exec(String) tries to execute if; it does not interpret shell grammar');
  assert.match(source, /executeShellCommandRw\("sh"\)/);
  assert.doesNotMatch(source, /executeShellCommand\(\s*(?:CLEANUP_SCRIPT|"if\b)/);
  assert.match(source, /AutoCloseInputStream\(pipes\[0\]\)\.use[\s\S]*AutoCloseOutputStream\(pipes\[1\]\)\.use[\s\S]*input\.write\(CLEANUP_SCRIPT\.toByteArray/);
  assert.match(source, /output\.bounded\(64\)/);
  assert.match(source, /check\(Build\.VERSION\.SDK_INT>=Build\.VERSION_CODES\.S\)/,
    'An unsupported test platform must reject before session persistence');
});

test('the exact fixed stdin script deletes only its staged file and proves absence on repeat', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkw-candidate-cleanup-'));
  try {
    const input = path.join(dir, 'staged-input.json');
    const untouched = path.join(dir, 'other-input.json');
    writeFileSync(input, 'synthetic');writeFileSync(untouched, 'unchanged');
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = spawnSync('sh', [], { input: at(input), encoding: 'utf8', timeout: 2000 });
      assert.equal(result.status, 0);assert.equal(result.stdout.trim(), 'removed');
      assert.equal(existsSync(input), false);assert.equal(readFileSync(untouched, 'utf8'), 'unchanged');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failed removal emits no success sentinel and cannot recursively remove an unexpected directory', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pkw-candidate-cleanup-'));
  try {
    const input = path.join(dir, 'unexpected-directory');mkdirSync(input);
    const result = spawnSync('sh', [], { input: at(input), encoding: 'utf8', timeout: 2000 });
    assert.equal(result.error, undefined);assert.equal(result.stdout.trim(), '');assert.equal(existsSync(input), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('closed receipt distinguishes verified session from failed deletion before failing the test', () => {
  const cleanup = source.slice(source.indexOf('} finally {'));
  assert.match(cleanup, /catch \(_: Exception\) \{ false \}/);
  assert.match(cleanup, /put\("success",succeeded && removed\)/);
  assert.match(cleanup, /put\("inputDeleted",removed\)/);
  assert.match(cleanup, /put\("normalSignatureSessionVerified",succeeded\)/);
  assert.ok(cleanup.indexOf('writeText(') < cleanup.indexOf('check(removed)'));
  assert.doesNotMatch(cleanup, /\.message|printStackTrace|\.javaClass|put\("(?:cookie|wallet|error)"/);
});

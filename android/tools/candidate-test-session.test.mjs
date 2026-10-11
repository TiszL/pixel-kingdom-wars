import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, chmod, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { generate, login, ORIGIN, sessionCookie, cookieDeadline, expectation } from './candidate-test-session.mjs';
import { manifestVersion } from './pack.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { schemaVersion: 1, sourceCommit: 'a'.repeat(40), simVersion: 15, files: [], createdAt: 'metadata-is-not-content-identity' };
manifest.contentVersion = manifestVersion(manifest);
const bytes = JSON.stringify(manifest);
const expected = { sourceCommit: manifest.sourceCommit, packHash: manifest.contentVersion, manifestFileSha256: hash(bytes), nativeBuildSha: 'b'.repeat(40), nativeVersionCode: 50, simVersion: 15 };
function decode58(value) {
  let n = 0n;for (const c of value) n = n * 58n + BigInt('123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c));
  let hex = n.toString(16);if (hex.length % 2) hex = '0' + hex;
  return Buffer.concat([Buffer.alloc(value.match(/^1*/)[0].length), n ? Buffer.from(hex, 'hex') : Buffer.alloc(0)]);
}
async function setup(t) {
  const parent = await mkdtemp(path.join(tmpdir(), 'pkw-operator-test-'));t.after(() => rm(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'private');const identity = await generate(directory);
  const calls = [];
  const fake = async (url, options) => {
    calls.push({ url, options });assert.equal(new URL(url).origin, ORIGIN);assert.equal(options.redirect, 'error');assert.equal(options.headers.Origin, ORIGIN);
    const route = new URL(url).pathname;
    if (route === '/api/native/capabilities') return Response.json({ sourceCommit: expected.sourceCommit, simVersion: 15, minimumVersionCode: 16,
      contentManifestUrl: `${ORIGIN}/native-content/${expected.packHash}/manifest.json`, presentation: { enabled: true, protocolVersions: [1, 2], raidProtocolVersions: [2] } });
    if (route.endsWith('/manifest.json')) return new Response(bytes);
    if (route === '/api/auth/challenge') return Response.json({ nonce: 'same-nonce', message: 'Sign the exact challenge\n✓' });
    if (route === '/api/auth/verify') {
      const body = JSON.parse(options.body);assert.equal(body.wallet, identity.wallet);assert.equal(body.nonce, 'same-nonce');assert.equal(body.client, 'solana-mobile');
      const operator = JSON.parse(await readFile(path.join(directory, 'operator.json')));
      assert.ok(verify(null, Buffer.from('Sign the exact challenge\n✓'), createPublicKey(operator.privateKey), decode58(body.signature)));
      return Response.json({ wallet: identity.wallet }, { headers: { 'Set-Cookie': 'shardkeep_session=test.jwt.signature; Path=/; Secure; HttpOnly; Max-Age=3600; SameSite=Lax' } });
    }
    assert.equal(route, '/api/me');assert.equal(options.headers.Cookie, 'shardkeep_session=test.jwt.signature');return Response.json({ wallet: identity.wallet });
  };
  return { directory, identity, calls, fake, parent };
}
test('generated identity signs exact real-auth shape; content identity is separate from full bytes and state is private', async t => {
  const s = await setup(t);assert.notEqual(expected.packHash, expected.manifestFileSha256);
  const result = await login(s.directory, expected, s.fake);assert.equal(result.authenticated, true);
  const input = JSON.parse(await readFile(result.sessionFile));assert.equal(input.wallet, s.identity.wallet);assert.deepEqual(input.expected, expected);
  assert.ok(input.cookieExpiresAtMs > input.createdAtMs && input.cookieExpiresAtMs <= input.createdAtMs + 3600000);
  assert.equal((await stat(result.sessionFile)).mode & 0o777, 0o600);assert.equal((await stat(path.join(s.directory, 'operator.json'))).mode & 0o777, 0o600);
  assert.equal(s.calls.filter(x => x.options.method === 'POST').length, 1);
  assert.equal(s.calls.filter(x => new URL(x.url).pathname === '/api/native/capabilities').length, 2);
  assert.equal(JSON.stringify(result).includes('test.jwt'), false);
});
test('existing output is never overwritten and no duplicate login POST is attempted', async t => {
  const s = await setup(t);await login(s.directory, expected, s.fake);s.calls.length = 0;
  await assert.rejects(login(s.directory, expected, s.fake), /prior private session/);assert.equal(s.calls.length, 0);
});
test('wrong source content or protocol fails before challenge or verification', async t => {
  const s = await setup(t);
  await assert.rejects(login(s.directory, { ...expected, sourceCommit: 'c'.repeat(40) }, s.fake), /expected release/);
  assert.equal(s.calls.length, 1);await assert.rejects(stat(path.join(s.directory, 'candidate-session.json')));
});
test('different verified identity and different me identity cannot publish a bootstrap', async t => {
  for (const target of ['/api/auth/verify', '/api/me']) {
    const s = await setup(t);
    await assert.rejects(login(s.directory, expected, async (url, options) => new URL(url).pathname === target
      ? Response.json({ wallet: 'another-wallet' }) : s.fake(url, options)), /identity/);
    await assert.rejects(stat(path.join(s.directory, 'candidate-session.json')));
  }
});
test('overlarge or failed response aborts with no cookie output or implicit retry', async t => {
  const s = await setup(t);let count = 0;
  await assert.rejects(login(s.directory, expected, async () => {count++;return new Response('x'.repeat(16385));}), /bound/);
  assert.equal(count, 1);await assert.rejects(stat(path.join(s.directory, 'candidate-session.json')));
});
test('cookie cannot cross domains, lose security attributes or be expired', () => {
  const good = 'shardkeep_session=a.b.c; Path=/; Secure; HttpOnly; Max-Age=1';
  assert.equal(sessionCookie([good]), good);
  for (const bad of [good+'; Domain=qa.pixelkingdomwars.com', good.replace('; Secure',''),good.replace('HttpOnly','x'),good.replace('Path=/','Path=/api'),good.replace('Age=1','Age=0'),good+'\r\nX: secret'])
    assert.throws(() => sessionCookie([bad]));
  assert.throws(() => sessionCookie([good, good]));assert.throws(() => sessionCookie([]));
});
test('generation cannot adopt existing keys and unsafe state files are refused before network', async t => {
  const s = await setup(t);await assert.rejects(generate(s.directory));
  await chmod(path.join(s.directory, 'operator.json'), 0o644);
  await assert.rejects(login(s.directory, expected, s.fake), /private tester file/);assert.equal(s.calls.length, 0);
  const repository = path.join(s.parent, 'repo');await mkdir(repository);await mkdir(path.join(repository, '.git'));
  await assert.rejects(generate(path.join(repository, 'secret')), /repository/);
  const link = path.join(s.parent, 'link');await symlink(repository, link);
  await assert.rejects(generate(path.join(link, 'secret')), /repository/);
});
test('expectation rejects current-account fallbacks and wrong SIM or arbitrary extra fields', () => {
  for (const bad of [{ ...expected, simVersion: 14 }, { ...expected, nativeVersionCode: -1 }, { ...expected, origin: ORIGIN }, { ...expected, packHash: 'bad' }]) assert.throws(() => expectation(bad));
});
test('relative cookie expiry is anchored at host receipt, never reset by later Android import', () => {
  const cookie = 'shardkeep_session=a.b.c; Path=/; Secure; HttpOnly; Max-Age=60';
  assert.equal(cookieDeadline(cookie, 1000), 61000);
  assert.throws(() => sessionCookie([cookie+'; Max-Age=500'], 1000));
  assert.throws(() => sessionCookie([cookie.replace('Age=60', 'Age=99999999999999999999999999')], 1000));
});

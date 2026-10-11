import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APK_CACHE_CONTROL, APK_CONTENT_TYPE, apkObjectKey, assertChannelPreflight, assertPublishable, assertStableApproval, buildManifest,
  otherKnownEntries, parseR2Env, readBackApk, readReceipt, sha256File, signV4, signerSha256FromApksigner, uploadApk,
  writeChannelManifest } from './update-channel.mjs';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SIGNER = 'a'.repeat(64);
const SECRET = 'fake-secret-value-never-printed';

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'pkw-update-channel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

/** Throwaway S3 stand-in: /bucket/<key> is the signed endpoint, /public/<key> the public base URL. */
async function fakeS3(t) {
  const objects = new Map();
  const state = { objects, corrupt: false, wrongSize: false, requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const [, area, ...rest] = req.url.split('/');
      const key = rest.join('/');
      state.requests.push({ method: req.method, area, headers: req.headers });
      if (area === 'bucket') {
        const auth = req.headers.authorization ?? '';
        const signedHeaders = /SignedHeaders=([^,]+)/.exec(auth)?.[1].split(';') ?? [];
        if (!auth.startsWith('AWS4-HMAC-SHA256 Credential=') || !signedHeaders.includes('host') ||
            !signedHeaders.includes('x-amz-content-sha256') || auth.includes(SECRET)) { res.writeHead(403); return res.end(); }
      }
      if (req.method === 'PUT') {
        const body = Buffer.concat(chunks);
        assert.equal(req.headers['if-none-match'], '*');
        assert.equal(req.headers['content-type'], APK_CONTENT_TYPE);
        assert.equal(req.headers['cache-control'], APK_CACHE_CONTROL);
        if (req.headers['x-amz-content-sha256'] !== digest(body)) { res.writeHead(400); return res.end(); }
        if (objects.has(key)) { res.writeHead(412); return res.end(); }
        objects.set(key, body);
        res.writeHead(200); return res.end();
      }
      const stored = objects.get(key);
      if (!stored) { res.writeHead(404); return res.end(); }
      const served = state.corrupt ? Buffer.from(stored.map((byte, i) => i === 0 ? byte ^ 1 : byte)) : stored;
      res.writeHead(200, { 'content-length': String(served.length + (state.wrongSize && req.method === 'HEAD' ? 1 : 0)) });
      res.end(req.method === 'HEAD' ? undefined : served);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  state.r2 = { endpoint: origin, accessKeyId: 'fake-access-key', secretAccessKey: SECRET, bucket: 'bucket', publicBaseUrl: `${origin}/public` };
  return state;
}

async function apkFixture(t, bytes = Buffer.from('not a real apk, throwaway bytes for channel tests')) {
  const root = await workspace(t);
  const file = path.join(root, 'fixture.apk');
  await writeFile(file, bytes);
  return { file, bytes, sha256: digest(bytes), size: bytes.length, key: apkObjectKey(26, digest(bytes)) };
}

// R2 rejects any request whose signature is not exact SigV4; a shape check alone
// would pass a subtly wrong canonical request. This is AWS's published S3 vector.
test('SigV4 signing matches the published AWS S3 example signature', () => {
  const headers = signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' },
    payloadHash: digest(''), accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z') });
  assert.equal(headers.authorization, 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, ' +
    'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

// Credentials live only in the web .env FILE; an error must name the missing key
// without echoing any present value, or a CI log would leak the R2 secret.
test('R2 env parsing requires all five keys and never echoes values', () => {
  const full = `R2_ENDPOINT=https://acct.r2.cloudflarestorage.com/\nR2_ACCESS_KEY_ID=key\nR2_SECRET_ACCESS_KEY="${SECRET}"\nR2_BUCKET=deeds\nR2_PUBLIC_BASE_URL=https://pub.example/\nOTHER=x`;
  assert.deepEqual(parseR2Env(full), { endpoint: 'https://acct.r2.cloudflarestorage.com', accessKeyId: 'key',
    secretAccessKey: SECRET, bucket: 'deeds', publicBaseUrl: 'https://pub.example' });
  const withoutBucket = full.replace('R2_BUCKET=deeds\n', '');
  assert.throws(() => parseR2Env(withoutBucket), (error) => /R2_BUCKET/.test(error.message) && !error.message.includes(SECRET) && !error.message.includes('key\n'));
  assert.throws(() => parseR2Env(full.replace(`"${SECRET}"`, '')), (error) => /R2_SECRET_ACCESS_KEY/.test(error.message));
});

// The object key IS the public path the client resolves; anything else never reaches Caddy's route.
test('object keys match the only path shape production serves', () => {
  assert.equal(apkObjectKey(26, 'b'.repeat(64)), `native/releases/26-${'b'.repeat(64)}.apk`);
  for (const [code, sha] of [[0, 'b'.repeat(64)], [1000000, 'b'.repeat(64)], [26, 'B'.repeat(64)], [26, 'b'.repeat(63)], [26.5, 'b'.repeat(64)]]) {
    assert.throws(() => apkObjectKey(code, sha), /Invalid/);
  }
});

// The client compares ONE running signer; a multi-signer or unreadable APK must never be offered.
test('signer parsing yields one lowercase digest and refuses zero or two signers', () => {
  const upper = 'AB'.repeat(32);
  assert.equal(signerSha256FromApksigner(`Verifies\nSigner #1 certificate DN: CN=x\nSigner #1 certificate SHA-256 digest: ${upper}\n`), upper.toLowerCase());
  assert.throws(() => signerSha256FromApksigner('Verifies\n'), /exactly one signer/);
  assert.throws(() => signerSha256FromApksigner(`Signer #1 certificate SHA-256 digest: ${SIGNER}\nSigner #2 certificate SHA-256 digest: ${'b'.repeat(64)}`), /exactly one signer/);
  assert.throws(() => signerSha256FromApksigner('Signer #1 certificate SHA-256 digest: abcd'), /SHA-256/);
});

// Hashing a 225 MB APK must stream; the result must equal the in-memory digest the receipt used.
test('file hashing streams to the same digest as the bytes', async (t) => {
  const f = await apkFixture(t, Buffer.alloc(3 * 1024 * 1024 + 7, 9));
  assert.equal(await sha256File(f.file), f.sha256);
});

// Missing receipt means we cannot prove this file is the signed release; publishing it would be unaudited.
test('a channel APK without its signing receipt is refused', async (t) => {
  const f = await apkFixture(t);
  await assert.rejects(readReceipt(f.file), /Missing signing receipt/);
  await writeFile(`${f.file}.json`, JSON.stringify({ sha256: f.sha256 }));
  assert.deepEqual(await readReceipt(f.file), { sha256: f.sha256 });
});

// Upload must be signed, immutable (If-None-Match) and carry the cache headers
// the client and CDN rely on; both read-backs must then see the exact bytes.
test('upload signs, never overwrites, and both endpoints read back the exact bytes', async (t) => {
  const s3 = await fakeS3(t);
  const f = await apkFixture(t);
  assert.equal(await uploadApk({ r2: s3.r2, key: f.key, path: f.file, sha256: f.sha256, size: f.size }), 'uploaded');
  assert.deepEqual(s3.objects.get(f.key), f.bytes);
  await readBackApk({ url: `${s3.r2.endpoint}/${s3.r2.bucket}/${f.key}`, expectedSha256: f.sha256, expectedSize: f.size, signed: s3.r2 });
  await readBackApk({ url: `${s3.r2.publicBaseUrl}/${f.key}`, expectedSha256: f.sha256, expectedSize: f.size });
  const pub = s3.requests.filter((r) => r.area === 'public');
  assert.equal(pub.length, 2);
  assert.ok(pub.every((r) => !r.headers.authorization), 'public read-back must be unsigned');
});

// A re-run after an interrupted publish must succeed only when the stored object is ours.
test('412 counts as already published only when read-back proves the same bytes', async (t) => {
  const s3 = await fakeS3(t);
  const f = await apkFixture(t);
  await uploadApk({ r2: s3.r2, key: f.key, path: f.file, sha256: f.sha256, size: f.size });
  assert.equal(await uploadApk({ r2: s3.r2, key: f.key, path: f.file, sha256: f.sha256, size: f.size }), 'exists');
  s3.objects.set(f.key, Buffer.from('different bytes already at this key'));
  await assert.rejects(uploadApk({ r2: s3.r2, key: f.key, path: f.file, sha256: f.sha256, size: f.size }), /different object already occupies/);
});

// Any other upload failure refuses and never echoes the credential.
test('a rejected upload refuses without leaking the secret', async (t) => {
  const s3 = await fakeS3(t);
  const f = await apkFixture(t);
  const fetchImpl = async () => new Response(null, { status: 403 });
  await assert.rejects(uploadApk({ r2: s3.r2, key: f.key, path: f.file, sha256: f.sha256, size: f.size, fetchImpl }),
    (error) => /HTTP 403/.test(error.message) && !error.message.includes(SECRET));
});

// The client refuses a hash mismatch AFTER a 225 MB download; the tool must catch
// a truncated or corrupted object before any player is offered it.
test('read-back refuses a wrong size or corrupted bytes from either endpoint', async (t) => {
  const s3 = await fakeS3(t);
  const f = await apkFixture(t);
  await uploadApk({ r2: s3.r2, key: f.key, path: f.file, sha256: f.sha256, size: f.size });
  const targets = [{ url: `${s3.r2.endpoint}/${s3.r2.bucket}/${f.key}`, signed: s3.r2 }, { url: `${s3.r2.publicBaseUrl}/${f.key}` }];
  for (const target of targets) {
    s3.wrongSize = true;
    await assert.rejects(readBackApk({ ...target, expectedSha256: f.sha256, expectedSize: f.size }), /size mismatch/);
    s3.wrongSize = false; s3.corrupt = true;
    await assert.rejects(readBackApk({ ...target, expectedSha256: f.sha256, expectedSize: f.size }), /sha256 mismatch/);
    s3.corrupt = false;
    await assert.rejects(readBackApk({ ...target, expectedSha256: f.sha256, expectedSize: f.size + 1 }), /size mismatch/);
  }
});

function manifestInput(overrides = {}) {
  const sha256 = 'c'.repeat(64);
  return { badging: { applicationId: 'gg.pixelkingdomwars.twa', versionCode: 26, versionName: '0.5.9' },
    receipt: { versionCode: 26, sha256, nativeCommit: 'd'.repeat(40), sourceCommit: 'e'.repeat(40) },
    sha256, size: 225576834, signer: SIGNER, channel: 'tester', mandatory: false, notesUrl: null, createdBy: 'release.mjs@host', ...overrides };
}

// The operator CLI validates this exact schema; a renamed or extra key is a refused publish.
test('manifest has exactly the M45 CLI keys and names the signed native commit', () => {
  const manifest = buildManifest(manifestInput());
  assert.deepEqual(Object.keys(manifest), ['versionCode', 'versionName', 'sourceCommit', 'sha256', 'sizeBytes', 'signerSha256', 'channel', 'mandatory', 'notesUrl', 'createdBy']);
  assert.deepEqual(manifest, { versionCode: 26, versionName: '0.5.9', sourceCommit: 'd'.repeat(40), sha256: 'c'.repeat(64), sizeBytes: 225576834,
    signerSha256: SIGNER, channel: 'tester', mandatory: false, notesUrl: null, createdBy: 'release.mjs@host' });
  assert.equal(buildManifest(manifestInput({ mandatory: true, notesUrl: 'https://pixelkingdomwars.com/notes' })).notesUrl, 'https://pixelkingdomwars.com/notes');
});

// A receipt for other bytes or another code proves nothing about this file.
test('manifest refuses a receipt that does not identify the exact file', () => {
  assert.throws(() => buildManifest(manifestInput({ receipt: { versionCode: 26, sha256: 'f'.repeat(64), nativeCommit: 'd'.repeat(40) } })), /exact APK/);
  assert.throws(() => buildManifest(manifestInput({ receipt: { versionCode: 25, sha256: 'c'.repeat(64), nativeCommit: 'd'.repeat(40) } })), /exact APK/);
  assert.throws(() => buildManifest(manifestInput({ receipt: undefined })), /exact APK/);
  assert.throws(() => buildManifest(manifestInput({ size: 314572801 })), /300 MiB/);
  assert.throws(() => buildManifest(manifestInput({ notesUrl: 'http://insecure' })), /https/);
  assert.throws(() => buildManifest(manifestInput({ channel: 'beta' })), /tester or stable/);
});

const base = { knownCodes: [25], remoteRows: undefined, code: 26, sha256: 'c'.repeat(64), channel: 'tester', signer: SIGNER, expectSigner: SIGNER };
const row = (overrides = {}) => ({ versionCode: 26, sha256: 'c'.repeat(64), signerSha256: SIGNER, channel: 'tester', ...overrides });

// Baseline: a strictly newer code signed by the expected key publishes.
test('publishable: a strictly newer code with the expected signer', () => {
  assert.deepEqual(assertPublishable(base), { promotion: false });
  assert.deepEqual(assertPublishable({ ...base, remoteRows: [row({ versionCode: 25, sha256: 'b'.repeat(64) })] }), { promotion: false });
});

// Android refuses a same/lower code install; a stale code would be an offer nobody can install.
test('refuses a code that is not strictly greater than local inventory', () => {
  assert.throws(() => assertPublishable({ ...base, knownCodes: [26] }), /greater than 26/);
  assert.throws(() => assertPublishable({ ...base, knownCodes: [27, 3] }), /greater than 27/);
});

// Rows are never deleted: a code below the live channel would be refused server-side
// only after the immutable object was uploaded; refuse before upload.
test('refuses a code that is not strictly greater than the remote channel', () => {
  assert.throws(() => assertPublishable({ ...base, remoteRows: [row({ versionCode: 27, sha256: 'b'.repeat(64) })] }), /greater than 27/);
});

// One code must map to one file forever; a different file under a published code is a forgery path.
test('refuses a published code with different bytes', () => {
  assert.throws(() => assertPublishable({ ...base, remoteRows: [row({ sha256: 'b'.repeat(64) })] }), /different bytes/);
});

// The only same-code republish is promoting the identical file tester -> stable.
test('allows only the identical file to be promoted tester to stable', () => {
  assert.deepEqual(assertPublishable({ ...base, channel: 'stable', remoteRows: [row()] }), { promotion: true });
  assert.throws(() => assertPublishable({ ...base, channel: 'tester', remoteRows: [row()] }), /already published on tester/);
  assert.throws(() => assertPublishable({ ...base, channel: 'stable', remoteRows: [row({ channel: 'stable' })] }), /already published on stable/);
});

// Stable is visible to every player; withdrawing it to tester would silently strand them.
test('refuses stable to tester', () => {
  assert.throws(() => assertPublishable({ ...base, channel: 'tester', remoteRows: [row({ channel: 'stable' })] }), /cannot move back to tester/);
});

// Android refuses an update signed by another key; the client would also refuse the offer.
test('refuses a signer different from --expect-signer', () => {
  assert.throws(() => assertPublishable({ ...base, signer: 'b'.repeat(64) }), /expected update signer/);
});

// Even with a matching --expect-signer override, the channel's signer lineage is fixed by its latest row.
test('refuses a signer different from the latest remote row', () => {
  const rows = [row({ versionCode: 24, sha256: 'e'.repeat(64) }), row({ versionCode: 25, sha256: 'b'.repeat(64), signerSha256: 'f'.repeat(64) })];
  assert.throws(() => assertPublishable({ ...base, remoteRows: rows }), /latest channel release/);
});

// Only tester and stable exist server-side.
test('refuses an unknown channel', () => {
  assert.throws(() => assertPublishable({ ...base, channel: 'beta' }), /tester or stable/);
});

// The manifest file is the local record of what was published; it is never silently rewritten.
test('channel manifest is exclusive, reusable when equal, and replaceable only by a promotion', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'fixture.channel.json');
  const tester = buildManifest(manifestInput());
  assert.equal(await writeChannelManifest(file, tester), 'written');
  assert.equal(await writeChannelManifest(file, tester), 'reused');
  await assert.rejects(writeChannelManifest(file, { ...tester, sha256: 'b'.repeat(64) }), /differs/);
  const stable = { ...tester, channel: 'stable', mandatory: true };
  assert.equal(await writeChannelManifest(file, stable), 'promoted');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), stable);
  await assert.rejects(writeChannelManifest(file, tester), /differs/);
});

// The channel offers an install over the store app; a different package would not replace it in place
// and the client would refuse it. Refused before upload because the object is never overwritten.
test('manifest refuses an APK whose package differs from the store listing', () => {
  const input = manifestInput();
  assert.throws(() => buildManifest({ ...input, badging: { ...input.badging, applicationId: 'gg.pixelkingdomwars.native' } }), /package differs/);
});

// Only committed source and a signed file in releases/ may reach R2: a dirty tree means the file's
// nativeCommit may not describe what was built, and a file elsewhere has no signing-tool provenance.
test('preflight refuses a dirty tree, an APK outside releases and a non-APK file', () => {
  const releasesDir = '/repo/releases';
  assert.doesNotThrow(() => assertChannelPreflight({ porcelain: '', apk: '/repo/releases/x.apk', releasesDir }));
  assert.throws(() => assertChannelPreflight({ porcelain: ' M tools/release.mjs\n', apk: '/repo/releases/x.apk', releasesDir }), /Commit and review/);
  for (const apk of ['/repo/other/x.apk', '/repo/releases-evil/x.apk', '/repo/releases/x.apk.json', '/repo/releases/x.aab']) {
    assert.throws(() => assertChannelPreflight({ porcelain: '', apk, releasesDir }), /release directory/);
  }
});

// Stable is offered to every player, and the brief makes it an owner gate ("go for stable" in chat).
// The tool cannot read chat, so the operator must state the approval explicitly; a stable publish with
// no such statement is refused. Tester needs nothing beyond the signed receipt: it is how the owner proves the file.
test('stable requires the explicit owner approval flag; tester does not', () => {
  assert.doesNotThrow(() => assertStableApproval({ channel: 'tester', approved: false }));
  assert.doesNotThrow(() => assertStableApproval({ channel: 'stable', approved: true }));
  for (const approved of [false, undefined, null, 'yes', 1]) {
    assert.throws(() => assertStableApproval({ channel: 'stable', approved }), /--owner-approved/);
  }
});

// "Strictly greater than local inventory" must ignore only THIS file (and its byte-identical store mirror).
// Matching on code alone would let a different same-code file through; matching on path would refuse every publish.
test('local inventory excludes only byte-identical copies of the file being published', async () => {
  const sha256 = 'c'.repeat(64);
  const hashes = { '/r/self.apk': sha256, '/store/mirror.apk': sha256, '/r/other26.apk': 'b'.repeat(64), '/r/code25.apk': sha256 };
  const known = Object.keys(hashes).map((file, i) => ({ path: file, versionCode: i === 3 ? 25 : 26 }));
  const others = await otherKnownEntries(known, { versionCode: 26, sha256 }, async (file) => hashes[file]);
  assert.deepEqual(others.map((entry) => entry.path), ['/r/other26.apk', '/r/code25.apk']);
  const codes = others.map((entry) => entry.versionCode);
  assert.throws(() => assertPublishable({ ...base, knownCodes: codes }), /greater than 26/);
  const alone = await otherKnownEntries(known.filter((entry) => entry.path !== '/r/other26.apk'), { versionCode: 26, sha256 }, async (file) => hashes[file]);
  assert.deepEqual(assertPublishable({ ...base, knownCodes: alone.map((entry) => entry.versionCode) }), { promotion: false });
});

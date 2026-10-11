/**
 * M45 native in-app update channel, server side (Track N0 A1; D-153.47).
 *
 * WHY: capabilities is the ONE endpoint every installed native client reads at
 * start. An update offer is an instruction to fetch and install an APK, so the
 * server must only ever advertise (a) rows an operator published through the
 * refusing CLI, (b) to the audience the row's channel names, (c) with bytes the
 * public origin already serves, and (d) must never let a row be rewritten or
 * removed underneath a device that is mid-download.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { loadConfig, type Config } from '../src/config';
import { sessions } from '../src/db/schema';
import { NativeCapabilitiesSchema } from '../src/native/contracts';
import {
  listNativeUpdates, markNativeUpdatePublished, NativeUpdateChannelError, publicApkUrl, publishNativeUpdate, toApkPath,
} from '../src/native/updateChannel';
import { headContentLength, main, type UpdateChannelCliIo } from '../src/native/updateChannelCli';
import { TEST_DATABASE_URL } from './db-url';
import { hex, manifest, resetNativeUpdateChannel, SIGNER } from './fixtures/nativeUpdateChannel';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const PLAY = 'https://play.example.com';
const origin = { PLAY_URL: PLAY, WEB_ORIGIN: TEST_CONFIG.WEB_ORIGIN };
const skip = { config: origin, originCheck: false as const };
let on: FastifyInstance; let off: FastifyInstance;
let tester: string; let admin: string;

async function session(wallet: string, config: Config) {
  const [row] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(config, wallet, row!.id) };
}
async function player() { return (await createTestPlayer(db)).wallet; }
async function capabilities(app: FastifyInstance, cookies?: Record<string, string>) {
  const reply = await app.inject({ method: 'GET', url: '/native/capabilities', ...(cookies ? { cookies } : {}) });
  expect(reply.statusCode, reply.body).toBe(200);
  return reply.json() as Record<string, unknown> & { update?: Record<string, unknown> };
}
const publish = (code: number, overrides: Record<string, unknown> = {}) => publishNativeUpdate(db, manifest(code, overrides), skip);

beforeAll(async () => {
  tester = await player(); admin = await player();
  const config: Config = { ...TEST_CONFIG, NATIVE_UPDATE_CHANNEL_ENABLED: 'true', PLAY_URL: PLAY,
    NATIVE_PRESENTATION_WALLETS: [tester], ADMIN_WALLETS: [admin] };
  on = await buildApp(config, db); off = await buildApp({ ...config, NATIVE_UPDATE_CHANNEL_ENABLED: 'false' }, db);
  await on.ready(); await off.ready();
});
beforeEach(() => resetNativeUpdateChannel(db));
afterAll(async () => {
  await resetNativeUpdateChannel(db);
  await on?.close(); await off?.close(); await conn.sql.end();
});

// The flag is the production kill switch: off means installed devices are told
// nothing, whatever rows exist, and the key is ABSENT (code 25 never sees null).
describe('capabilities advertisement', () => {
  it('flag off: no update key even with a stable row', async () => {
    await publish(26, { channel: 'stable' });
    expect(Object.hasOwn(await capabilities(off), 'update')).toBe(false);
  });

  it('flag on without rows: the key is absent, never null', async () => {
    expect(Object.hasOwn(await capabilities(on), 'update')).toBe(false);
  });

  it('stable rows reach every caller, including unauthenticated, with the frozen §1 shape', async () => {
    await publish(26, { channel: 'stable' });
    const body = await capabilities(on);
    const apkPath = toApkPath(26, manifest(26)['sha256'] as string);
    expect(body.update).toEqual({
      latestVersionCode: 26, versionName: '0.5.26', sourceCommit: hex('c', 40), apkPath,
      apkUrl: `${PLAY}${apkPath}`, sha256: manifest(26)['sha256'], sizeBytes: 225_576_834, signerSha256: SIGNER,
      publishedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      storeStatus: 'pending', channel: 'stable', mandatory: false, notesUrl: null,
    });
    // The route's own schema must carry the offer through unchanged.
    expect(NativeCapabilitiesSchema.parse(body)).toEqual(body);
  });

  // Tester builds are unreviewed store candidates: leaking one to the public
  // would install an unaccepted binary on players' phones.
  it('tester rows reach only NATIVE_PRESENTATION_WALLETS or ADMIN_WALLETS sessions', async () => {
    await publish(27);
    expect(Object.hasOwn(await capabilities(on), 'update')).toBe(false);
    expect(Object.hasOwn(await capabilities(on, await session(await player(), TEST_CONFIG)), 'update')).toBe(false);
    expect(Object.hasOwn(await capabilities(on, { [SESSION_COOKIE]: 'not-a-jwt' }), 'update')).toBe(false);
    expect((await capabilities(on, await session(tester, TEST_CONFIG))).update).toMatchObject({ latestVersionCode: 27, channel: 'tester' });
    expect((await capabilities(on, await session(admin, TEST_CONFIG))).update).toMatchObject({ latestVersionCode: 27, channel: 'tester' });
  });

  it('the highest VISIBLE code wins per caller', async () => {
    await publish(26, { channel: 'stable' }); await publish(27);
    // Owner 2026-09-27: installed builds ask without a cookie while signed out or
    // restoring (native 2cf5da4 UpdateRepository.kt:259). While a tester candidate is
    // in flight they must still get the stable row, never nothing and never the candidate.
    expect((await capabilities(on)).update).toMatchObject({ latestVersionCode: 26, channel: 'stable' });
    expect((await capabilities(on, await session(await player(), TEST_CONFIG))).update).toMatchObject({ latestVersionCode: 26 });
    expect((await capabilities(on, await session(tester, TEST_CONFIG))).update).toMatchObject({ latestVersionCode: 27 });
  });

  // Code 25 reads capabilities on its battle path (M45 "one rule"). A row the
  // wire schema cannot carry must drop the optional offer, never 500 the route.
  it('a row the DB accepts but the wire schema refuses leaves capabilities 200 without update', async () => {
    const sha = hex('8', 64);
    await db.execute(sql`INSERT INTO native_update_channel
      (version_code, version_name, source_commit, apk_path, sha256, size_bytes, signer_sha256, channel, notes_url, created_by)
      VALUES (26, '0.5.26', ${hex('c', 40)}, ${toApkPath(26, sha)}, ${sha}, 1, ${SIGNER}, 'stable', 'https://bad^host/notes', 'psql')`);
    const body = await capabilities(on);
    expect(Object.hasOwn(body, 'update')).toBe(false);
    expect(body).toEqual(await capabilities(off));
  });

  // apkUrl is informational for humans/landing; it must point at the one
  // canonical public origin the Caddy route lives on, never a PLAY_URL path.
  it('apkUrl is PLAY_URL ?? WEB_ORIGIN[0] origin + apkPath', () => {
    const apkPath = toApkPath(26, hex('d', 64));
    expect(publicApkUrl({ PLAY_URL: PLAY, WEB_ORIGIN: ['https://other.example'] }, apkPath)).toBe(`${PLAY}${apkPath}`);
    expect(publicApkUrl({ WEB_ORIGIN: ['https://first.example', 'https://second.example'] }, apkPath)).toBe(`https://first.example${apkPath}`);
    expect(publicApkUrl({ PLAY_URL: `${PLAY}/app/` }, apkPath)).toBe(`${PLAY}${apkPath}`);
    expect(() => publicApkUrl({}, apkPath)).toThrow(NativeUpdateChannelError);
  });
});

async function refused(work: Promise<unknown>, code: string) {
  await expect(work).rejects.toMatchObject({ name: 'NativeUpdateChannelError', code });
}

// Every refusal protects a device: a lower code cannot install over a higher
// one, a foreign signer cannot install at all, and an offer whose bytes the
// origin does not serve at the advertised size fails every download.
describe('publish refusals', () => {
  it('refuses a code not strictly greater than the latest row', async () => {
    await publish(26);
    await refused(publish(26, { sha256: hex('e', 64) }), 'PROMOTION_REFUSED');
    await refused(publish(25), 'VERSION_NOT_GREATER');
    await refused(publish(26), 'PROMOTION_REFUSED'); // re-publishing the same tester row is not a promotion
    expect((await listNativeUpdates(db, origin)).map((row) => row.latestVersionCode)).toEqual([26]);
  });

  it('refuses a signer different from the latest row', async () => {
    await publish(26);
    await refused(publish(27, { signerSha256: hex('6', 64) }), 'SIGNER_MISMATCH');
  });

  it.each([
    ['uppercase sha256', { sha256: hex('A', 64) }], ['short sha256', { sha256: hex('a', 63) }],
    ['zero size', { sizeBytes: 0 }], ['size over 300 MiB', { sizeBytes: 314_572_801 }],
    ['non-semver name', { versionName: '0.5' }], ['short commit', { sourceCommit: hex('c', 39) }],
    ['http notes', { notesUrl: 'http://example.com/notes' }], ['seven-digit code', { versionCode: 1_000_000 }],
    ['unknown key', { apkUrl: 'https://evil.example/x.apk' }], ['missing author', { createdBy: '' }],
  ])('refuses an invalid manifest: %s', async (_label, overrides) => {
    await refused(publish(26, overrides), 'INVALID_MANIFEST');
  });

  it('accepts the 300 MiB bound exactly', async () => {
    expect((await publish(26, { sizeBytes: 314_572_800 })).sizeBytes).toBe(314_572_800);
  });

  it('HEADs the public origin and requires content-length == sizeBytes', async () => {
    const seen: string[] = [];
    const check = (length: number | null) => async (url: string) => { seen.push(url); return length; };
    await refused(publishNativeUpdate(db, manifest(26), { config: origin, originCheck: check(1) }), 'ORIGIN_SIZE_MISMATCH');
    await refused(publishNativeUpdate(db, manifest(26), { config: origin, originCheck: check(null) }), 'ORIGIN_SIZE_MISMATCH');
    expect(await listNativeUpdates(db, origin)).toEqual([]);
    const row = await publishNativeUpdate(db, manifest(26), { config: origin, originCheck: check(225_576_834) });
    expect(seen).toEqual(Array(3).fill(row.apkUrl));
    expect(row.apkUrl).toBe(`${PLAY}${toApkPath(26, manifest(26)['sha256'] as string)}`);
  });

  // Promotion re-labels the SAME accepted file; it is the only way an existing
  // code is published again, and it never moves backwards.
  it('promotes the identical row tester->stable (optionally mandatory) and refuses stable->tester', async () => {
    const offered = await publish(26);
    const promoted = await publish(26, { channel: 'stable', mandatory: true });
    expect(promoted).toEqual({ ...offered, channel: 'stable', mandatory: true });
    await refused(publish(26, { channel: 'tester' }), 'PROMOTION_REFUSED');
    await refused(publish(26, { channel: 'stable', mandatory: true }), 'PROMOTION_REFUSED');
  });

  it('refuses a promotion whose file facts differ from the tester row', async () => {
    await publish(26);
    await refused(publish(26, { channel: 'stable', sizeBytes: 1 }), 'PROMOTION_REFUSED');
    await refused(publish(26, { channel: 'stable', sourceCommit: hex('d', 40) }), 'PROMOTION_REFUSED');
  });

  it('mark-published flips storeStatus once and repeats as a no-op', async () => {
    await publish(26);
    expect((await markNativeUpdatePublished(db, 26, origin)).storeStatus).toBe('published');
    expect((await markNativeUpdatePublished(db, 26, origin)).storeStatus).toBe('published');
    await refused(markNativeUpdatePublished(db, 99, origin), 'NOT_FOUND');
  });
});

// The DB, not the CLI, is the last line: even a hand-typed psql statement
// cannot rewrite the bytes/signer a device will verify, or erase history.
describe('database immutability', () => {
  const pgMessage = async (work: Promise<unknown>) => {
    try { await work; } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      return cause?.message ?? (error as Error).message;
    }
    throw new Error('expected the statement to be refused');
  };
  beforeEach(async () => { await publish(26); });

  it.each([
    ['sha256 rewrite', sql`UPDATE native_update_channel SET sha256 = ${hex('f', 64)}, apk_path = ${toApkPath(26, hex('f', 64))}`],
    ['size rewrite', sql`UPDATE native_update_channel SET size_bytes = 1`],
    ['published_at rewrite', sql`UPDATE native_update_channel SET published_at = now() - interval '1 day'`],
    ['store_status published->pending', sql`UPDATE native_update_channel SET store_status = 'pending'`],
    ['channel stable->tester', sql`UPDATE native_update_channel SET channel = 'tester'`],
    ['mandatory true->false', sql`UPDATE native_update_channel SET mandatory = false`],
  ])('refuses %s', async (_label, statement) => {
    await db.execute(sql`UPDATE native_update_channel SET store_status = 'published', channel = 'stable', mandatory = true`);
    const before = await db.execute(sql`SELECT * FROM native_update_channel`);
    expect(await pgMessage(db.execute(statement))).toContain('only move forward');
    expect(await db.execute(sql`SELECT * FROM native_update_channel`)).toEqual(before);
  });

  it('allows exactly the three forward moves', async () => {
    await db.execute(sql`UPDATE native_update_channel SET channel = 'stable', store_status = 'published', mandatory = true`);
    expect(await listNativeUpdates(db, origin)).toMatchObject([{ channel: 'stable', storeStatus: 'published', mandatory: true }]);
  });

  it('refuses DELETE and TRUNCATE', async () => {
    expect(await pgMessage(db.execute(sql`DELETE FROM native_update_channel`))).toContain('never deleted');
    expect(await pgMessage(db.execute(sql`TRUNCATE native_update_channel`))).toContain('never deleted');
    expect(await listNativeUpdates(db, origin)).toHaveLength(1);
  });

  it('refuses an apk_path that is not /native/releases/<code>-<sha256>.apk', async () => {
    const sha = hex('9', 64);
    expect(await pgMessage(db.execute(sql`INSERT INTO native_update_channel
      (version_code, version_name, source_commit, apk_path, sha256, size_bytes, signer_sha256, channel, created_by)
      VALUES (27, '0.5.27', ${hex('c', 40)}, ${toApkPath(28, sha)}, ${sha}, 1, ${SIGNER}, 'tester', 'psql')`)))
      .toContain('native_update_channel_apk_path_ck');
  });

  // The DB must refuse what the wire schema refuses (six-digit apkPath, z.url()),
  // or a psql row becomes an offer no route can serve and no client can parse.
  it.each([
    ['a seven-digit version_code', 1_000_000, null, 'native_update_channel_version_code_ck'],
    ['a notes_url without a host', 27, 'https://', 'native_update_channel_notes_url_ck'],
    ['a notes_url with whitespace', 27, 'https://example.com/a b', 'native_update_channel_notes_url_ck'],
  ])('refuses %s', async (_label, code, notesUrl, constraint) => {
    const sha = hex('7', 64);
    expect(await pgMessage(db.execute(sql`INSERT INTO native_update_channel
      (version_code, version_name, source_commit, apk_path, sha256, size_bytes, signer_sha256, channel, notes_url, created_by)
      VALUES (${code}, '0.5.27', ${hex('c', 40)}, ${toApkPath(code, sha)}, ${sha}, 1, ${SIGNER}, 'tester', ${notesUrl}, 'psql')`)))
      .toContain(constraint);
  });

  // Operators rerun migrations; a replay must neither fail nor weaken a guard.
  it('replays 0170 without changing rows, functions, constraints or triggers', async () => {
    const snapshot = async () => ({
      rows: await db.execute(sql`SELECT * FROM native_update_channel`),
      functions: await db.execute(sql`SELECT oid::text, proacl, pg_get_functiondef(oid) AS definition FROM pg_catalog.pg_proc
        WHERE proname LIKE 'shardkeep_native_update_channel_%' ORDER BY proname`),
      constraints: await db.execute(sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.native_update_channel'::regclass ORDER BY conname`),
      triggers: await db.execute(sql`SELECT oid::text, tgname, tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_catalog.pg_trigger
        WHERE tgrelid = 'public.native_update_channel'::regclass ORDER BY tgname`),
    });
    const before = await snapshot();
    expect(before.triggers).toHaveLength(3);
    const migration = await readFile(new URL('../drizzle/0170_native_update_channel.sql', import.meta.url), 'utf8');
    for (let replay = 0; replay < 2; replay++) {
      await conn.sql.begin(async (tx) => {
        for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      });
      expect(await snapshot()).toEqual(before);
    }
  });
});

// The CLI is the only writer. Refusals must exit non-zero with a greppable code
// so the release tool (M45 §4) can stop instead of reporting success.
describe('operator CLI', () => {
  const env = { DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173',
    PLAY_URL: PLAY, NODE_ENV: 'test' };
  function io(stdin = '', originCheck: UpdateChannelCliIo['originCheck'] = async () => null) {
    const out: string[] = []; const err: string[] = [];
    return { out, err, io: { readStdin: async () => stdin, print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line), originCheck } satisfies UpdateChannelCliIo };
  }

  it('publish reads stdin by default, applies --created-by and prints the offer', async () => {
    const t = io(JSON.stringify(manifest(26, { createdBy: 'from-file' })));
    expect(await main(['publish', '--skip-origin-check', '--created-by', 'ops@host'], env, t.io)).toBe(0);
    expect(JSON.parse(t.out.join('\n'))).toMatchObject({ latestVersionCode: 26, apkUrl: expect.stringMatching(/^https:\/\/play\.example\.com\//) });
    const [row] = await db.execute<{ created_by: string }>(sql`SELECT created_by FROM native_update_channel`);
    expect(row?.created_by).toBe('ops@host');
  });

  it('publish --manifest <path> runs the origin check unless skipped', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pkw-channel-'));
    try {
      const file = path.join(dir, `${randomUUID()}.channel.json`);
      await writeFile(file, JSON.stringify(manifest(26)));
      const bad = io('', async () => 5);
      expect(await main(['publish', '--manifest', file], env, bad.io)).toBe(1);
      expect(bad.err.join('\n')).toMatch(/^ORIGIN_SIZE_MISMATCH: /);
      const good = io('', async () => 225_576_834);
      expect(await main(['publish', '--manifest', file], env, good.io)).toBe(0);
      const again = io('', async () => 225_576_834);
      expect(await main(['publish', '--manifest', file], env, again.io)).toBe(1);
      expect(again.err.join('\n')).toMatch(/^PROMOTION_REFUSED: /);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('publish refuses unreadable JSON without echoing it', async () => {
    const t = io('{"sha256": "secret-looking"');
    expect(await main(['publish', '--manifest', '-', '--skip-origin-check'], env, t.io)).toBe(1);
    expect(t.err.join('\n')).toMatch(/^INVALID_MANIFEST: /);
    expect(t.err.join('\n')).not.toContain('secret-looking');
  });

  it('mark-published --code N and show', async () => {
    await publish(26);
    const mark = io();
    expect(await main(['mark-published', '--code', '26'], env, mark.io)).toBe(0);
    expect(JSON.parse(mark.out.join('\n'))).toMatchObject({ latestVersionCode: 26, storeStatus: 'published' });
    const missing = io();
    expect(await main(['mark-published', '--code', '27'], env, missing.io)).toBe(1);
    expect(missing.err.join('\n')).toMatch(/^NOT_FOUND: /);
    const show = io();
    expect(await main(['show'], env, show.io)).toBe(0);
    expect(JSON.parse(show.out.join('\n'))).toMatchObject([{ latestVersionCode: 26, storeStatus: 'published' }]);
  });

  it.each([
    [[]], [['deploy']], [['mark-published']], [['mark-published', '--code', '0']], [['mark-published', '--code', 'x']],
    [['publish', '--code', '26']], [['show', '--manifest', '-']], [['show', 'extra']], [['publish', '--bogus']],
  ])('usage error %j exits 2 without touching the database', async (argv) => {
    const t = io();
    expect(await main(argv, env, t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('usage: native:update-channel');
  });

  // The real HEAD behind the §2 origin rule (every test above injects it). A
  // redirect, hang, 404 or missing length must end as a `CODE: message` refusal
  // the release tool can classify, never an unhandled rejection's stack trace.
  describe('headContentLength against a real origin', () => {
    let server: Server; let base: string;
    let mode: 'ok' | 'no-length' | 'missing' | 'redirect' | 'hang' = 'ok';
    beforeAll(async () => {
      server = createServer((_req, res) => {
        if (mode === 'ok') res.writeHead(200, { 'content-length': '225576834' }).end();
        else if (mode === 'no-length') res.writeHead(200, { 'transfer-encoding': 'chunked' }).end();
        else if (mode === 'missing') res.writeHead(404).end();
        else if (mode === 'redirect') res.writeHead(302, { location: 'https://elsewhere.example/x.apk' }).end();
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    });

    it('reads content-length, reports none as null, and refuses 404, redirect and timeout', async () => {
      mode = 'ok'; expect(await headContentLength(`${base}/a.apk`, 2_000)).toBe(225_576_834);
      mode = 'no-length'; expect(await headContentLength(`${base}/a.apk`, 2_000)).toBeNull();
      for (const refusedMode of ['missing', 'redirect', 'hang'] as const) {
        mode = refusedMode;
        await expect(headContentLength(`${base}/a.apk`, 300)).rejects.toMatchObject({ code: 'ORIGIN_UNAVAILABLE' });
      }
    });

    it('the CLI turns an unavailable origin into exit 1 with ORIGIN_UNAVAILABLE and writes no row', async () => {
      for (const refusedMode of ['missing', 'redirect', 'hang'] as const) {
        mode = refusedMode;
        const t = io(JSON.stringify(manifest(26)), (url) => headContentLength(url, 300));
        expect(await main(['publish'], { ...env, PLAY_URL: base }, t.io)).toBe(1);
        expect(t.err.join('\n')).toMatch(/^ORIGIN_UNAVAILABLE: /);
      }
      expect(await listNativeUpdates(db, origin)).toEqual([]);
      mode = 'ok';
      const t = io(JSON.stringify(manifest(26)), (url) => headContentLength(url, 2_000));
      expect(await main(['publish'], { ...env, PLAY_URL: base }, t.io)).toBe(0);
    });
  });
});

// Production must never hand a device a plain-http APK origin.
describe('config', () => {
  const base = { DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173' };
  const issues = (env: Record<string, string>) => { try { loadConfig(env); return ''; } catch (error) { return (error as Error).message; } };

  it('defaults dark', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'test' }).NATIVE_UPDATE_CHANNEL_ENABLED).toBe('false');
  });

  it('requires an https PLAY_URL ?? WEB_ORIGIN[0] outside development/test', () => {
    expect(issues({ ...base, NODE_ENV: 'production', NATIVE_UPDATE_CHANNEL_ENABLED: 'true' })).toContain('NATIVE_UPDATE_CHANNEL_ENABLED');
    expect(issues({ ...base, NODE_ENV: 'production', NATIVE_UPDATE_CHANNEL_ENABLED: 'true', PLAY_URL: PLAY })).not.toContain('NATIVE_UPDATE_CHANNEL_ENABLED');
    expect(issues({ ...base, NODE_ENV: 'production', NATIVE_UPDATE_CHANNEL_ENABLED: 'false' })).not.toContain('NATIVE_UPDATE_CHANNEL_ENABLED');
    expect(issues({ ...base, NODE_ENV: 'test', NATIVE_UPDATE_CHANNEL_ENABLED: 'true' })).toBe('');
  });
});

// M45 §3: the APK route must precede the SPA fallback (or a missing APK would
// be answered with index.html as 200) and accept only the immutable name shape.
describe('hosting', () => {
  const infra = (file: string) => readFile(new URL(`../../../infra/${file}`, import.meta.url), 'utf8');
  it('Caddy proxies only /native/releases/<code>-<sha256>.apk to R2, before the SPA fallback', async () => {
    const caddy = await infra('Caddyfile.vps');
    // M47 §5 names the regexp (`apk`) and captures the version code for the
    // download file name; the accepted path shape is unchanged.
    const route = caddy.indexOf('@nativeRelease path_regexp apk ^/native/releases/([0-9]{1,6})-[0-9a-f]{64}\\.apk$');
    expect(route).toBeGreaterThan(caddy.indexOf('handle_path /api/*'));
    expect(route).toBeLessThan(caddy.lastIndexOf('try_files {path} /index.html'));
    expect(caddy).toContain('reverse_proxy {$R2_PUBLIC_BASE_URL}');
    expect(await infra('docker-compose.prod.yml')).toContain('R2_PUBLIC_BASE_URL: ${R2_PUBLIC_BASE_URL:-https://invalid.invalid}');
    expect(await infra('candidate/Caddyfile')).toContain('@nativeRelease path_regexp ^/native/releases/[0-9]{1,6}-[0-9a-f]{64}\\.apk$');
  });

  // K-175: only the main API builds the offer; the D-113 companion never does.
  // Routing /native/capabilities to the companion would silently hide every
  // published row from every device, so that routing must be a conscious change.
  it('production capabilities reach the main API, not the D-113 companion', async () => {
    const caddy = await infra('Caddyfile.vps');
    expect(caddy).not.toContain('# BEGIN NATIVE COMPANION');
    expect(caddy).not.toContain('native-presentation:3004');
  });
});

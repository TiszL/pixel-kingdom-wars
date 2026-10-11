/**
 * M47 §5 public release feed, server side.
 *
 * WHY: pixelkingdomwars.com/changelog and /download render what these tables and
 * routes say, to players, automatically on every ordinary deploy. So the server
 * must (a) record only the image that is actually running, (b) publish each curated
 * note exactly once, (c) never let history be rewritten or deleted afterwards,
 * (d) still show that a release happened when it carried no note (and say so
 * loudly to the operator), and (e) expose only STABLE Android rows — a tester row
 * on the public download page would hand players an unapproved APK.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RELEASE_FEED } from '@shardkeep/shared';
import { buildApp, LANDING_READ_PATHS } from '../src/app';
import { publishNativeUpdate } from '../src/native/updateChannel';
import { main, type ReleaseCliIo } from '../src/releases/cli';
import { PublicAndroidResponseSchema, PublicReleasesResponseSchema } from '../src/releases/contracts';
import { maintenanceEntry, recordRelease } from '../src/releases/recorder';
import { RELEASE_PUBLIC_PATHS } from '../src/routes-releases';
import { BUILD } from '../src/version';
import { TEST_DATABASE_URL } from './db-url';
import { manifest as channelManifest, resetNativeUpdateChannel } from './fixtures/nativeUpdateChannel';
import { fragment, identity, resetReleaseHistory, sha } from './fixtures/releaseHistory';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const A = sha('a'); const B = sha('b'); const C = sha('c');
const record = (manifest: Record<string, unknown>, gitSha = String(manifest['gitSha'])) =>
  recordRelease(db, manifest, { identity: identity(gitSha), recordedBy: 'test' });
const rows = async () => (await db.execute<{ git_sha: string; kind: string; entries: Array<{ id: string }>; fragment_ids: string[];
  version: string; sim_version: number; built_at: Date | null; deployed_at: Date; recorded_by: string }>(
  sql`SELECT * FROM release_history ORDER BY deployed_at, git_sha`));
const claims = async () => (await db.execute<{ fragment_id: string; git_sha: string }>(
  sql`SELECT fragment_id, git_sha FROM release_fragment_claims ORDER BY fragment_id`)).map((row) => ({ ...row }));
/** Raw driver rows carry timestamps as text; normalise for comparison. */
const iso = (value: unknown) => new Date(value as string).toISOString();
const pgCode = async (work: Promise<unknown>) => {
  try { await work; } catch (error) {
    const cause = (error as { cause?: { code?: string } }).cause;
    return cause?.code ?? (error as { code?: string }).code;
  }
  throw new Error('expected the statement to be refused');
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ ...TEST_CONFIG, NATIVE_MIN_VERSION_CODE: 24, PLAY_URL: 'https://play.example.com' }, db);
  await app.ready();
});
beforeEach(async () => { await resetReleaseHistory(db); await resetNativeUpdateChannel(db); });
afterAll(async () => {
  await resetReleaseHistory(db); await resetNativeUpdateChannel(db);
  await app?.close(); await conn.sql.end();
});

describe('recorder', () => {
  it('records the running image with its fragments and claims each one', async () => {
    const result = await record({ gitSha: A, fragments: [fragment('2026-09-27-new-website'), fragment('android-26', { category: 'android', platforms: 'android' })] });
    expect(result).toEqual({ gitSha: A, status: 'inserted', claimed: ['2026-09-27-new-website', 'android-26'], generic: false, deferred: [], waiting: [], backfilled: [] });
    const [row] = await rows();
    // Identity is the image's (version.ts), never read from the manifest.
    expect(row).toMatchObject({ git_sha: A, kind: 'deploy', version: '0.5.8', sim_version: 17, recorded_by: 'test',
      fragment_ids: ['2026-09-27-new-website', 'android-26'] });
    expect(iso(row!.built_at)).toBe('2026-09-27T10:00:00.000Z');
    expect(await claims()).toEqual([
      { fragment_id: '2026-09-27-new-website', git_sha: A }, { fragment_id: 'android-26', git_sha: A },
    ]);
  });

  it('recording the same sha again is a no-op, whatever the manifest now says', async () => {
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')] });
    const before = await rows();
    const again = await record({ gitSha: A, fragments: [fragment('2026-09-27-one'), fragment('2026-09-27-two')] });
    expect(again).toMatchObject({ status: 'exists', claimed: [], generic: false });
    expect(await rows()).toEqual(before);
    expect((await claims()).map((row) => row.fragment_id)).toEqual(['2026-09-27-one']);
  });

  it('a fragment is published once: the next release claims only what is new', async () => {
    // WHY: fragments stay in release-notes/unreleased after they ship; without the
    // claim every later deploy would repeat old notes as if they were new.
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')] });
    const next = await record({ gitSha: B, fragments: [fragment('2026-09-27-one'), fragment('2026-09-28-two')] });
    expect(next).toMatchObject({ status: 'inserted', claimed: ['2026-09-28-two'], generic: false });
    const byId = Object.fromEntries((await claims()).map((row) => [row.fragment_id, row.git_sha]));
    expect(byId).toEqual({ '2026-09-27-one': A, '2026-09-28-two': B });
  });

  it('caps a release at 40 fresh fragments and leaves the rest, in reading order, for the next deploy', async () => {
    // WHY (K-night-C2): on 2026-10-11 deploy e1876c0c0 carried 45 fresh fragments;
    // migration 0500 refuses a row with more than 40 entries (23514), so the deploy
    // published NOTHING. A big release must still publish its first 40 notes, and
    // the remainder must stay unclaimed so the next deploy publishes them once.
    // Ids run in reverse lexical order: the cut follows the manifest's reading
    // order (the collector's byReadingOrder), never a re-sort by id.
    const ids = Array.from({ length: 45 }, (_, index) => `2026-10-11-note-${String(45 - index).padStart(2, '0')}`);
    const manifest = { gitSha: A, fragments: ids.map((id) => fragment(id)) };
    const first = await record(manifest);
    expect(first).toMatchObject({ status: 'inserted', generic: false, claimed: ids.slice(0, 40), deferred: ids.slice(40) });
    expect(first.deferred).toEqual(['2026-10-11-note-05', '2026-10-11-note-04', '2026-10-11-note-03', '2026-10-11-note-02', '2026-10-11-note-01']);
    const [row] = await rows();
    expect(row!.entries.map((entry) => entry.id)).toEqual(ids.slice(0, 40));
    expect(row!.fragment_ids).toEqual(ids.slice(0, 40));
    const firstClaims = await claims();
    expect(firstClaims).toHaveLength(40);
    expect(firstClaims.every((claim) => claim.git_sha === A)).toBe(true);
    // Fragments stay in release-notes/unreleased, so the next deploy carries all 45 again.
    const next = await record({ ...manifest, gitSha: B });
    expect(next).toMatchObject({ status: 'inserted', generic: false, claimed: ids.slice(40), deferred: [] });
    const byId = Object.fromEntries((await claims()).map((claim) => [claim.fragment_id, claim.git_sha]));
    expect(Object.keys(byId)).toHaveLength(45);
    for (const id of ids) expect(byId[id]).toBe(ids.indexOf(id) < 40 ? A : B);
    expect((await rows()).find((candidate) => candidate.git_sha === B)!.entries.map((entry) => entry.id)).toEqual(ids.slice(40));
  });

  it('a release with nothing new still gets a row, one generic line, and says so', async () => {
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')] });
    const result = await record({ gitSha: B, fragments: [fragment('2026-09-27-one')] });
    expect(result).toMatchObject({ status: 'inserted', claimed: [], generic: true });
    const row = (await rows()).find((candidate) => candidate.git_sha === B)!;
    expect(row.entries).toEqual([maintenanceEntry(B)]);
    expect(row.entries[0]).toMatchObject({ id: 'maintenance-bbbbbbbb', title: 'Stability and maintenance' });
    expect(row.fragment_ids).toEqual([]);
  });

  it('refuses a manifest for another sha than the running image, writing nothing', async () => {
    await expect(recordRelease(db, { gitSha: A, fragments: [fragment('2026-09-27-one')] },
      { identity: identity(B), recordedBy: 'test' })).rejects.toMatchObject({ code: 'IDENTITY_MISMATCH' });
    expect(await rows()).toEqual([]);
  });

  it('refuses a dev image that has no real release identity', async () => {
    for (const bad of [identity('dev'), identity(A, { version: '0.0.0-dev' }), identity(A, { simVersion: 0 })]) {
      await expect(recordRelease(db, { gitSha: A, fragments: [] }, { identity: bad, recordedBy: 'test' }))
        .rejects.toMatchObject({ code: 'INVALID_IDENTITY' });
    }
    expect(await rows()).toEqual([]);
  });

  it.each([
    ['markup in a body', { fragments: [fragment('2026-09-27-one', { body: 'Hi <script>alert(1)</script>' })] }],
    ['a title over the limit', { fragments: [fragment('2026-09-27-one', { title: 'x'.repeat(RELEASE_FEED.titleMaxChars + 1) })] }],
    ['a body over the limit', { fragments: [fragment('2026-09-27-one', { body: 'x'.repeat(RELEASE_FEED.bodyMaxChars + 1) })] }],
    ['a control character', { fragments: [fragment('2026-09-27-one', { title: 'two\nlines' })] }],
    ['an unknown entry key', { fragments: [fragment('2026-09-27-one', { html: '<b>' })] }],
    ['an unknown category', { fragments: [fragment('2026-09-27-one', { category: 'secret' })] }],
    ['a malformed id', { fragments: [fragment('Release_Notes')] }],
    ['a maintenance id posing as a fragment', { fragments: [fragment('maintenance-aaaaaaaa')] }],
    ['a duplicated id', { fragments: [fragment('2026-09-27-one'), fragment('2026-09-27-one')] }],
    ['an unknown top-level key', { fragments: [], extra: true }],
    ['a future-dated history row', { fragments: [], history: [{ gitSha: B, version: '0.5.8', simVersion: 17,
      deployedAt: '2099-01-01T00:00:00Z', entries: [fragment('2026-09-27-old')] }] }],
  ])('refuses %s and writes nothing', async (_label, patch) => {
    await expect(record({ gitSha: A, ...patch }, A)).rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
    expect(await rows()).toEqual([]);
    expect(await claims()).toEqual([]);
  });

  it('lists fragments waiting for a production flag and claims them only once the flag is on', async () => {
    const off = await record({ gitSha: A, fragments: [], skipped: [{ id: '2026-09-27-gems', requires: 'GEMS_ENABLED' }] });
    expect(off).toMatchObject({ status: 'inserted', claimed: [], generic: true, waiting: ['2026-09-27-gems (GEMS_ENABLED)'] });
    const on = await record({ gitSha: B, fragments: [fragment('2026-09-27-gems')] });
    expect(on).toMatchObject({ claimed: ['2026-09-27-gems'], generic: false });
  });

  it('backfills curated history once per sha, oldest first, never repeating a published line', async () => {
    // A note that shipped with deploy A and was later filed under history/ for
    // sha B must not appear twice: B's backfill row omits it.
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')] });
    const history = [
      { gitSha: C, version: '0.5.0', simVersion: 16, deployedAt: '2026-09-17T09:40:00Z', entries: [fragment('2026-09-17-realms')] },
      { gitSha: B, version: '0.3.2', simVersion: 11, deployedAt: '2026-09-01T00:00:00Z',
        entries: [fragment('2026-09-01-hotfix'), fragment('2026-09-27-one')] },
      { gitSha: sha('e'), version: '0.3.2', simVersion: 11, deployedAt: '2026-09-02T00:00:00Z', entries: [fragment('2026-09-02-only-old')] },
    ];
    const D = sha('d');
    const result = await record({ gitSha: D, fragments: [], history: history.slice(0, 2) });
    expect(result).toMatchObject({ status: 'inserted', claimed: [], generic: true, backfilled: ['bbbbbbbb', 'cccccccc'] });
    const all = await rows();
    expect(all.map((row) => [row.git_sha, row.kind, row.entries.map((entry) => entry.id)])).toEqual([
      [B, 'backfill', ['2026-09-01-hotfix']],
      [C, 'backfill', ['2026-09-17-realms']],
      [A, 'deploy', ['2026-09-27-one']],
      [D, 'deploy', ['maintenance-dddddddd']],
    ]);
    expect(all[0]).toMatchObject({ version: '0.3.2', sim_version: 11, built_at: null });
    expect(iso(all[0]!.deployed_at)).toBe('2026-09-01T00:00:00.000Z');
    // A later deploy carrying the same history inserts only what is new.
    const later = await record({ gitSha: sha('f'), fragments: [], history });
    expect(later).toMatchObject({ backfilled: ['eeeeeeee'], generic: true });
    expect(await rows()).toHaveLength(6);
  });

  it('history naming the deploying sha never outranks the deploy row', async () => {
    const result = await record({ gitSha: A, fragments: [fragment('2026-09-27-one')],
      history: [{ gitSha: A, version: '0.5.8', simVersion: 17, deployedAt: '2026-09-26T00:00:00Z', entries: [fragment('2026-09-26-old')] }] });
    expect(result).toMatchObject({ status: 'inserted', backfilled: [] });
    expect((await rows()).map((row) => row.kind)).toEqual(['deploy']);
  });

  it('two concurrent recorders of one sha produce exactly one row', async () => {
    const manifest = { gitSha: A, fragments: [fragment('2026-09-27-one')] };
    const results = await Promise.all([record(manifest), record(manifest), record(manifest)]);
    expect(results.map((result) => result.status).sort()).toEqual(['exists', 'exists', 'inserted']);
    expect(await rows()).toHaveLength(1);
  });
});

describe('append-only storage (0500)', () => {
  it('refuses UPDATE, DELETE and TRUNCATE on both tables', async () => {
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')] });
    expect(await pgCode(db.execute(sql`UPDATE release_history SET version = '9.9.9'`))).toBe('23514');
    expect(await pgCode(db.execute(sql`DELETE FROM release_history`))).toBe('23514');
    expect(await pgCode(db.execute(sql`TRUNCATE release_history CASCADE`))).toBe('23514');
    expect(await pgCode(db.execute(sql`UPDATE release_fragment_claims SET git_sha = ${B}`))).toBe('23514');
    expect(await pgCode(db.execute(sql`DELETE FROM release_fragment_claims`))).toBe('23514');
    expect(await pgCode(db.execute(sql`TRUNCATE release_fragment_claims`))).toBe('23514');
    expect(await rows()).toHaveLength(1);
  });

  it('re-validates entries in SQL, so psql cannot store a row the public route could not serve', async () => {
    const good = { id: '2026-09-27-one', category: 'new', platforms: 'all', title: 'Title', body: 'Body.' };
    const insert = (entries: unknown, gitSha = A) => db.execute(sql`INSERT INTO release_history
      (git_sha, version, sim_version, kind, entries, recorded_by) VALUES (${gitSha}, '0.5.8', 17, 'deploy', ${JSON.stringify(entries)}::jsonb, 'psql')`);
    for (const bad of [
      [], {}, [{ ...good, body: '<img src=x>' }], [{ ...good, extra: 1 }], [{ ...good, category: 'secret' }],
      [{ ...good, platforms: 'ios' }], [{ ...good, title: '' }], [{ ...good, id: 'Nope' }], [{ ...good, body: 'x'.repeat(601) }],
      Array.from({ length: 41 }, (_, index) => ({ ...good, id: `2026-09-27-n${index}` })),
    ]) expect(await pgCode(insert(bad))).toBe('23514');
    await insert([good]);
    expect(await pgCode(insert([good], 'A'.repeat(40)))).toBe('23514');
    expect(await pgCode(db.execute(sql`INSERT INTO release_history (git_sha, version, sim_version, kind, entries, recorded_by)
      VALUES (${B}, '0.5.8', 17, 'rollback', ${JSON.stringify([good])}::jsonb, 'psql')`))).toBe('23514');
  });

  it('replays 0500 without changing rows, functions, constraints or triggers', async () => {
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')] });
    const snapshot = async () => ({
      rows: await db.execute(sql`SELECT * FROM release_history`),
      claims: await db.execute(sql`SELECT * FROM release_fragment_claims`),
      functions: await db.execute(sql`SELECT oid::text, proacl, pg_get_functiondef(oid) AS definition FROM pg_catalog.pg_proc
        WHERE proname IN ('shardkeep_release_history_immutable', 'shardkeep_release_entries_valid') ORDER BY proname`),
      constraints: await db.execute(sql`SELECT oid::text, conname, pg_get_constraintdef(oid) AS definition FROM pg_catalog.pg_constraint
        WHERE conrelid IN ('public.release_history'::regclass, 'public.release_fragment_claims'::regclass) ORDER BY conname`),
      triggers: await db.execute(sql`SELECT oid::text, tgname, tgenabled, pg_get_triggerdef(oid) AS definition FROM pg_catalog.pg_trigger
        WHERE tgrelid IN ('public.release_history'::regclass, 'public.release_fragment_claims'::regclass) AND NOT tgisinternal ORDER BY tgname`),
    });
    const before = await snapshot();
    expect(before.triggers).toHaveLength(4);
    const migration = await readFile(new URL('../drizzle/0500_release_history.sql', import.meta.url), 'utf8');
    for (let replay = 0; replay < 2; replay++) {
      await conn.sql.begin(async (tx) => {
        for (const statement of migration.split('--> statement-breakpoint')) if (statement.trim()) await tx.unsafe(statement);
      });
      const after = await snapshot();
      // CREATE OR REPLACE keeps each function's oid; only the definitions are compared.
      expect(after).toEqual(before);
    }
  });

  it('sits at the reserved journal slot between main 0170 and the next lane', async () => {
    // WHY (M47 §5, D-189): Codex's parallel migrations start at 1790280000000. The
    // runner refuses non-increasing timestamps, so this exact value is the contract
    // that lets both histories merge without renumbering applied rows.
    const journal = JSON.parse(await readFile(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
      entries: Array<{ idx: number; when: number; tag: string }> };
    const index = journal.entries.findIndex((entry) => entry.tag === '0500_release_history');
    expect(index).toBeGreaterThan(0);
    expect(journal.entries[index]!.when).toBe(1_790_276_000_000);
    expect(journal.entries[index - 1]).toMatchObject({ tag: '0170_native_update_channel', when: 1_790_272_400_000 });
    const next = journal.entries[index + 1];
    if (next) expect(next.when).toBeGreaterThan(1_790_276_000_000);
  });
});

describe('public routes', () => {
  const get = (url: string) => app.inject({ method: 'GET', url });

  it('GET /public/releases answers an empty, cacheable, schema-valid feed before the first deploy', async () => {
    const reply = await get('/public/releases');
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.headers['cache-control']).toBe(`public, max-age=${RELEASE_FEED.publicCacheSec}`);
    const body = PublicReleasesResponseSchema.parse(reply.json());
    expect(body.releases).toEqual([]);
    expect(body.live).toEqual({ gitSha: BUILD.gitSha, version: BUILD.version, builtAt: BUILD.builtAt === null ? null : new Date(BUILD.builtAt).toISOString() });
  });

  it('lists releases newest first with the contract shape and honours limit', async () => {
    await record({ gitSha: A, fragments: [fragment('2026-09-27-one')],
      history: [{ gitSha: B, version: '0.5.0', simVersion: 16, deployedAt: '2026-09-17T09:40:00Z', entries: [fragment('2026-09-17-realms', { category: 'world' })] }] });
    const reply = await get('/public/releases');
    const body = PublicReleasesResponseSchema.parse(reply.json());
    expect(body.releases.map((release) => [release.gitSha, release.shortSha, release.kind])).toEqual([
      [A, 'aaaaaaaa', 'deploy'], [B, 'bbbbbbbb', 'backfill'],
    ]);
    expect(body.releases[1]).toEqual({ gitSha: B, shortSha: 'bbbbbbbb', version: '0.5.0', simVersion: 16,
      deployedAt: '2026-09-17T09:40:00.000Z', kind: 'backfill',
      entries: [{ id: '2026-09-17-realms', category: 'world', platforms: 'all', title: 'Title for 2026-09-17-realms',
        body: 'A plain player-facing sentence about what changed.' }] });
    const one = PublicReleasesResponseSchema.parse((await get('/public/releases?limit=1')).json());
    expect(one.releases.map((release) => release.gitSha)).toEqual([A]);
    expect((await get(`/public/releases?limit=${RELEASE_FEED.maxLimit}&_=cachebuster`)).statusCode).toBe(200);
  });

  it.each(['0', '51', 'abc', '1.5', '-1'])('refuses limit=%s with 400', async (limit) => {
    const reply = await get(`/public/releases?limit=${limit}`);
    expect(reply.statusCode).toBe(400);
    expect(reply.headers['cache-control']).toBeUndefined();
  });

  it('GET /public/android shows stable rows only, never a tester row, even when it is the newest', async () => {
    const skip = { config: { PLAY_URL: 'https://play.example.com' }, originCheck: false as const };
    const empty = PublicAndroidResponseSchema.parse((await get('/public/android')).json());
    expect(empty).toMatchObject({ stable: null, history: [], minimumVersionCode: 24 });
    await publishNativeUpdate(db, channelManifest(26, { channel: 'stable', notesUrl: 'https://pixelkingdomwars.com/changelog#android-26' }), skip);
    await publishNativeUpdate(db, channelManifest(27, { channel: 'tester' }), skip);
    const reply = await get('/public/android');
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.headers['cache-control']).toBe(`public, max-age=${RELEASE_FEED.publicCacheSec}`);
    const body = PublicAndroidResponseSchema.parse(reply.json());
    expect(body.stable).toEqual({
      versionCode: 26, versionName: '0.5.26', sizeBytes: 225_576_834, sha256: (26).toString(16).padStart(64, 'a'),
      signerSha256: '5'.repeat(64), publishedAt: expect.any(String), apkPath: `/native/releases/26-${(26).toString(16).padStart(64, 'a')}.apk`,
      notesUrl: 'https://pixelkingdomwars.com/changelog#android-26',
    });
    expect(body.history.map((row) => row.versionCode)).toEqual([26]);
    expect(reply.body).not.toContain('"versionCode":27');
    // Promoting 27 publishes it: now it leads, 26 stays in history.
    await publishNativeUpdate(db, channelManifest(27, { channel: 'stable' }), skip);
    const promoted = PublicAndroidResponseSchema.parse((await get('/public/android')).json());
    expect(promoted.stable?.versionCode).toBe(27);
    expect(promoted.stable?.notesUrl).toBeNull();
    expect(promoted.history.map((row) => row.versionCode)).toEqual([27, 26]);
  });

  it('is read-only and stays out of the landing CORS allowlist', async () => {
    // WHY: the Functions fetch server-to-server; widening LANDING_READ_PATHS would
    // open these to browser origins for no reader, and a write verb would let the
    // public change what the changelog says.
    for (const path of RELEASE_PUBLIC_PATHS) {
      expect(LANDING_READ_PATHS).not.toContain(path);
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
        expect((await app.inject({ method, url: path, payload: {} })).statusCode).toBe(404);
      }
    }
  });
});

// The CLI is the only writer. Refusals must exit non-zero with a greppable code
// so infra/deploy.sh can print why the changelog was not updated.
describe('recording CLI', () => {
  const env = { DATABASE_URL: TEST_DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
  function io(stdin = '', gitSha = A) {
    const out: string[] = []; const err: string[] = [];
    return { out, err, io: { readStdin: async () => stdin, print: (line: string) => out.push(line),
      printError: (line: string) => err.push(line), identity: identity(gitSha) } satisfies ReleaseCliIo };
  }

  it('record reads stdin and prints ONE json line deploy.sh can grep', async () => {
    const empty = io(JSON.stringify({ gitSha: A, fragments: [] }));
    expect(await main(['record', '--recorded-by', 'deploy.sh'], env, empty.io)).toBe(0);
    expect(empty.out).toHaveLength(1);
    // deploy.sh matches this exact byte sequence for its loud warning.
    expect(empty.out[0]).toContain('"generic":true');
    const next = io(JSON.stringify({ gitSha: B, fragments: [fragment('2026-09-27-one')] }), B);
    expect(await main(['record', '--manifest', '-'], env, next.io)).toBe(0);
    expect(JSON.parse(next.out[0]!)).toMatchObject({ status: 'inserted', generic: false, claimed: ['2026-09-27-one'], deferred: [] });
    const [row] = await db.execute<{ recorded_by: string }>(sql`SELECT recorded_by FROM release_history WHERE git_sha = ${A}`);
    expect(row?.recorded_by).toBe('deploy.sh');
    const show = io();
    expect(await main(['show', '--limit', '1'], env, show.io)).toBe(0);
    expect(JSON.parse(show.out.join('\n')).map((release: { gitSha: string }) => release.gitSha)).toHaveLength(1);
  });

  it('refuses a manifest for another sha, and unreadable JSON without echoing it', async () => {
    const mismatch = io(JSON.stringify({ gitSha: B, fragments: [] }), A);
    expect(await main(['record'], env, mismatch.io)).toBe(1);
    expect(mismatch.err.join('\n')).toMatch(/^IDENTITY_MISMATCH: /);
    const broken = io('{"title": "secret-looking"');
    expect(await main(['record'], env, broken.io)).toBe(1);
    expect(broken.err.join('\n')).toMatch(/^INVALID_MANIFEST: /);
    expect(broken.err.join('\n')).not.toContain('secret-looking');
    expect(await rows()).toEqual([]);
  });

  it.each([
    [[]], [['publish']], [['record', 'extra']], [['record', '--limit', '3']], [['show', '--manifest', '-']],
    [['show', '--limit', '0']], [['show', '--limit', '51']], [['record', '--bogus']], [['record', '--recorded-by', 'has space']],
  ])('usage error %j exits 2 without touching the database', async (argv) => {
    const t = io();
    expect(await main(argv, env, t.io)).toBe(2);
    expect(t.err.join('\n')).toContain('usage: releases');
    expect(await rows()).toEqual([]);
  });
});

// Isolated runtime roles (DB_ROLE_MODE=isolated) must be able to append and read
// history through the API container — and nothing more.
describe('runtime role grants (infra/db/provision-runtime-roles.sh)', () => {
  it('lets the API role append and read, the worker only read, and nobody rewrite', async () => {
    const provision = await readFile(new URL('../../../infra/db/provision-runtime-roles.sh', import.meta.url), 'utf8');
    const grants = [...provision.matchAll(/^SELECT '(GRANT [^']+ON public\.release_history, public\.release_fragment_claims TO shardkeep_(api|worker)_runtime)'$/gm)];
    expect(grants.map((match) => match[2]).sort()).toEqual(['api', 'worker']);
    const suffix = randomUUID().replaceAll('-', '');
    const roles = { api: `sk_rel_api_${suffix}`, worker: `sk_rel_worker_${suffix}` };
    try {
      await conn.sql.unsafe(`CREATE ROLE ${roles.api} NOLOGIN; CREATE ROLE ${roles.worker} NOLOGIN`);
      for (const match of grants) {
        await conn.sql.unsafe(match[1]!.replace(`shardkeep_${match[2]}_runtime`, roles[match[2] as 'api' | 'worker']));
      }
      const privileges = async (role: string, table: string) => Object.fromEntries(await Promise.all(
        ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'].map(async (privilege) => {
          const [row] = await conn.sql<{ ok: boolean }[]>`SELECT has_table_privilege(${role}, ${table}, ${privilege}) AS ok`;
          return [privilege, row!.ok];
        })));
      for (const table of ['public.release_history', 'public.release_fragment_claims']) {
        expect(await privileges(roles.api, table)).toEqual({ SELECT: true, INSERT: true, UPDATE: false, DELETE: false, TRUNCATE: false });
        expect(await privileges(roles.worker, table)).toEqual({ SELECT: true, INSERT: false, UPDATE: false, DELETE: false, TRUNCATE: false });
      }
    } finally {
      await conn.sql.unsafe(`DROP OWNED BY ${roles.api}, ${roles.worker}; DROP ROLE IF EXISTS ${roles.api}; DROP ROLE IF EXISTS ${roles.worker}`)
        .catch(() => undefined);
    }
  });
});

// M47 §5 hosting on the game origin. Behaviour was also exercised against the
// production caddy image (lane report); these pins keep the contract in review.
describe('public hosting (infra/Caddyfile.vps)', () => {
  const caddyFile = () => readFile(new URL('../../../infra/Caddyfile.vps', import.meta.url), 'utf8');

  it('names downloaded APKs after their version code without changing the path or caching', async () => {
    // WHY: a browser download saved as `26-<64 hex>.apk` looks like malware to a
    // player; the in-app updater keeps the same URL and immutable cache.
    const caddy = await caddyFile();
    const block = caddy.slice(caddy.indexOf('handle @nativeRelease {'), caddy.indexOf('handle /native/releases/* {'));
    expect(caddy).toContain('@nativeRelease path_regexp apk ^/native/releases/([0-9]{1,6})-[0-9a-f]{64}\\.apk$');
    const success = block.slice(block.indexOf('header {'), block.indexOf('match status 2xx'));
    expect(success).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(success).toContain('Content-Disposition `attachment; filename="pixel-kingdom-wars-{re.apk.1}.apk"`');
    // Only a real file gets the attachment name; misses stay uncached 404s.
    expect(block.match(/Content-Disposition/g)).toHaveLength(1);
  });

  it('serves a real robots.txt and a real 404 for /sitemap.xml, before the SPA fallback, and keeps noindex', async () => {
    // WHY: the SPA fallback answered both with index.html (200 text/html): an
    // unparseable robots file and a soft 404. Crawlers must be allowed in to see
    // the X-Robots-Tag noindex that keeps the game itself out of search results.
    const caddy = await caddyFile();
    const fallback = caddy.lastIndexOf('try_files {path} /index.html');
    const robots = caddy.indexOf('handle /robots.txt {');
    const sitemap = caddy.indexOf('handle /sitemap.xml {');
    expect(robots).toBeGreaterThan(caddy.indexOf('handle_path /api/*'));
    expect(robots).toBeLessThan(fallback);
    expect(sitemap).toBeLessThan(fallback);
    const robotsBlock = caddy.slice(robots, sitemap);
    expect(robotsBlock.split('\n').map((line) => line.trim())).toEqual(expect.arrayContaining([
      'respond <<ROBOTS', 'User-agent: *', 'Allow: /', 'Disallow: /api/', 'Sitemap: https://pixelkingdomwars.com/sitemap.xml', 'ROBOTS 200',
    ]));
    expect(robotsBlock).toContain('header Content-Type "text/plain; charset=utf-8"');
    expect(caddy.slice(sitemap, sitemap + 120)).toContain('respond 404');
    expect(caddy).toContain('X-Robots-Tag "noindex, nofollow, noarchive, nosnippet"');
  });
});

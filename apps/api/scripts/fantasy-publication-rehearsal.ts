/** Private loopback-only publishing rehearsal. Uses the actual sweep and SigV4
 * writer; never starts the chain URI synchronizer or changes a bucket policy. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { FANTASY_CATALOG_HASH } from '@shardkeep/shared/fantasyWorld';
import { createDb } from '../src/db/client';
import { baseRenderAvailable } from '../src/game/baseRender';
import { publishedDeedDoc, r2Putter, sweepDeedMetadata, type R2Config } from '../src/game/deedR2';

const [runtimeFile, outputDirectory] = process.argv.slice(2);
const database = new URL(process.env.DATABASE_URL ?? 'about:blank');
if (!runtimeFile || !outputDirectory || database.hostname !== '127.0.0.1' || database.port !== '55508'
  || database.pathname !== '/fantasy_rehearsal_test') throw new Error('Requires isolated fantasy rehearsal database and private runtime/output paths');
const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8')) as Record<string, string>;
if (runtime.R2_ENDPOINT !== 'http://127.0.0.1:19090' || !runtime.R2_ACCESS_KEY_ID || !runtime.R2_SECRET_ACCESS_KEY || !runtime.REPO_ROOT) {
  throw new Error('Requires the private loopback MinIO runtime');
}
process.env.REPO_ROOT = runtime.REPO_ROOT;
process.env.MULTI_BASE_ENABLED = 'true'; process.env.FANTASY_WORLD_ENABLED = 'true';
if (!baseRenderAvailable()) throw new Error('Wait for the accepted atlas generation to finish before publication rehearsal');
const cfg: R2Config = { endpoint: runtime.R2_ENDPOINT, accessKeyId: runtime.R2_ACCESS_KEY_ID,
  secretAccessKey: runtime.R2_SECRET_ACCESS_KEY, bucket: 'fantasy-rehearsal', publicBaseUrl: `${runtime.R2_ENDPOINT}/fantasy-rehearsal` };
const storage = new AwsClient({ accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, region: 'auto', service: 's3' });
const { db, sql } = createDb(database.toString(), { max: 1 });
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
try {
  await sql`set default_transaction_read_only=on`;
  const [catalog] = await sql`select catalog_hash from fantasy_world_catalog where world_id='fantasy-v1'`;
  if (catalog?.catalog_hash !== FANTASY_CATALOG_HASH) throw new Error('Recreate the rehearsal with the current immutable catalog');
  const assigned = await sql<{ mint: string; tile: number }[]>`select b.deed_asset_id as mint,c.tile_id as tile from bases b join fantasy_land_claims c on c.base_id=b.id where c.state='assigned' order by b.deed_asset_id`;
  const held = await sql<{ mint: string }[]>`select b.deed_asset_id as mint from bases b join fantasy_land_claims c on c.base_id=b.id where c.state='held'`;
  const retired = await sql<{ mint: string }[]>`select mint_id as mint from fantasy_retirement_exclusions where mint_id is not null`;
  if (assigned.length !== 66 || held.length !== 7 || retired.length !== 11) throw new Error('Rehearsal census changed; review its scope first');
  const allowed = new Map(assigned.map(row => [row.mint, row.tile]));
  const forbidden = new Set([...held, ...retired].map(row => row.mint));
  const before = digest(JSON.stringify(await sql`select row_to_json(b) as b from bases b order by id`));
  const bucketUrl = `${cfg.endpoint}/${cfg.bucket}`;
  const existing = await storage.fetch(bucketUrl, { method: 'HEAD' });
  if (existing.status !== 404) throw new Error('Publication rehearsal requires a new empty private bucket');
  const created = await storage.fetch(bucketUrl, { method: 'PUT' });
  if (!created.ok) throw new Error(`Private bucket creation failed (${created.status})`);
  const policy = await storage.fetch(`${bucketUrl}?policy`, { method: 'GET' });
  if (policy.status !== 404) throw new Error('Private rehearsal bucket unexpectedly has a policy');

  const events: Array<{ sequence: number; key: string; sha256: string; bytes: number; verified: true }> = [];
  const imageVerified = new Set<string>();
  const put = r2Putter(cfg);
  const verifiedPut: typeof put = async (key, body, contentType) => {
    const match = /^deed\/asset\/([1-9A-HJ-NP-Za-km-z]{32,44})\.(png|json)$/.exec(key);
    const mint = match?.[1];
    if (!mint || !allowed.has(mint) || forbidden.has(mint)) throw new Error('Publisher escaped its assigned-only scope');
    if (match?.[2] === 'json') {
      if (!imageVerified.has(mint) || publishedDeedDoc(mint) !== null) throw new Error('JSON publication advanced before verified image/storage');
      const document = JSON.parse(body.toString()) as { image: string; attributes: Array<{ trait_type: string; value: unknown }> };
      const attributes = Object.fromEntries(document.attributes.map(row => [row.trait_type, row.value]));
      if (attributes.Realm !== 'Crownlands' || attributes.Tile !== `fantasy-v1 · ${allowed.get(mint)}`
        || attributes.Country !== undefined || JSON.stringify(attributes).includes('Earth')
        || !document.image.startsWith(`${bucketUrl}/deed/asset/${mint}.png?v=`)) throw new Error('Published fantasy metadata identity is incorrect');
    }
    await put(key, body, contentType);
    // r2Putter already verifies its GET before returning; independently retain
    // the exact observed body hash as the local acceptance receipt.
    const fetched = await storage.fetch(`${bucketUrl}/${key}`, { method: 'GET', headers: { 'cache-control': 'no-cache' } });
    const bytes = Buffer.from(await fetched.arrayBuffer()); const expected = typeof body === 'string' ? Buffer.from(body) : body;
    if (!fetched.ok || !bytes.equals(expected)) throw new Error('Private storage read-back mismatch');
    if (match?.[2] === 'png') imageVerified.add(mint);
    events.push({ sequence: events.length + 1, key, sha256: digest(bytes), bytes: bytes.length, verified: true });
  };
  const lastPushed = new Map<string, string>(); const lastImageHash = new Map<string, string>();
  const visited: string[] = [];
  const opts = { publicBaseUrl: cfg.publicBaseUrl, lastImageHash, pngKnown: new Map<string, boolean>(), limit: assigned.length + held.length + retired.length + 1,
    onVisit: (mint: string) => visited.push(mint) };
  const assertVisited = () => {
    if (visited.length !== assigned.length || visited.some(mint => !allowed.has(mint))) throw new Error('Publisher visited held, retired or unmigrated deeds');
  };
  const first = await sweepDeedMetadata(db, verifiedPut, lastPushed, opts);
  assertVisited();
  if (first.length !== assigned.length || events.length !== assigned.length * 2 || imageVerified.size !== assigned.length) throw new Error('First publication sweep was incomplete');
  for (const mint of first) if (publishedDeedDoc(mint) !== lastPushed.get(mint)) throw new Error('Published bytes differ from the URI-versioner input');
  const priorEvents = events.length;
  visited.length = 0;
  const second = await sweepDeedMetadata(db, verifiedPut, lastPushed, opts);
  assertVisited();
  if (second.length || events.length !== priorEvents) throw new Error('Unchanged second sweep rewrote private storage');
  process.env.FANTASY_WORLD_ENABLED = 'false'; visited.length = 0;
  const paused = await sweepDeedMetadata(db, verifiedPut, lastPushed, opts);
  assertVisited();
  if (paused.length || events.length !== priorEvents) throw new Error('Pausing sales widened publication or rewrote unchanged storage');
  const anonymous = await fetch(`${bucketUrl}/${events[0]!.key}`);
  if (anonymous.status !== 403) throw new Error('Rehearsal object is publicly readable');
  const after = digest(JSON.stringify(await sql`select row_to_json(b) as b from bases b order by id`));
  if (before !== after) throw new Error('Read-only publication changed a base');
  const output = path.resolve(outputDirectory); await fs.mkdir(output, { recursive: true });
  const report = { kind: 'private local census publication rehearsal; no production layouts imported',
    catalogHash: FANTASY_CATALOG_HASH, bucket: cfg.bucket, firstPublished: first.length, secondPublished: second.length,
    pausedPublished: paused.length, pausedVisited: visited.length,
    pngObjects: imageVerified.size, jsonObjects: first.length, retiredUploads: 0, heldUploads: 0,
    anonymousStatus: anonymous.status, databaseReadOnly: true, baseHashBefore: before, baseHashAfter: after,
    chainTransactions: 0, productionWrites: 0, publicUploads: 0, eventsDigest: digest(JSON.stringify(events)), completedAt: new Date().toISOString() };
  await fs.writeFile(path.join(output, 'publication-events.private.json'), JSON.stringify(events, null, 2) + '\n');
  await fs.writeFile(path.join(output, 'publication-receipt.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await sql.end(); }

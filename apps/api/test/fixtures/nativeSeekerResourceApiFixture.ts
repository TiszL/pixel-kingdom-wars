/** Private-pipe actual API/ledger fixture for native resource-share JVM acceptance.
 * Creates and removes one unique loopback DB; no listener, signer, worker or RPC. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import postgres from 'postgres';
import { z } from 'zod';
import { buildApp } from '../../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { sessions } from '../../src/db/schema';
import { bootstrapEconomyAllocations } from '../../src/ledger';
import { createResourceTaxFixture } from './seekerResourceClaims';
import { readSeekerResourceClaim } from '../../src/game/seekerResourceClaims';
if (process.env['NODE_ENV'] !== 'test' || process.env['PHASE_E_NATIVE_PAIRED'] !== '1') throw new Error('explicit native paired test mode required');
const url = new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL'] ?? '');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || !/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) throw new Error('disposable loopback native fixture URL required');
const database = `${url.pathname.slice(1, -5).slice(0, 40)}_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
url.pathname = `/${database}`; process.env['TEST_DATABASE_URL'] = url.toString();
for (const flag of ['PHASE_E_CATALOG_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_SEEKER_ENABLED',
  'PHASE_E_VEHICLES_ENABLED', 'PHASE_E_CHARTER_ENABLED', 'GEMS_ENABLED', 'GEMS_WALLET_BUY_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED']) process.env[flag] = 'false';
process.env['FREE_ONBOARDING'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'false'; process.env['PHASE_E_MINING_ENABLED'] = 'false'; process.env['PHASE_E_SEEKER_ENABLED'] = 'true';
const { TEST_CONFIG } = await import('../helpers');
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
let created = false, closed = false;
let connection: ReturnType<typeof createDb> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let wallet: string | undefined, sourceBaseId: string | undefined, origin: string | undefined;
const config = () => ({ ...TEST_CONFIG, DATABASE_URL: url.toString(), WEB_ORIGIN: [origin!] });
const commandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), origin: z.string().regex(/^https:\/\/localhost:\d+$/) }).strict(),
  z.object({ op: z.literal('restart'), paused: z.boolean() }).strict(),
  z.object({ op: z.literal('inspect'), key: z.uuid() }).strict(),
  z.object({ op: z.literal('request'), method: z.enum(['GET', 'POST']), url: z.string(),
    headers: z.record(z.string(), z.string()), body: z.string().optional() }).strict(),
  z.object({ op: z.literal('close') }).strict(),
]);
async function close() {
  if (closed) return; closed = true;
  try { await app?.close(); await connection?.sql.end(); if (created) await admin.unsafe(`DROP DATABASE ${database}`); }
  finally { await admin.end(); }
}
async function command(input: unknown): Promise<unknown> {
  const item = commandSchema.parse(input);
  if (item.op === 'close') { await close(); return { closed: true }; }
  if (item.op === 'start') {
    if (created || closed) throw new Error('fixture already started or closed');
    origin = item.origin; await admin.unsafe(`CREATE DATABASE ${database}`); created = true;
    connection = createDb(url.toString(), { max: 4 }); await runMigrations(connection.db);
    await bootstrapEconomyAllocations(connection.db);
    const fixture = await createResourceTaxFixture(connection.db); wallet = fixture.winner.wallet; sourceBaseId = fixture.baseId;
    const [session] = await connection.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const jwt = await issueSessionJwt(config(), wallet, session!.id);
    app = await buildApp(config(), connection.db); await app.ready();
    process.env['MULTI_BASE_ENABLED'] = 'true';
    return { wallet, sourceBaseId,
      cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` };
  }
  if (!app || !connection || !wallet || !sourceBaseId || closed) throw new Error('fixture not started');
  if (item.op === 'restart') {
    await app.close(); await connection.sql.end(); process.env['PHASE_E_SEEKER_ENABLED'] = item.paused ? 'false' : 'true'; process.env['MULTI_BASE_ENABLED'] = 'false';
    connection = createDb(url.toString(), { max: 4 }); app = await buildApp(config(), connection.db); await app.ready();
    process.env['MULTI_BASE_ENABLED'] = 'true'; return { restarted: true, paused: item.paused };
  }
  if (item.op === 'request') {
    const path = item.url.split('?')[0]!;
    const allowed = item.method === 'POST' ? path === '/api/seeker/resource-claims'
      : ['/api/me', '/api/bases', '/api/base', '/api/balances', '/api/ordinary-crafting', '/api/native/capabilities', '/api/seeker/resource-claims'].includes(path)
        || /^\/api\/seeker\/resource-claims\/by-key\/[0-9a-f-]{36}$/.test(path);
    if (!allowed) throw new Error('unexpected native purchase fixture request');
    const response = await app.inject({ method: item.method, url: item.url.slice('/api'.length), headers: item.headers,
      ...(item.body === undefined ? {} : { payload: item.body }) });
    return { status: response.statusCode, body: response.body };
  }
  const receipt = await readSeekerResourceClaim(connection.db, wallet, item.key);
  const entries = await connection.sql`select bucket,delta::text from seeker_resource_claim_entries where claim_id=${item.key}::uuid order by bucket`;
  const stock = receipt ? await connection.sql`select available::text from resource_stocks where base_id=${sourceBaseId}::uuid and resource_id=${receipt.resourceId}` : [];
  const claims = await connection.sql`select id from seeker_resource_claims where wallet=${wallet}`;
  return { receipt, entries, stock, claims: claims.map(r => r.id) };
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    try {
      process.stdout.write(`NATIVE_SEEKER_RESOURCE_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`);
      if (closed) break;
    } catch (error) {
      process.stdout.write(`NATIVE_SEEKER_RESOURCE_FIXTURE:${JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failed' })}\n`);
      process.exitCode = 1; break;
    }
  }
} finally { await close(); }

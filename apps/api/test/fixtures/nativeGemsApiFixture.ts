/** Private-pipe backend for :app:pairedGemsApiTest in the native companion.
 * No HTTP listener, wallet signer, worker or external RPC is started. The JVM
 * test forwards its real HTTPS requests into the actual authenticated API.
 * Each child creates its own fresh database; it never drops an existing DB. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { GEMS } from '@shardkeep/shared';
import { buildApp } from '../../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { accounts, ledgerEntries, ledgerTransactions, sessions } from '../../src/db/schema';
import { bootstrapEconomyAllocations, bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../../src/ledger';

if (process.env['NODE_ENV'] !== 'test' || process.env['PHASE_E_NATIVE_PAIRED'] !== '1') {
  throw new Error('native Gems fixture requires explicit paired test mode');
}
const url = new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL'] ?? '');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || !/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) {
  throw new Error('native Gems fixture requires a loopback phase_e_native_*_test database URL without options');
}
// PostgreSQL identifiers have a 63-byte limit. Reserve room for the run suffix;
// CREATE DATABASE (without IF NOT EXISTS) fails safely if a collision exists.
const database = `${url.pathname.slice(1, -5).slice(0, 40)}_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
url.pathname = `/${database}`;
process.env['TEST_DATABASE_URL'] = url.toString();
for (const flag of ['PHASE_E_CATALOG_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_MINING_ENABLED',
  'PHASE_E_SEEKER_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'PHASE_E_CHARTER_ENABLED', 'MULTI_BASE_ENABLED',
  'GEMS_WALLET_BUY_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED']) process.env[flag] = 'false';
process.env['GEMS_ENABLED'] = 'true';
const { createTestPlayer, fundTestKeep, TEST_CONFIG } = await import('../helpers');
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
let created = false;
let connection: ReturnType<typeof createDb> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let wallet: string | undefined;
let origin: string | undefined;
let closed = false;
const config = () => ({ ...TEST_CONFIG, DATABASE_URL: url.toString(), WEB_ORIGIN: [origin!] });

const commandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), origin: z.string().regex(/^https:\/\/localhost:\d+$/) }).strict(),
  z.object({ op: z.literal('restart'), paused: z.boolean() }).strict(),
  z.object({ op: z.literal('inspect'), key: z.string().uuid(), kind: z.enum(['from-keep', 'to-shards']) }).strict(),
  z.object({ op: z.literal('request'), method: z.enum(['GET', 'POST']), url: z.string(),
    headers: z.record(z.string(), z.string()), body: z.string().optional() }).strict(),
  z.object({ op: z.literal('close') }).strict(),
]);
async function close(): Promise<void> {
  if (closed) return;
  closed = true;
  try {
    await app?.close(); await connection?.sql.end();
    if (created) await admin.unsafe(`DROP DATABASE ${database}`);
  } finally { await admin.end(); }
}
async function command(input: unknown): Promise<unknown> {
  const item = commandSchema.parse(input);
  if (item.op === 'close') { await close(); return { closed: true }; }
  if (item.op === 'start') {
    if (created || closed) throw new Error('fixture already started or closed');
    origin = item.origin;
    await admin.unsafe(`CREATE DATABASE ${database}`); created = true;
    connection = createDb(url.toString(), { max: 4 });
    await runMigrations(connection.db);
    await bootstrapEconomyAllocations(connection.db);
    const player = await createTestPlayer(connection.db); wallet = player.wallet;
    await fundTestKeep(connection.db, wallet, 20n, 'test.fund', randomUUID());
    const sys = await bootstrapSystemAccounts(connection.db);
    const accountIds: Record<string, string> = { emission_pool: sys.emission_pool, gems_mint: sys.gems_mint,
      gems_sink: sys.gems_sink, shard_genesis: sys.shard_genesis };
    for (const kind of ['player_keep', 'player_gems', 'player_shards'] as const) {
      accountIds[kind] = (await getOrCreatePlayerAccount(connection.db, wallet, kind)).id;
    }
    const [session] = await connection.db.insert(sessions).values({ wallet,
      expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const jwt = await issueSessionJwt(config(), wallet, session!.id);
    app = await buildApp(config(), connection.db); await app.ready();
    return { wallet, gemsPerKeep: GEMS.gemsPerKeep, accountIds,
      cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` };
  }
  if (!app || !connection || !wallet || closed) throw new Error('fixture not started');
  if (item.op === 'restart') {
    await app.close(); await connection.sql.end();
    process.env['GEMS_ENABLED'] = item.paused ? 'false' : 'true';
    connection = createDb(url.toString(), { max: 4 });
    app = await buildApp(config(), connection.db); await app.ready();
    return { restarted: true, paused: item.paused };
  }
  if (item.op === 'request') {
    const path = item.url.split('?')[0]!;
    const allowed = item.method === 'POST' ? ['/api/gems/from-keep', '/api/gems/to-shards'].includes(path)
      : ['/api/me', '/api/bases', '/api/balances', '/api/native/capabilities', '/api/gems', '/api/gems/to-shards/receipt'].includes(path)
        || /^\/api\/gems\/from-keep\/by-key\/[0-9a-f-]{36}$/.test(path);
    if (!allowed) throw new Error('unexpected native Gems fixture request');
    // The public HTTPS origin mounts Fastify at /api; the production reverse
    // proxy strips that prefix before forwarding to the application.
    const response = await app.inject({ method: item.method, url: item.url.slice('/api'.length), headers: item.headers,
      ...(item.body === undefined ? {} : { payload: item.body }) });
    return { status: response.statusCode, body: response.body };
  }
  const transactions = await connection.db.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
    .where(eq(ledgerTransactions.idempotencyKey, `gems:${item.kind}:${wallet}:${item.key}`));
  const entries = transactions.length === 0 ? [] : await connection.db.select({
    accountId: accounts.id, kind: accounts.kind, currency: accounts.currency, ownerWallet: accounts.ownerWallet,
    baseId: accounts.baseId, delta: ledgerEntries.delta,
  }).from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId))
    .where(eq(ledgerEntries.txnId, transactions[0]!.id));
  const balance = async (kind: 'player_keep' | 'player_gems' | 'player_shards') =>
    (await getOrCreatePlayerAccount(connection!.db, wallet!, kind)).balance.toString();
  return { transactions: transactions.map(row => row.id), entries: entries.map(row => ({ ...row, delta: row.delta.toString() })),
    balances: { keep: await balance('player_keep'), gems: await balance('player_gems'), shards: await balance('player_shards') } };
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    try {
      const reply = await command(JSON.parse(line));
      process.stdout.write(`NATIVE_GEMS_FIXTURE:${JSON.stringify(reply)}\n`);
      if (closed) break;
    } catch (error) {
      process.stdout.write(`NATIVE_GEMS_FIXTURE:${JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failure' })}\n`);
      process.exitCode = 1; break;
    }
  }
} finally { await close(); }

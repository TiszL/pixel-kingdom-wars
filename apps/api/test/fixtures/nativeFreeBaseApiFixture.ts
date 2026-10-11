/** Private-pipe actual API/ledger fixture for native second-base JVM acceptance.
 * Creates and removes one unique loopback DB; no listener, signer, worker or RPC. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { PHASE_E_FREE_BASE_POLICY, PHASE_E_POLICY } from '@shardkeep/shared';
import postgres from 'postgres';
import { z } from 'zod';
import { buildApp } from '../../src/app';
import { createFreeBasePurchaseProvider } from '../../src/game/freeBasePurchaseRoutes';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { sessions } from '../../src/db/schema';
import { bootstrapEconomyAllocations } from '../../src/ledger';
import { rewardBaseShards, spendBaseShards } from '../../src/game/baseEconomy';
import { getFreeBasePurchase } from '../../src/mining/freeBasePurchase';
if (process.env['NODE_ENV'] !== 'test' || process.env['PHASE_E_NATIVE_PAIRED'] !== '1') throw new Error('explicit native paired test mode required');
const url = new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL'] ?? '');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || !/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) throw new Error('disposable loopback native fixture URL required');
const database = `${url.pathname.slice(1, -5).slice(0, 40)}_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`;
url.pathname = `/${database}`; process.env['TEST_DATABASE_URL'] = url.toString();
for (const flag of ['PHASE_E_CATALOG_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'PHASE_E_SEEKER_ENABLED',
  'PHASE_E_VEHICLES_ENABLED', 'PHASE_E_CHARTER_ENABLED', 'GEMS_ENABLED', 'GEMS_WALLET_BUY_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED']) process.env[flag] = 'false';
process.env['FREE_ONBOARDING'] = 'true'; process.env['MULTI_BASE_ENABLED'] = 'true'; process.env['PHASE_E_MINING_ENABLED'] = 'true';
const { createTestPlayer, TEST_CONFIG } = await import('../helpers');
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
  z.object({ op: z.literal('drain-source') }).strict(),
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
    wallet = (await createTestPlayer(connection.db)).wallet; sourceBaseId = randomUUID();
    await connection.sql`insert into bases(id,owner_wallet,keep_level) values(${sourceBaseId},${wallet},${PHASE_E_FREE_BASE_POLICY.minKeepLevel})`;
    await connection.sql`insert into base_slots(wallet,slot,base_id) values(${wallet},1,${sourceBaseId})`;
    await connection.sql`insert into buildings(player_wallet,base_id,type,level,tx,ty) values
      (${wallet},${sourceBaseId},'keep',${PHASE_E_FREE_BASE_POLICY.minKeepLevel},10,10),
      (${wallet},${sourceBaseId},'workshop',${PHASE_E_FREE_BASE_POLICY.minWorkshopLevel},20,20),
      (${wallet},${sourceBaseId},'goldforge',${PHASE_E_FREE_BASE_POLICY.minGoldForgeLevel},25,25)`;
    await rewardBaseShards(connection.db, sourceBaseId, BigInt(PHASE_E_POLICY.bases.secondFreeBaseCostShards), 'test.native_free_base', randomUUID());
    const [session] = await connection.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const jwt = await issueSessionJwt(config(), wallet, session!.id);
    app = await buildApp(config(), connection.db, { freeBasePurchaseProvider: createFreeBasePurchaseProvider(connection.db) }); await app.ready();
    return { wallet, sourceBaseId, costShards: String(PHASE_E_POLICY.bases.secondFreeBaseCostShards),
      cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` };
  }
  if (!app || !connection || !wallet || !sourceBaseId || closed) throw new Error('fixture not started');
  if (item.op === 'restart') {
    await app.close(); await connection.sql.end(); process.env['PHASE_E_MINING_ENABLED'] = item.paused ? 'false' : 'true';
    connection = createDb(url.toString(), { max: 4 }); app = await buildApp(config(), connection.db, { freeBasePurchaseProvider: createFreeBasePurchaseProvider(connection.db) }); await app.ready();
    return { restarted: true, paused: item.paused };
  }
  if (item.op === 'request') {
    const path = item.url.split('?')[0]!;
    const allowed = item.method === 'POST' ? path === '/api/bases/free-purchases'
      : ['/api/me', '/api/bases', '/api/base', '/api/balances', '/api/native/capabilities', '/api/bases/free-purchases'].includes(path)
        || /^\/api\/bases\/free-purchases\/by-key\/[0-9a-f-]{36}$/.test(path);
    if (!allowed) throw new Error('unexpected native purchase fixture request');
    const response = await app.inject({ method: item.method, url: item.url.slice('/api'.length), headers: item.headers,
      ...(item.body === undefined ? {} : { payload: item.body }) });
    return { status: response.statusCode, body: response.body };
  }
  const [account] = await connection.sql`select id,balance::text from accounts where base_id=${sourceBaseId} and kind='base_shards'`;
  if (item.op === 'drain-source') {
    if (account && BigInt(account.balance) > 0n) await spendBaseShards(connection.db, sourceBaseId, BigInt(account.balance), 'test.native_spend', randomUUID(), {}, { progressQuests: false });
    return { drained: true };
  }
  const receipt = await getFreeBasePurchase(connection.db, wallet, item.key);
  const transactions = await connection.sql`select id from ledger_transactions where idempotency_key=${`free-base:${wallet}:${item.key}`}`;
  const entries = receipt ? await connection.sql`select a.id as "accountId",a.kind,a.currency,a.owner_wallet as "ownerWallet",a.base_id as "baseId",e.delta::text
    from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=${receipt.debitTransactionId} order by a.kind::text` : [];
  const bases = await connection.sql`select id from bases where owner_wallet=${wallet} order by id`;
  return { receipt, transactions: transactions.map(r => r.id), entries, sourceShards: account?.balance ?? '0', bases: bases.map(r => r.id) };
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    try {
      process.stdout.write(`NATIVE_FREE_BASE_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`);
      if (closed) break;
    } catch (error) {
      process.stdout.write(`NATIVE_FREE_BASE_FIXTURE:${JSON.stringify({ error: error instanceof Error ? error.message : 'fixture failed' })}\n`);
      process.exitCode = 1; break;
    }
  }
} finally { await close(); }

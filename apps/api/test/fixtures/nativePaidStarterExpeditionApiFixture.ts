/** Private-pipe native acceptance against actual authenticated API/SQL guards.
 * Synthetic finalized account/transaction bytes use the genuine term and access
 * adapters. Own disposable loopback DB only; no listener, live RPC or worker. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import postgres from 'postgres';
import { z } from 'zod';
if (process.env['NODE_ENV'] !== 'test' || process.env['PHASE_E_NATIVE_PAIRED'] !== '1') throw Error('Explicit native paired test mode required');
const url = new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL'] ?? '');
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  || !/^\/phase_e_native_[a-z0-9_]+_test$/.test(url.pathname) || url.search || url.hash) throw Error('Disposable loopback fixture URL required');
const database = `phase_e_native_paid_${randomUUID().replaceAll('-', '').slice(0, 12)}_test`; url.pathname = `/${database}`;
process.env['TEST_DATABASE_URL'] = url.toString();
for (const flag of ['FREE_ONBOARDING', 'MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'STARTER_EXPEDITIONS_ENABLED']) process.env[flag] = 'true';
for (const flag of ['PHASE_E_CATALOG_ENABLED', 'PHASE_E_SEEKER_ENABLED', 'PHASE_E_MINING_ENABLED', 'PHASE_E_VEHICLES_ENABLED',
  'PHASE_E_CHARTER_ENABLED', 'GEMS_ENABLED', 'GEMS_WALLET_BUY_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED']) process.env[flag] = 'false';
// Date alone advances; actual network deadlines and JVM timeouts keep real timers.
const RealDate = Date; let now = RealDate.parse('2035-01-01T01:00:00.000Z');
globalThis.Date = new Proxy(RealDate, {
  construct: (target, args, newTarget) => Reflect.construct(target, args.length ? args : [now], newTarget),
  apply: () => new RealDate(now).toString(),
  get: (target, property, receiver) => property === 'now' ? () => now : Reflect.get(target, property, receiver),
});
const { createSeekerRealmAccessFixture } = await import('../../../../packages/chain/src/testFixtures/seekerRealmAccess');
const { createMiningTermFixture } = await import('../../../../packages/chain/src/testFixtures/miningZeroWinnerTerm');
const { buildApp } = await import('../../src/app'); const { createDb } = await import('../../src/db/client');
const { runMigrations } = await import('../../src/db/migrate'); const { players, sessions } = await import('../../src/db/schema');
const { bootstrapEconomyAllocations, getOrCreatePlayerAccount } = await import('../../src/ledger');
const { createStarterExpeditionFixture } = await import('./starterExpeditions');
const { readOwnedStarterExpedition } = await import('../../src/game/starterExpeditionDispatch');
const { settleDueStarterExpeditions } = await import('../../src/game/starterExpeditionReturns');
const { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } = await import('../../src/auth/session');
const { TEST_CONFIG } = await import('../helpers');
const commandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), origin: z.string().regex(/^https:\/\/localhost:\d+$/) }).strict(),
  z.object({ op: z.literal('request'), method: z.enum(['GET', 'POST']), url: z.string().max(256),
    headers: z.record(z.string(), z.string()), body: z.string().max(32768).optional() }).strict(),
  z.object({ op: z.literal('restart'), paused: z.boolean() }).strict(),
  z.object({ op: z.literal('advance'), key: z.uuid() }).strict(),
  z.object({ op: z.literal('inspect'), key: z.uuid() }).strict(), z.object({ op: z.literal('close') }).strict(),
]);
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
let created = false, closed = false, roleCreated = false, origin = '', baseId = '', posts = 0;
const role = `native_paid_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
const runtimeUrl = new URL(url); runtimeUrl.username = role; runtimeUrl.password = password;
let owner: ReturnType<typeof createDb> | undefined, runtime: ReturnType<typeof createDb> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
const wallet = Keypair.generate().publicKey.toBase58(), bank = await createSeekerRealmAccessFixture(), realm = 0;
const [address, bump] = PublicKey.findProgramAddressSync([Buffer.from('realm_access'), new PublicKey(wallet).toBuffer(), Buffer.of(realm)], bank.programId);
const BN = bank.accessModel.expires_at.constructor as new (n: string) => typeof bank.accessModel.expires_at;
bank.accessModel.wallet = new PublicKey(wallet); bank.accessModel.bump = bump;
bank.accessModel.expires_at = new BN(String(Math.floor(now / 1000) + 60)); bank.rows[3]!.address = address;
await bank.encode('access'); bank.rows[4]!.data.writeBigInt64LE(BigInt(Math.floor(now / 1000)), 32); bank.rows[5] = null;
const term = await createMiningTermFixture({ day: '2035-01-01', genesisHash: bank.genesis, programId: bank.programId,
  programData: bank.rows[1]!.data, programDataAddress: bank.rows[1]!.address, upgradeAuthority: bank.upgradeAuthority,
  winners: [{ spotId: 0, wallet: Keypair.generate().publicKey }] });
term.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(now / 1000)), 32);
const config = () => ({ ...TEST_CONFIG, DATABASE_URL: runtimeUrl.toString(), WEB_ORIGIN: [origin] });
async function startApp(paused: boolean) {
  process.env['STARTER_EXPEDITIONS_ENABLED'] = paused ? 'false' : 'true';
  runtime = createDb(runtimeUrl.toString(), { max: 4 });
  app = await buildApp(config(), runtime.db, paused ? {} : {
    starterExpeditionProvider: { policy: term.policy, connect: term.connect },
    starterExpeditionAccessProvider: { trust: bank.trust, connect: () => bank.rpc },
  }); await app.ready();
}
async function close() {
  if (closed) return; closed = true;
  try {
    await app?.close(); await runtime?.sql.end();
    if (roleCreated && owner) await owner.sql.unsafe(`drop owned by ${role}; drop role ${role}`);
    await owner?.sql.end(); if (created) await admin.unsafe(`drop database ${database}`);
  } finally { await admin.end(); globalThis.Date = RealDate; }
}
async function command(input: unknown): Promise<unknown> {
  const item = commandSchema.parse(input);
  if (item.op === 'close') { await close(); return { closed: true }; }
  if (item.op === 'start') {
    if (created || closed) throw Error('Already started'); origin = item.origin;
    await admin.unsafe(`create database ${database}`); created = true;
    owner = createDb(url.toString(), { max: 4 }); await runMigrations(owner.db); await bootstrapEconomyAllocations(owner.db);
    await owner.db.insert(players).values({ wallet }); await getOrCreatePlayerAccount(owner.db, wallet, 'player_keep');
    const f = await createStarterExpeditionFixture(owner.db, { wallet, now: new Date() }); baseId = f.baseId;
    const [session] = await owner.db.insert(sessions).values({ wallet, expiresAt: new Date(now + SESSION_TTL_SEC * 1000) }).returning();
    // Current game snapshots drain normal completion paths under row locks. The
    // runtime role has ordinary DML only, no owner/DDL/TRUNCATE/trigger bypass.
    await owner.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
      grant select,insert,update,delete on all tables in schema public to ${role}`); roleCreated = true;
    await startApp(false);
    const [permissions] = await runtime!.sql`select rolsuper,rolbypassrls,has_table_privilege(current_user,'starter_expeditions','TRUNCATE') as can_truncate from pg_roles where rolname=current_user`;
    if (!permissions || permissions.rolsuper || permissions.rolbypassrls || permissions.can_truncate) throw Error('Fixture runtime privileges are too broad');
    const jwt = await issueSessionJwt(config(), wallet, session!.id);
    return { wallet, baseId, cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` };
  }
  if (!app || !runtime || !owner || closed) throw Error('Fixture not started');
  if (item.op === 'restart') { await app.close(); await runtime.sql.end(); await startApp(item.paused); return { restarted: true, paused: item.paused }; }
  if (item.op === 'request') {
    const path = item.url.split('?')[0]!;
    const allowed = item.method === 'POST' ? item.url === '/api/starter-expeditions'
      : ['/api/me', '/api/bases', '/api/starter-expeditions', '/api/starter-expeditions/paid-route'].includes(path)
        || /^\/api\/starter-expeditions\/by-key\/[0-9a-f-]{36}$/.test(item.url);
    if (!allowed) throw Error('Unexpected native paid expedition path');
    if (item.method === 'POST') posts++;
    const response = await app.inject({ method: item.method, url: item.url.slice('/api'.length), headers: item.headers,
      ...(item.body === undefined ? {} : { payload: item.body }) });
    return { status: response.statusCode, body: response.body };
  }
  const trip = await readOwnedStarterExpedition(runtime.db, wallet, item.key);
  if (!trip || trip.baseId !== baseId || !('access' in trip.routeSnapshot) || trip.routeSnapshot.access.kind !== 'paid_realm') throw Error('Original paid departure is missing');
  if (item.op === 'advance') {
    now = trip.returnsAt.getTime();
    const afterCoverageExpiry = BigInt(Math.floor(now / 1000)) > BigInt(trip.routeSnapshot.access.observation.expiresAt);
    if (!afterCoverageExpiry) throw Error('Fixture return must follow coverage expiry');
    await runtime.db.transaction(tx => settleDueStarterExpeditions(tx, baseId, new Date()));
    return { afterCoverageExpiry };
  }
  const entries = await runtime.sql`select e.bucket,e.delta::text from starter_expedition_entries e join starter_expedition_returns r on r.id=e.return_id where r.expedition_id=${item.key}::uuid order by e.bucket`;
  const [counts] = await runtime.sql`select
    (select count(*)::integer from starter_expeditions where actor_wallet=${wallet}) as departures,
    (select count(*)::integer from starter_expedition_returns where expedition_id=${item.key}::uuid) as returns,
    (select count(*)::integer from starter_expedition_inflight where expedition_id=${item.key}::uuid) as inflight`;
  const [stock] = await runtime.sql`select available::text from resource_stocks where base_id=${baseId}::uuid and resource_id=${trip.resourceId}`;
  return { ...counts, posts, entries, stock: stock?.available };
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const line of lines) {
    try { process.stdout.write(`NATIVE_PAID_STARTER_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`); if (closed) break; }
    catch (error) { process.stdout.write(`NATIVE_PAID_STARTER_FIXTURE:${JSON.stringify({ error: error instanceof Error ? error.message : 'Fixture failed' })}\n`); process.exitCode = 1; break; }
  }
} finally { await close(); lines.close(); }

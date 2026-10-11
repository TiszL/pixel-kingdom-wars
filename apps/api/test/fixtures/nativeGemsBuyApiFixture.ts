/** Native wallet-buy paired fixture: private pipes, disposable database and
 * injected chain authority only. No listener, real RPC or persisted keypair. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { mock } from 'node:test';
import postgres from 'postgres';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import bs58 from 'bs58';
import { keepAta } from '@shardkeep/chain';
import { Connection, Keypair, PublicKey, Transaction } from '@solana/web3.js';
import { ECONOMY, GEMS, LAND_CHECKOUT_RECOVERY, SEEKER, TOKEN } from '@shardkeep/shared';
import { buildApp } from '../../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createDb } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { accounts, deposits, ledgerEntries, ledgerTransactions, players, sessions } from '../../src/db/schema';
import { bootstrapEconomyAllocations, bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../../src/ledger';
import { makeCombinedDepositCommitVerifier, makeCombinedDepositVerifier } from '../../src/money/depositWatcher';
import { SPL_TOKEN_PROGRAM_ID } from '../../src/money/reserves';
import { bindGemsTestReserve, gemsTestAta, gemsTestHot, gemsTestMint } from '../gems-reserve-fixture';

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
  'DEVNET_WELCOME_GEMS_ENABLED']) process.env[flag] = 'false';
process.env['GEMS_ENABLED'] = 'true';
process.env['GEMS_WALLET_BUY_ENABLED'] = 'true';
process.env['GEMS_RESERVE_ATA'] = gemsTestAta.toBase58();
const { TEST_CONFIG } = await import('../helpers');
const adminUrl = new URL(url); adminUrl.pathname = '/postgres';
const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} });
let created = false;
let connection: ReturnType<typeof createDb> | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let wallet: string | undefined;
let origin: string | undefined;
let closed = false;
const config = () => ({ ...TEST_CONFIG, DATABASE_URL: url.toString(), WEB_ORIGIN: [origin!] });

const UNIT = 10n ** BigInt(TOKEN.decimals), endpoint = 'https://native-gems-fixture.invalid';
const blockhash = Keypair.generate().publicKey.toBase58();
let finalized = true, walletKeep = 20n;
const landed = new Map<string, { keys: PublicKey[]; reference: PublicKey; source: PublicKey; amount: bigint; time: number }>();
const remaining = () => walletKeep - [...landed.values()].reduce((sum, tx) => sum + tx.amount / UNIT, 0n);
// getWalletBalances' route exposes URLs, not its connectionFactory. Deny the
// Connection method surface inside this disposable child before allowing its
// two reads. _rpcRequest is an OWN INSTANCE FIELD in pinned web3.js, so mocking
// that name on the prototype would neither install nor guard the transport.
const methods = Connection.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(Connection.prototype))) {
  if (name === 'constructor' || typeof descriptor.value !== 'function') continue;
  mock.method(methods, name, () => { throw new Error(`native fixture forbids Connection.${name}`); });
}
// Pinned Connection's constructor only creates lazy RPC clients and binds WS
// callbacks with autoconnect:false; it invokes no Connection prototype method.
// Accessors (including rpcEndpoint) remain intact. The constructor-owned
// getBlockHeight closure also fails at the now-blocked _buildArgs method.
const deniedProbe = new Connection(endpoint, 'confirmed');
assert.equal(deniedProbe.rpcEndpoint, endpoint);
assert.throws(() => deniedProbe.getSlot(), /native fixture forbids Connection\.getSlot/);
await assert.rejects(() => deniedProbe.getBlockHeight(), /native fixture forbids Connection\._buildArgs/);
mock.method(Connection.prototype, 'getBalance', async function (this: Connection, owner: PublicKey) {
  assert.equal(this.rpcEndpoint, endpoint); assert.equal(owner.toBase58(), wallet); return 100_000;
});
mock.method(Connection.prototype, 'getParsedTokenAccountsByOwner', async function (this: Connection, owner: PublicKey, filter: { programId?: PublicKey }) {
  assert.equal(this.rpcEndpoint, endpoint); assert.equal(owner.toBase58(), wallet);
  assert(filter.programId?.equals(SPL_TOKEN_PROGRAM_ID) || filter.programId?.toBase58() === SEEKER.sgt.tokenProgram,
    'fixture refuses an unsupported token-program balance read');
  return { context: { slot: 1 }, value: filter.programId?.equals(SPL_TOKEN_PROGRAM_ID)
    ? [{ account: { data: { parsed: { info: { mint: gemsTestMint.toBase58(), tokenAmount: { uiAmount: Number(remaining()) } } } } } }] : [] };
});
const chain = {
  getSignaturesForAddress: async (reference: PublicKey) => [...landed].filter(([, tx]) => tx.reference.equals(reference))
    .map(([signature, tx]) => ({ signature, err: null, blockTime: tx.time })),
  getTransaction: async (signature: string, options: { commitment: string }) => {
    const tx = landed.get(signature); if (!tx || options.commitment === 'finalized' && !finalized) return null;
    const balances = [
      { accountIndex: tx.keys.findIndex(key => key.equals(tx.source)), pre: walletKeep * UNIT, post: walletKeep * UNIT - tx.amount },
      { accountIndex: tx.keys.findIndex(key => key.equals(gemsTestAta)), pre: 100n * UNIT, post: 100n * UNIT + tx.amount },
    ];
    return { transaction: { message: { staticAccountKeys: tx.keys } }, meta: { err: null,
      preTokenBalances: balances.map(b => ({ accountIndex: b.accountIndex, mint: gemsTestMint.toBase58(), uiTokenAmount: { amount: String(b.pre) } })),
      postTokenBalances: balances.map(b => ({ accountIndex: b.accountIndex, mint: gemsTestMint.toBase58(), uiTokenAmount: { amount: String(b.post) } })),
    } };
  },
} as unknown as Connection;
async function startApp() {
  const treasury = { liquidity: null, hot: { keepMint: gemsTestMint, pubkey: gemsTestHot } };
  app = await buildApp(config(), connection!.db, {
    keepDeposit: { hotWalletAta: keepAta(gemsTestHot, gemsTestMint).toBase58(), keepMint: gemsTestMint.toBase58(), decimals: TOKEN.decimals },
    walletHub: { gameRpcUrl: endpoint },
    depositVerifier: makeCombinedDepositVerifier(chain, treasury),
    depositPaymentCommitVerifier: makeCombinedDepositCommitVerifier(chain, treasury),
  });
  await app.ready();
}
const schema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), origin: z.string().regex(/^https:\/\/localhost:\d+$/), wallet: z.string(), finalized: z.boolean(), walletKeep: z.number().int().min(0).max(100) }).strict(),
  z.object({ op: z.literal('restart'), paused: z.boolean() }).strict(),
  z.object({ op: z.literal('inspect') }).strict(), z.object({ op: z.literal('finalize') }).strict(),
  z.object({ op: z.literal('rpc'), request: z.object({ jsonrpc: z.literal('2.0'), id: z.number(), method: z.string(), params: z.array(z.unknown()) }).strict() }).strict(),
  z.object({ op: z.literal('request'), method: z.enum(['GET', 'POST']), url: z.string(), headers: z.record(z.string(), z.string()), body: z.string().optional() }).strict(),
]);
async function close() {
  if (closed) return; closed = true;
  try { await app?.close(); await connection?.sql.end(); if (created) await admin.unsafe(`DROP DATABASE ${database}`); }
  finally { mock.restoreAll(); await admin.end(); }
}
async function command(raw: unknown): Promise<unknown> {
  const c = schema.parse(raw);
  if (c.op === 'start') {
    assert(!created && !closed); new PublicKey(c.wallet);
    wallet = c.wallet; origin = c.origin; finalized = c.finalized; walletKeep = BigInt(c.walletKeep);
    await admin.unsafe(`CREATE DATABASE ${database}`); created = true;
    connection = createDb(url.toString(), { max: 4 });
    await runMigrations(connection.db); await bootstrapEconomyAllocations(connection.db); await bindGemsTestReserve(connection.db);
    await connection.db.insert(players).values({ wallet });
    const sys = await bootstrapSystemAccounts(connection.db);
    const accountIds: Record<string, string> = { onchain_inflow: sys.onchain_inflow, emission_pool: sys.emission_pool, gems_mint: sys.gems_mint };
    for (const kind of ['player_keep', 'player_gems', 'player_shards'] as const) accountIds[kind] = (await getOrCreatePlayerAccount(connection.db, wallet, kind)).id;
    const [session] = await connection.db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
    const jwt = await issueSessionJwt(config(), wallet, session!.id); await startApp();
    return { mint: gemsTestMint.toBase58(), accountIds, catalogue: { constants: { TOKEN, ECONOMY, LAND_CHECKOUT_RECOVERY } },
      cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` };
  }
  assert(app && connection && wallet && !closed);
  if (c.op === 'restart') {
    await app.close(); await connection.sql.end();
    process.env['GEMS_ENABLED'] = process.env['GEMS_WALLET_BUY_ENABLED'] = c.paused ? 'false' : 'true';
    connection = createDb(url.toString(), { max: 4 });
    await bindGemsTestReserve(connection.db); await startApp(); return { restarted: true };
  }
  if (c.op === 'finalize') { finalized = true; return { finalized }; }
  if (c.op === 'request') {
    const path = c.url.split('?')[0]!;
    const allowed = c.method === 'POST' ? path === '/api/deposits' || /^\/api\/deposits\/[0-9a-f-]{36}\/(paid|verify)$/.test(path)
      : ['/api/me', '/api/bases', '/api/balances', '/api/wallet/balances', '/api/native/capabilities'].includes(path)
        || /^\/api\/gems\/buy\/by-key\/[0-9a-f-]{36}$/.test(path);
    assert(allowed, 'unexpected native wallet-buy API request');
    const response = await app.inject({ method: c.method, url: c.url.slice('/api'.length), headers: c.headers,
      ...(c.body === undefined ? {} : { payload: c.body }) });
    return { status: response.statusCode, body: response.body };
  }
  if (c.op === 'rpc') {
    const { method, params, id } = c.request; let result: unknown;
    switch (method) {
      case 'getGenesisHash': result = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'; break;
      case 'getLatestBlockhash': result = { value: { blockhash, lastValidBlockHeight: 123 } }; break;
      case 'getBlockHeight': result = 100; break;
      case 'getFeeForMessage': result = { value: 5000 }; break;
      case 'getBalance': assert.equal(params[0], wallet); result = { value: 100_000 }; break;
      case 'getTokenAccountBalance':
        assert.equal(params[0], keepAta(new PublicKey(wallet), gemsTestMint).toBase58());
        result = { value: { decimals: TOKEN.decimals, amount: String(remaining() * UNIT) } }; break;
      case 'sendTransaction': {
        assert.deepEqual(params[1], { encoding: 'base64', skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 0 });
        assert.equal(typeof params[0], 'string'); const tx = Transaction.from(Buffer.from(params[0] as string, 'base64'));
        assert(tx.verifySignatures()); assert.equal(tx.feePayer?.toBase58(), wallet); assert.equal(tx.recentBlockhash, blockhash);
        assert.equal(tx.instructions.length, 1); const ix = tx.instructions[0]!;
        assert(ix.programId.equals(SPL_TOKEN_PROGRAM_ID));
        assert.equal(ix.data.length, 10); assert.equal(ix.data[0], 12); assert.equal(ix.data[9], TOKEN.decimals); assert.equal(ix.keys.length, 5);
        const source = keepAta(new PublicKey(wallet), gemsTestMint), reference = ix.keys[4]!.pubkey;
        assert.deepEqual(ix.keys.slice(0, 4).map(k => k.pubkey.toBase58()), [source.toBase58(), gemsTestMint.toBase58(), gemsTestAta.toBase58(), wallet]);
        const [dep] = await connection.db.select().from(deposits).where(eq(deposits.reference, reference.toBase58()));
        assert(dep && dep.playerWallet === wallet && dep.kind === 'gems_buy' && dep.status === 'pending');
        const amount = ix.data.readBigUInt64LE(1); assert.equal(amount, BigInt((dep.payload as { keepIn: number }).keepIn) * UNIT);
        assert(amount <= remaining() * UNIT); const signature = bs58.encode(tx.signatures[0]!.signature!); assert(!landed.has(signature));
        landed.set(signature, { keys: tx.compileMessage().accountKeys, source, reference, amount, time: Math.ceil(dep.createdAt.getTime() / 1000) + 1 });
        result = signature; break;
      }
      default: throw new Error(`unexpected fixture RPC ${method}`);
    }
    return { jsonrpc: '2.0', id, result };
  }
  const rows = await connection.db.select().from(deposits).where(eq(deposits.playerWallet, wallet));
  const credits = rows.length ? await connection.db.select({ id: ledgerTransactions.id }).from(ledgerTransactions)
    .where(inArray(ledgerTransactions.idempotencyKey, rows.map(row => `deposit:${row.id}:credit`))) : [];
  const entries = credits.length ? await connection.db.select({ accountId: accounts.id, kind: accounts.kind, currency: accounts.currency,
    ownerWallet: accounts.ownerWallet, baseId: accounts.baseId, delta: ledgerEntries.delta }).from(ledgerEntries)
    .innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(inArray(ledgerEntries.txnId, credits.map(row => row.id))) : [];
  return { depositCount: rows.length, credits: credits.map(row => row.id), entries: entries.map(row => ({ ...row, delta: String(row.delta) })),
    keep: String((await getOrCreatePlayerAccount(connection.db, wallet, 'player_keep')).balance),
    gems: String((await getOrCreatePlayerAccount(connection.db, wallet, 'player_gems')).balance) };
}
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    try { process.stdout.write(`NATIVE_GEMS_BUY_FIXTURE:${JSON.stringify(await command(JSON.parse(line)))}\n`); }
    catch (e) { process.stdout.write(`NATIVE_GEMS_BUY_FIXTURE:${JSON.stringify({ error: e instanceof Error ? e.message : 'fixture failed' })}\n`); process.exitCode = 1; break; }
  }
} finally { await close(); }

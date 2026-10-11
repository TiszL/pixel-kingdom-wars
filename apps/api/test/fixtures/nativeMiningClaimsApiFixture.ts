/** Private-pipe native JVM acceptance: real claim API + restricted runtime DB;
 * generated local signer and serialized finalized bank/transaction evidence only. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { PHASE_E_MINING_CLAIM_QUOTE, TOKEN } from '@shardkeep/shared';
import { z } from 'zod';
if (process.env['NODE_ENV'] !== 'test' || process.env['PHASE_E_NATIVE_PAIRED'] !== '1') throw Error('explicit native paired test mode required');
const inputUrl = new URL(process.env['PHASE_E_NATIVE_TEST_DATABASE_URL'] ?? '');
if (!['postgres:', 'postgresql:'].includes(inputUrl.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(inputUrl.hostname)
  || !/^\/phase_e_native_[a-z0-9_]+_test$/.test(inputUrl.pathname) || inputUrl.search || inputUrl.hash) throw Error('disposable loopback fixture URL required');
process.env['TEST_DATABASE_URL'] = inputUrl.toString();
const adminUrl = new URL(inputUrl); adminUrl.pathname = '/postgres'; process.env['TEST_ADMIN_DATABASE_URL'] = adminUrl.toString();
for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_CATALOG_ENABLED', 'PHASE_E_SEEKER_ENABLED', 'PHASE_E_VEHICLES_ENABLED', 'PHASE_E_CHARTER_ENABLED',
  'GEMS_ENABLED', 'GEMS_WALLET_BUY_ENABLED', 'DEVNET_WELCOME_GEMS_ENABLED']) process.env[flag] = 'false';
const { withMiningClaimSettlementFixture } = await import('./miningClaimSettlement');
const { buildApp } = await import('../../src/app');
const { createDb } = await import('../../src/db/client');
const { sessions } = await import('../../src/db/schema');
const { createMiningClaimFailure } = await import('../../src/mining/claimFailure');
const { createMiningClaimSettlement } = await import('../../src/mining/claimSettlement');
const { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } = await import('../../src/auth/session');
const { TEST_CONFIG } = await import('../helpers');
const commands = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), origin: z.string().regex(/^https:\/\/localhost:\d+$/) }).strict(),
  z.object({ op: z.literal('request'), method: z.enum(['GET', 'POST']), url: z.string().max(256), headers: z.record(z.string(), z.string()), body: z.string().max(32768).optional() }).strict(),
  z.object({ op: z.literal('sign'), unsigned: z.string().max(1644) }).strict(),
  z.object({ op: z.literal('settle'), claimId: z.uuid() }).strict(),
  z.object({ op: z.literal('fail'), claimId: z.uuid() }).strict(),
  z.object({ op: z.literal('freshBlockhash') }).strict(),
  z.object({ op: z.literal('restart'), paused: z.boolean() }).strict(),
  z.object({ op: z.literal('inspect') }).strict(), z.object({ op: z.literal('close') }).strict(),
]);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity }), iterator = lines[Symbol.asyncIterator]();
const reply = (body: unknown) => process.stdout.write(`NATIVE_MINING_CLAIMS_FIXTURE:${JSON.stringify(body)}\n`);
let stopped = false;
try {
  const first = await iterator.next(); if (first.done) throw Error('start required');
  const start = commands.parse(JSON.parse(first.value)); if (start.op !== 'start') throw Error('start required');
  await withMiningClaimSettlementFixture(async f => {
    f.quote.reader.getLatestBlockhashAndContext = async () => ({ context: { slot: 3003 }, value: { blockhash: f.preparedClaim.blockhash, lastValidBlockHeight: 250 } });
    f.quote.reader.getFeeForMessage = async () => ({ context: { slot: 3003 }, value: 5000 }); f.quote.reader.getSlot = async () => 3003;
    const role = `native_claim_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    await f.conn.sql.unsafe(`create role ${role} login password '${password}'; grant usage on schema public to ${role};
      grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
      grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
    const runtimeUrl = new URL(f.url); runtimeUrl.username = role; runtimeUrl.password = password;
    let runtime = createDb(runtimeUrl.toString(), { max: 4 }), sends = 0, signatures = 0, preparePosts = 0, submitPosts = 0;
    const config = { ...TEST_CONFIG, DATABASE_URL: runtimeUrl.toString(), WEB_ORIGIN: [start.origin] };
    const provider = { reader: f.bank.reader, trust: f.bank.trust, quoteSource: () => f.quote.reader, now: () => new Date(f.preparedClaim.preparedAt),
      transport: () => ({ getGenesisHash: async () => f.identity.genesisHash,
        getSignatureStatuses: async () => ({ context: { slot: 3003 }, value: [null] }), getBlockHeight: async () => 200,
        sendRawTransaction: async (bytes: Uint8Array) => {
          if (!Buffer.from(bytes).equals(Buffer.from(f.sign()))) throw Error('different native signed wire');
          sends++; throw Error('lost fixture RPC acknowledgment');
        } }) };
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      app = await buildApp(config, runtime.db, { miningClaimsProvider: provider }); await app.ready();
      const [session] = await f.conn.db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      const jwt = await issueSessionJwt(config, f.wallet, session!.id);
      reply({ wallet: f.wallet, policy: { tokenDecimals: TOKEN.decimals, quoteVersion: PHASE_E_MINING_CLAIM_QUOTE.version, quoteTtlSec: PHASE_E_MINING_CLAIM_QUOTE.ttlSec },
        trust: { ...f.identity, keepMint: f.preparedClaim.header.keepMint, reserveOwner: f.preparedClaim.header.reserveOwner }, blockHeight: 200,
        cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` });
      while (!stopped) {
        const next = await iterator.next(); if (next.done) break;
        const item = commands.parse(JSON.parse(next.value));
        if (item.op === 'close') { stopped = true; reply({ closed: true }); break; }
        if (item.op === 'start') throw Error('already started');
        if (item.op === 'restart') {
          await app.close(); await runtime.sql.end(); runtime = createDb(runtimeUrl.toString(), { max: 4 });
          process.env['PHASE_E_MINING_ENABLED'] = item.paused ? 'false' : 'true';
          app = await buildApp(config, runtime.db, item.paused ? {} : { miningClaimsProvider: provider }); await app.ready();
          reply({ restarted: true, paused: item.paused }); continue;
        }
        if (item.op === 'freshBlockhash') {
          const blockhash = Keypair.generate().publicKey.toBase58();
          f.quote.reader.getLatestBlockhashAndContext = async () => ({ context: { slot: 3003 }, value: { blockhash, lastValidBlockHeight: 250 } });
          reply({ blockhash }); continue;
        }
        if (item.op === 'fail') {
          const meta = f.tx.meta!;
          const tx = { ...f.tx, meta: { ...meta, err: { InstructionError: [f.tx.transaction.message.compiledInstructions.length - 1, { Custom: 6000 }] },
            postBalances: meta.preBalances.map((amount, index) => index === 0 ? amount - meta.fee : amount), postTokenBalances: structuredClone(meta.preTokenBalances!) } };
          await createMiningClaimFailure(f.conn.db, { reader: { ...f.receiptReader, getTransaction: async () => tx }, trust: f.receiptTrust })({ wallet: f.wallet, claimId: item.claimId, ordinal: 0 });
          reply({ failed: true }); continue;
        }
        if (item.op === 'request') {
          const path = item.url;
          const allowed = item.method === 'POST' ? ['/api/claims/mining/prepare', '/api/claims/mining/submit'].includes(path)
            : path === '/api/claims/mining/status' || /^\/api\/claims\/mining\/(?:prepare\/by-key\/)?[0-9a-f-]{36}$/.test(path);
          if (!allowed) throw Error('unexpected native mining request');
          if (item.method === 'POST') { if (path.endsWith('/prepare')) preparePosts++; else submitPosts++; }
          const response = await app.inject({ method: item.method, url: path.slice('/api'.length), headers: item.headers,
            ...(item.body === undefined ? {} : { payload: item.body }) });
          reply({ status: response.statusCode, body: response.body }); continue;
        }
        if (item.op === 'sign') {
          const bytes = Buffer.from(item.unsigned, 'base64');
          if (bytes.toString('base64') !== item.unsigned || bytes.length > 1232 || bytes[0] !== 1 || !bytes.subarray(1, 65).equals(Buffer.alloc(64))
            || !bytes.subarray(65).equals(Buffer.from(f.preparedClaim.transactions[0]!.messageHex, 'hex'))) throw Error('unexpected native wallet request');
          const signed = VersionedTransaction.deserialize(bytes); signed.sign([f.claimantSigner]); signatures++;
          reply({ wire: Buffer.from(signed.serialize()).toString('base64') }); continue;
        }
        if (item.op === 'settle') {
          await createMiningClaimSettlement(f.conn.db, { reader: f.receiptReader, trust: f.receiptTrust })({ wallet: f.wallet, claimId: item.claimId, ordinal: 0 });
          reply({ verified: true }); continue;
        }
        const rows = await f.conn.sql`select claim_id,receipt->>'signature' as signature,receipt->>'paidKeepBaseUnits' as "paidKeepBaseUnits" from mining_claim_receipts`;
        const wires = await f.conn.sql`select claim_id,encode(signature,'hex') as "signatureHex" from mining_claim_signed_wires`;
        const failures = await f.conn.sql`select claim_id,receipt->>'signature' as signature from mining_claim_failures`;
        reply({ failures, preparePosts, submitPosts, sends, signatures, receipts: rows, wires, payment: String(f.payment) });
      }
    } finally {
      await app?.close(); await runtime.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role}; drop role ${role}`);
    }
  }, { deferSignedPersistence: true });
} catch (error) {
  reply({ error: error instanceof Error ? error.message : 'native mining fixture failed' }); process.exitCode = 1;
} finally { lines.close(); }

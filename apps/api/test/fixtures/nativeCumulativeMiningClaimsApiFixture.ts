/** Private R1 JVM pipe: real cumulative publication/claim DB + restricted API.
 * Generated local keys and serialized finalized RPC only; no live chain action. */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { VersionedTransaction } from '@solana/web3.js';
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
const { withCumulativeMiningClaimFixture } = await import('./cumulativeMiningClaim');
const { buildApp } = await import('../../src/app');
const { createDb } = await import('../../src/db/client');
const { sessions } = await import('../../src/db/schema');
const { getMiningClaimPreparation } = await import('../../src/mining/claimPreparationStore');
const { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } = await import('../../src/auth/session');
const { TEST_CONFIG } = await import('../helpers');
const commandSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('start'), origin: z.string().regex(/^https:\/\/localhost:\d+$/) }).strict(),
  z.object({ op: z.literal('request'), method: z.enum(['GET', 'POST']), url: z.string().max(256), headers: z.record(z.string(), z.string()), body: z.string().max(32768).optional() }).strict(),
  z.object({ op: z.literal('sign'), unsigned: z.string().max(1644) }).strict(),
  z.object({ op: z.literal('settle'), claimId: z.uuid() }).strict(),
  z.object({ op: z.literal('restart'), paused: z.boolean() }).strict(),
  z.object({ op: z.literal('inspect') }).strict(), z.object({ op: z.literal('close') }).strict(),
]);
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity }), iterator = lines[Symbol.asyncIterator]();
const reply = (body: unknown) => process.stdout.write(`NATIVE_CUMULATIVE_MINING_FIXTURE:${JSON.stringify(body)}\n`);
try {
  const firstLine = await iterator.next(); if (firstLine.done) throw Error('start required');
  const start = commandSchema.parse(JSON.parse(firstLine.value)); if (start.op !== 'start') throw Error('start required');
  await withCumulativeMiningClaimFixture(async f => {
    const first = await f.firstClaim(), originalReceipt = JSON.stringify(first.settlement), stage = await f.nextAdmission();
    const role = `native_cumulative_${randomUUID().replaceAll('-', '')}`, password = randomUUID();
    await f.conn.sql.unsafe(`create role ${role} login password '${password}';grant usage on schema public to ${role};
      grant select on players,sessions,mining_claim_entitlement_headers,mining_claim_entitlement_leaves,mining_claim_preparations,mining_claim_signed_wires,mining_claim_receipts,mining_claim_failures to ${role};
      grant insert on mining_claim_preparations,mining_claim_signed_wires to ${role}`);
    const runtimeUrl = new URL(f.url); runtimeUrl.username = role; runtimeUrl.password = password;
    let runtime = createDb(runtimeUrl.toString(), { max: 4 }), sends = 0, approvals = 0, preparePosts = 0, submitPosts = 0;
    let currentClaimId: string | null = null, currentKey: string | null = null;
    let completed: Awaited<ReturnType<typeof stage.completeClientClaim>> | null = null;
    const height = await stage.quote.reader.getBlockHeight({ commitment: 'finalized', minContextSlot: stage.bank.before.slot });
    const statusSlot = await stage.quote.reader.getSlot('finalized');
    const config = { ...TEST_CONFIG, DATABASE_URL: runtimeUrl.toString(), WEB_ORIGIN: [start.origin] };
    const provider = { reader: stage.bank.reader, trust: stage.bank.trust, quoteSource: () => stage.quote.reader, now: () => new Date(stage.preparedAt),
      transport: () => ({ getGenesisHash: async () => f.identity.genesisHash,
        getSignatureStatuses: async () => ({ context: { slot: statusSlot }, value: [null] }), getBlockHeight: async () => height,
        sendRawTransaction: async (bytes: Uint8Array) => {
          const stored = await f.conn.sql`select encode(signed_transaction,'hex') wire from mining_claim_signed_wires where claim_id=${currentClaimId}`;
          if (stored.length !== 1 || stored[0]!.wire !== Buffer.from(bytes).toString('hex')) throw Error('wire was not durably committed before send');
          sends++; throw Error('fixture lost acknowledgment after exact committed send');
        } }) };
    let app: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      app = await buildApp(config, runtime.db, { miningClaimsProvider: provider }); await app.ready();
      const [session] = await f.conn.db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
      const jwt = await issueSessionJwt(config, f.wallet, session!.id);
      reply({ wallet: f.wallet, blockHeight: height,
        policy: { tokenDecimals: TOKEN.decimals, quoteVersion: PHASE_E_MINING_CLAIM_QUOTE.version, quoteTtlSec: PHASE_E_MINING_CLAIM_QUOTE.ttlSec },
        trust: { ...f.identity, keepMint: first.preparedClaim.header.keepMint, reserveOwner: first.preparedClaim.header.reserveOwner },
        oldClaimId: first.preparedClaim.claimId, oldKey: first.preparedClaim.idempotencyKey, oldSignature: first.signed.signature, oldPayment: String(first.payment),
        cookie: `${SESSION_COOKIE}=${jwt}; Secure; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}` });
      for (;;) {
        const line = await iterator.next(); if (line.done) break;
        const item = commandSchema.parse(JSON.parse(line.value));
        if (item.op === 'close') { reply({ closed: true }); break; }
        if (item.op === 'start') throw Error('already started');
        if (item.op === 'restart') {
          await app.close(); await runtime.sql.end(); runtime = createDb(runtimeUrl.toString(), { max: 4 });
          process.env['PHASE_E_MINING_ENABLED'] = item.paused ? 'false' : 'true';
          app = await buildApp(config, runtime.db, item.paused ? {} : { miningClaimsProvider: provider }); await app.ready();
          reply({ restarted: true, paused: item.paused }); continue;
        }
        if (item.op === 'request') {
          const allowed = item.method === 'POST' ? ['/api/claims/mining/prepare', '/api/claims/mining/submit'].includes(item.url)
            : item.url === '/api/claims/mining/status' || /^\/api\/claims\/mining\/(?:prepare\/by-key\/)?[0-9a-f-]{36}$/.test(item.url);
          if (!allowed) throw Error('unexpected mining fixture request');
          if (item.method === 'POST') { if (item.url.endsWith('/prepare')) preparePosts++; else submitPosts++; }
          const response = await app.inject({ method: item.method, url: item.url.slice('/api'.length), headers: item.headers,
            ...(item.body === undefined ? {} : { payload: item.body }) });
          if (item.method === 'POST' && item.url.endsWith('/prepare') && response.statusCode === 201) {
            const p = response.json(); if (currentClaimId && currentClaimId !== p.claimId) throw Error('unexpected second client claim');
            currentClaimId = p.claimId; currentKey = p.idempotencyKey;
          }
          reply({ status: response.statusCode, body: response.body }); continue;
        }
        if (!currentKey && (item.op === 'sign' || item.op === 'settle')) throw Error('client preparation required');
        if (item.op === 'sign') {
          const p = await getMiningClaimPreparation(f.conn.db, { wallet: f.wallet, idempotencyKey: currentKey! });
          if (!p || p.header.sequence !== '2') throw Error('exact cumulative preparation required');
          const bytes = Buffer.from(item.unsigned, 'base64');
          if (bytes.toString('base64') !== item.unsigned || bytes.length > 1232 || bytes[0] !== 1 || !bytes.subarray(1, 65).equals(Buffer.alloc(64))
            || !bytes.subarray(65).equals(Buffer.from(p.transactions[0]!.messageHex, 'hex'))) throw Error('unexpected wallet approval');
          const signed = VersionedTransaction.deserialize(bytes); signed.sign([stage.claimantSigner]); approvals++;
          reply({ wire: Buffer.from(signed.serialize()).toString('base64') }); continue;
        }
        if (item.op === 'settle') {
          if (item.claimId !== currentClaimId) throw Error('wrong original claim');
          completed = await stage.completeClientClaim(currentKey!); reply({ verified: true, payment: String(completed.payment) }); continue;
        }
        const old = await first.recover(); if (JSON.stringify(old) !== originalReceipt) throw Error('original payment receipt changed');
        const receipts = await f.conn.sql`select claim_id,receipt->>'signature' signature,receipt->>'paidKeepBaseUnits' payment from mining_claim_receipts order by settled_at`;
        const wires = await f.conn.sql`select claim_id from mining_claim_signed_wires`;
        reply({ preparePosts, submitPosts, sends, approvals, receipts, wires, oldReceiptUnchanged: true, oldPayment: String(first.payment),
          payment: completed ? String(completed.payment) : null, cumulative: completed ? String(completed.postSnapshot.minerClaim!.claimedTotal) : null,
          setupRent: completed?.preparedClaim.rentLamports ?? null });
      }
    } finally { await app?.close(); await runtime.sql.end(); await f.conn.sql.unsafe(`drop owned by ${role};drop role ${role}`); }
  });
} catch (error) {
  reply({ error: error instanceof Error ? error.message : 'native cumulative fixture failed' }); process.exitCode = 1;
} finally { lines.close(); }

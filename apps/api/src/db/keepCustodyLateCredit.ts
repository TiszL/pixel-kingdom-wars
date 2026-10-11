/** Fixture-only late deposit rehearsal. No RPC, CLI, or runtime route exposes it. */
import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { isCanonicalSolanaSignature, keepAta, verifyKeepDeposit } from '@shardkeep/chain';
import { TOKEN } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { postTransaction } from '../ledger';
import { lockUnusedDepositSignature } from '../money/deposits';

export interface FixtureKeepLateCreditRequest {
  fixtureId: string;
  sourceVersion?: 2;
  retirementJournalId: string;
  depositId: string;
  proof: {
    signature: string; mint: string; custodyOwner: string; destination: string;
    broadcastObservedAt: string; withdrawalsClosedAt: string; finalizedObservedAt: string;
    /** JSON RPC evidence with base58 account keys, supplied by this fixture. */
    transaction: Record<string, unknown>;
  };
}
interface Posting {
  key: string; type: string; metadata: Record<string, unknown>;
  entries: Array<{ account: string; delta: string }>;
}
export interface Result {
  fixtureOnly: true; retirementAuthorized: false; chainEvidence: 'injected-fixture' | 'configured-rpc';
  fixtureId: string; retirementJournalId: string; depositId: string; inputHash: string;
  keep: string; gems: string; receipts: unknown[]; sourceAfter: Record<string, unknown>;
}
function fail(code: string): never { throw new Error(code); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('LATE_CREDIT_PROOF_INVALID');
  return value as Record<string, unknown>;
}
function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row).sort().map(k => `${JSON.stringify(k)}:${canonical(row[k])}`).join(',')}}`;
  }
  return fail('LATE_CREDIT_INPUT_INVALID');
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    fail('LATE_CREDIT_INPUT_INVALID');
  return Date.parse(value);
}
function publicKey(value: unknown): PublicKey {
  if (typeof value !== 'string') fail('LATE_CREDIT_PROOF_INVALID');
  const key = new PublicKey(value);
  if (key.toBase58() !== value) fail('LATE_CREDIT_PROOF_INVALID');
  return key;
}
function hydrate(raw: Record<string, unknown>) {
  const body = object(raw.transaction), message = object(body.message), meta = object(raw.meta);
  const keys = (value: unknown) => {
    if (!Array.isArray(value)) fail('LATE_CREDIT_PROOF_INVALID');
    return value.map(publicKey);
  };
  const loaded = meta.loadedAddresses === undefined ? undefined : object(meta.loadedAddresses);
  const hydrated = { ...raw, transaction: { ...body, message: { ...message,
    ...(message.staticAccountKeys === undefined ? { accountKeys: keys(message.accountKeys) } : { staticAccountKeys: keys(message.staticAccountKeys) }),
  } }, meta: { ...meta, ...(loaded ? { loadedAddresses: { writable: keys(loaded.writable), readonly: keys(loaded.readonly) } } : {}) } };
  return hydrated as unknown as NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;
}

export async function applyFixtureKeepLateCredit(request: FixtureKeepLateCreditRequest, env: NodeJS.ProcessEnv,
  connect: (url: string) => { db: Db; close: () => Promise<void> } = url => {
    const c = createDb(url, { max: 1 }); return { db: c.db, close: () => c.sql.end() };
  }): Promise<Result> {
  if (env['HOLD_BEFORE_MIGRATE'] !== '1' || !env['TEST_DATABASE_URL']) fail('CUSTODY_FIXTURE_REQUIRED');
  const url = new URL(env['TEST_DATABASE_URL']), database = url.pathname.slice(1);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !/^shardkeep_custody_apply_[0-9a-f]{32}_test$/.test(database) || url.search || url.hash) fail('CUSTODY_FIXTURE_REQUIRED');
  if (![request.fixtureId, request.retirementJournalId, request.depositId].every(id => uuid.test(id))) fail('LATE_CREDIT_INPUT_INVALID');
  const json = canonical(request), inputHash = createHash('sha256').update(json).digest('hex');
  const p = request.proof, broadcast = instant(p.broadcastObservedAt), closed = instant(p.withdrawalsClosedAt), finalized = instant(p.finalizedObservedAt);
  if (!isCanonicalSolanaSignature(p.signature) || keepAta(publicKey(p.custodyOwner), publicKey(p.mint)).toBase58() !== p.destination)
    fail('LATE_CREDIT_PROOF_INVALID');
  const connection = connect(url.toString());
  try { return await connection.db.transaction(async tx => {
    await tx.execute(sql`set local search_path=pg_catalog,public,pg_temp`);
    await tx.execute(sql`set local time zone 'UTC'`);
    await tx.execute(sql`select set_config('shardkeep.deed_economy_writer','v1',true)`);
    const [identity] = await tx.execute<{ database: string; owner: boolean }>(sql`select current_database() as database,
      current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.keep_custody_journal'::regclass)
      and current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.keep_custody_late_authorizations'::regclass)
      and current_user=(select pg_get_userbyid(relowner) from pg_class where oid='public.keep_custody_cutover_state'::regclass) as owner`);
    if (identity?.database !== database || !identity.owner) fail('CUSTODY_FIXTURE_IDENTITY_REQUIRED');
    // Even read locks on the journal must follow the barrier: two concurrent
    // readers must not both need to upgrade that relation lock to EXCLUSIVE.
    await tx.execute(sql`select public.shardkeep_fixture_late_barrier()`);
    const [journal] = await tx.execute<{ request: { asOf: string }; late_deposit_sources: Array<Record<string, unknown>> }>(sql`
      select request,late_deposit_sources from public.keep_custody_journal where id=${request.retirementJournalId}::uuid`);
    const source = journal?.late_deposit_sources.find(d => d.id === request.depositId);
    if (!source) fail('LATE_CREDIT_SOURCE_REQUIRED');
    const created = Date.parse(String(source.created_at)), frozen = instant(journal!.request.asOf);
    if (!(created <= broadcast && broadcast < closed && closed <= frozen && frozen < finalized)) fail('LATE_CREDIT_TIME_INVALID');
    const raw = p.transaction, body = object(raw.transaction), message = object(body.message), meta = object(raw.meta);
    const signers = object(message.header).numRequiredSignatures;
    if (!Number.isSafeInteger(raw.slot) || Number(raw.slot) < 0 || !Number.isSafeInteger(raw.blockTime)
      || Number(raw.blockTime) < Math.floor(created / 1000) || Number(raw.blockTime) > Math.floor(finalized / 1000)
      || meta.err !== null || !Array.isArray(body.signatures) || body.signatures[0] !== p.signature
      || !Number.isInteger(signers) || Number(signers) < 1) fail('LATE_CREDIT_PROOF_INVALID');
    const chainTx = hydrate(raw);
    const fixtureConnection = {
      getTransaction: async (signature: string, options: { commitment: string }) => {
        if (signature !== p.signature || options.commitment !== 'finalized') fail('LATE_CREDIT_PROOF_INVALID');
        return chainTx;
      },
      getSignaturesForAddress: async () => [],
    } as unknown as Connection;
    const verified = await verifyKeepDeposit(fixtureConnection, {
      reference: publicKey(source.reference), expectedSigner: publicKey(source.player_wallet), keepMint: publicKey(p.mint),
      destination: publicKey(p.destination), notBefore: new Date(created), paymentSignature: p.signature, strictUncertainty: true,
    });
    if (!verified || verified.txSignature !== p.signature) fail('LATE_CREDIT_PROOF_INVALID');
    const keep = verified.amountBaseUnits / 10n ** BigInt(TOKEN.decimals);
    if (keep <= 0n) fail('LATE_CREDIT_PROOF_INVALID');
    // prepare takes the complete NOWAIT barrier before latch, domain, account
    // or signature locks. Its authority is transaction-bound, never a GUC.
    const [prepared] = await tx.execute<{ plan: { postings?: Posting[]; replay?: Result } }>(sql`
      select public.prepare_fixture_keep_late_credit(${json}::jsonb,${inputHash},${keep}::bigint,${verified.amountBaseUnits}::bigint) plan`);
    if (prepared?.plan.replay) return prepared.plan.replay;
    const postings = prepared?.plan.postings;
    if (!postings || postings.length !== 2) fail('LATE_CREDIT_PLAN_INVALID');
    await lockUnusedDepositSignature(tx, request.depositId, p.signature);
    const ids: string[] = [];
    for (const [index, posting] of postings.entries()) {
      await tx.execute(sql`select set_config('shardkeep.keep_custody_cutover',${index === 0 ? 'late-credit' : 'operator-settle'},true)`);
      const result = await postTransaction(tx, { idempotencyKey: posting.key, type: posting.type, metadata: posting.metadata,
        entries: posting.entries.map(e => ({ account: e.account, delta: BigInt(e.delta) })) });
      if (result.duplicate) fail('LATE_CREDIT_RECEIPT_CONFLICT');
      ids.push(result.transaction.id);
    }
    await tx.execute(sql`update public.deposits set status='credited',tx_signature=${p.signature},amount=${verified.amountBaseUnits},
      mint=${p.mint},finalized_at=${p.finalizedObservedAt}::timestamptz,ledger_txn_id=${ids[0]}::uuid where id=${request.depositId}::uuid`);
    const [sealed] = await tx.execute<{ result: Result }>(sql`select public.seal_fixture_keep_late_credit(${request.fixtureId}::uuid) result`);
    return sealed?.result ?? fail('LATE_CREDIT_SEAL_REQUIRED');
  }); } finally { await connection.close(); }
}

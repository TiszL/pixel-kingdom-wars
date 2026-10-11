/** Prospective source evidence passes through the real authenticated /paid path.
 * The RPC and clock are local seams; message construction, verification, W/F,
 * retirement and the two backed postings all use production implementations. */
import { randomUUID } from 'node:crypto';
import { TOKEN, ECONOMY } from '@shardkeep/shared';
import { keepAta } from '@shardkeep/chain';
import { Keypair, PublicKey, Transaction, TransactionInstruction, type Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../../src/auth/session';
import { createDb, type Db, type DbTx } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';
import { applyFixtureL1Retirement, type FixtureRetirementRequest } from '../../src/db/keepCustodyJournal';
import { closeFixtureKeepCustodyWindow } from '../../src/db/keepCustodySource';
import { applyFixtureUnbondingWithdrawalDrain } from '../../src/db/keepCustodyWithdrawalDrain';
import { players, sessions } from '../../src/db/schema';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../../src/ledger';
import { createKeepCustodySourceCollector } from '../../src/money/keepCustodySource';
import { creditDeposit, type DepositPaymentCommitVerifier } from '../../src/money/deposits';
import { requestWithdrawal } from '../../src/money/withdrawals';
import { ADMIN_DATABASE_URL } from '../db-url';
import { createMigratedDatabase } from '../migratedTemplate';
import { fundTestKeep, TEST_CONFIG } from '../helpers';
export { deferred, entered, leaf } from './custodyWithdrawalDrain';

export const SOURCE_UNIT = 10n ** BigInt(TOKEN.decimals);
export const SOURCE_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
export type SourceTransaction = ReturnType<typeof signedTransfer>;
export function signedTransfer(input: {
  key: Keypair; reference: string; mint: PublicKey; owner: PublicKey; amount: bigint;
  destination?: PublicKey;
}) {
  const destination = input.destination ?? keepAta(input.owner, input.mint);
  // Classic SPL TransferChecked, exactly the existing wallet deposit wire.
  // Keeping this tiny typed instruction here avoids importing the browser's
  // environment/DOM-bound cluster module into the API typecheck graph.
  const data = Buffer.alloc(10); data[0] = 12;
  data.writeBigUInt64LE(input.amount, 1); data[9] = TOKEN.decimals;
  const transaction = new Transaction().add(new TransactionInstruction({
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
    keys: [
      { pubkey: keepAta(input.key.publicKey, input.mint), isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: input.key.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(input.reference), isSigner: false, isWritable: false },
    ], data,
  }));
  transaction.feePayer = input.key.publicKey;
  transaction.recentBlockhash = Keypair.generate().publicKey.toBase58();
  transaction.sign(input.key);
  if (!transaction.verifySignatures()) throw Error('fixture transfer must actually be signed');
  const message = transaction.compileMessage(), index = message.accountKeys.findIndex(k => k.equals(destination));
  const signature = bs58.encode(transaction.signature!);
  const balance = (amount: bigint) => ({ accountIndex: index, mint: input.mint.toBase58(),
    owner: input.owner.toBase58(), uiTokenAmount: { amount: amount.toString(), decimals: TOKEN.decimals,
      uiAmount: null, uiAmountString: '0' } });
  return { slot: 123, blockTime: Math.floor(Date.now() / 1_000), version: 'legacy' as const,
    transaction: { signatures: [signature], message: {
      header: message.header, accountKeys: message.accountKeys.map(k => k.toBase58()),
      recentBlockhash: message.recentBlockhash, instructions: message.instructions,
    } },
    meta: { err: null as unknown, fee: 5_000, preBalances: message.accountKeys.map(() => 1_000_000),
      postBalances: message.accountKeys.map(() => 1_000_000),
      preTokenBalances: [balance(100n * SOURCE_UNIT)], postTokenBalances: [balance(100n * SOURCE_UNIT + input.amount)],
    } };
}

export async function keepCustodySourceFixture() {
  const database = `shardkeep_custody_apply_${randomUUID().replaceAll('-', '')}_test`;
  const url = new URL(ADMIN_DATABASE_URL); url.pathname = `/${database}`;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw Error('local fixture required');
  const admin = postgres(ADMIN_DATABASE_URL, { max: 1, onnotice: () => {} });
  await createMigratedDatabase(admin, database);
  const conn = createDb(url.toString(), { max: 6 });
  let app: FastifyInstance | undefined;
  const dispose = async () => {
    await app?.close(); await conn.sql.end();
    await admin.unsafe(`drop database if exists ${database} with (force)`); await admin.end();
  };
  try {
    await runMigrations(conn.db);
    const sys = await bootstrapSystemAccounts(conn.db);
    const key = Keypair.generate(), wallet = key.publicKey.toBase58();
    const mint = Keypair.generate().publicKey, owner = Keypair.generate().publicKey;
    const destination = keepAta(owner, mint).toBase58();
    await conn.db.insert(players).values({ wallet });
    await getOrCreatePlayerAccount(conn.db, wallet, 'player_keep');
    await fundTestKeep(conn.db, wallet, 11n, 'test.custody-source.fund', randomUUID());
    const [session] = await conn.db.insert(sessions).values({ wallet,
      expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1_000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
    let now: Date | undefined, genesis = SOURCE_GENESIS, unavailable = false;
    let readHook: ((commitment: string) => Promise<void>) | undefined;
    const calls: { signature: string; commitment: string }[] = [];
    const confirmed = new Map<string, SourceTransaction>(), finalized = new Map<string, SourceTransaction>();
    const connection = {
      getGenesisHash: async () => genesis,
      getTransaction: async (signature: string, config: { commitment: string }) => {
        calls.push({ signature, commitment: config.commitment });
        await readHook?.(config.commitment);
        if (unavailable) throw Error('fixture RPC unavailable');
        // Independent copies make read-twice bugs visible; no mutation leaks
        // from a verifier back into the next RPC response.
        const found = (config.commitment === 'confirmed' ? confirmed : finalized).get(signature);
        return found ? structuredClone(found) : null;
      },
    } as unknown as Pick<Connection, 'getGenesisHash' | 'getTransaction'>;
    const factory = (otherCommitVerifier?: DepositPaymentCommitVerifier) => createKeepCustodySourceCollector({
      connection, genesisHash: SOURCE_GENESIS, keepMint: mint.toBase58(), custodyOwner: owner.toBase58(),
      now: () => now ?? new Date(), ...(otherCommitVerifier ? { otherCommitVerifier } : {}),
    });
    let collector = factory();
    const restart = async (verifier: DepositPaymentCommitVerifier = collector.verifyCommit) => {
      await app?.close();
      app = await buildApp({ ...TEST_CONFIG, PLAYTEST_OPEN: 'true', DATABASE_URL: url.toString() }, conn.db, {
        keepDeposit: { hotWalletAta: destination, keepMint: mint.toBase58(), decimals: TOKEN.decimals },
        depositPaymentCommitVerifier: verifier,
      });
      await app.ready();
    };
    await restart();
    const post = (path: string, payload: Record<string, unknown>, auth: Record<string, string> = cookies) => app!.inject({
      method: 'POST', url: path, cookies: auth, payload,
    });
    const intent = async (amount = 5n * SOURCE_UNIT + 7n) => {
      const response = await post('/deposits', { kind: 'keep_deposit' });
      if (response.statusCode !== 200) throw Error(`fixture intent ${response.statusCode}: ${response.body}`);
      const value = response.json<{ id: string; reference: string }>();
      const transaction = signedTransfer({ key, reference: value.reference, mint, owner, amount });
      const signature = transaction.transaction.signatures[0]!;
      confirmed.set(signature, transaction); finalized.set(signature, structuredClone(transaction));
      return { ...value, signature, amount, transaction };
    };
    const first = await intent();
    const paid = (payment = first, auth: Record<string, string> = cookies) => post(`/deposits/${payment.id}/paid`, { signature: payment.signature }, auth);
    const env = { HOLD_BEFORE_MIGRATE: '1', TEST_DATABASE_URL: url.toString() };
    const windowId = randomUUID(), retirementJournalId = randomUUID(), fixtureId = randomUUID();
    const connect = () => ({ db: conn.db, close: async () => {} });
    const close = () => closeFixtureKeepCustodyWindow({ windowId }, env);
    const drain = () => conn.sql`select shardkeep_advance_keep_custody_phase('fenced','withdrawals_closed')`;
    let asOf: string | undefined;
    const retirementRequest = async (): Promise<FixtureRetirementRequest> => {
      const rows = await conn.sql<{ wallet: string; keep: string }[]>`select owner_wallet wallet,balance::text keep from accounts
        where kind='player_keep' and balance>0 order by owner_wallet`;
      return { fixtureId: retirementJournalId, asOf: asOf ??= new Date().toISOString(), custodyWindowId: windowId,
        players: rows.map(row => ({ ...row, internal: false })) };
    };
    const retire = async () => {
      const request = await retirementRequest();
      const result = await applyFixtureL1Retirement(request, env);
      now = undefined; // First retained finality uses the real observation time after F.
      return result;
    };
    const request = (depositId = first.id) => ({ fixtureId, retirementJournalId, depositId });
    const collect = (input = request()) => collector.collect(input, env);
    const credit = (payment = first) => creditDeposit(conn.db, payment.id, {
      txSignature: payment.signature, wallet, kind: 'keep_deposit', lamports: payment.amount, finalized: true,
    });
    const freeze = async () => {
      const response = await paid();
      if (response.statusCode !== 200) throw Error(`fixture /paid ${response.statusCode}: ${response.body}`);
      await close(); await drain(); return retire();
    };
    const balance = async (kind: string, who: string | null = null) => BigInt((await conn.sql<{ total: string }[]>`
      select coalesce(sum(balance),0)::text total from accounts where kind::text=${kind}
        and owner_wallet is not distinct from ${who}::text`)[0]!.total);
    const snapshot = async () => JSON.stringify(await conn.sql`select
      (select jsonb_agg(to_jsonb(a) order by id) from accounts a) accounts,
      (select jsonb_agg(to_jsonb(t) order by id) from ledger_transactions t) headers,
      (select jsonb_agg(to_jsonb(e) order by id) from ledger_entries e) entries,
      (select jsonb_agg(to_jsonb(d) order by id) from deposits d) deposits,
      (select jsonb_agg(to_jsonb(s) order by deposit_id,commitment) from keep_custody_source_observations s) observations,
      (select jsonb_agg(to_jsonb(w) order by id) from keep_custody_source_windows w) windows,
      (select jsonb_agg(to_jsonb(j) order by id) from keep_custody_journal j) retirement,
      (select jsonb_agg(to_jsonb(j) order by id) from keep_custody_late_journal j) late,
      (select jsonb_agg(to_jsonb(a) order by id) from keep_custody_late_authorizations a) authorizations,
      (select to_jsonb(s) from keep_custody_cutover_state s) phase`);
    const addWithdrawal = async () => {
      const gross = BigInt(ECONOMY.minWithdrawKeep) * 2n;
      await fundTestKeep(conn.db, wallet, gross, 'test.custody-source.withdrawal-fund', randomUUID());
      const withdrawal = await requestWithdrawal(conn.db, wallet, gross, Keypair.generate().publicKey.toBase58(), randomUUID());
      const drainRequest = { fixtureId: randomUUID(), asOf: new Date().toISOString(), withdrawalIds: [withdrawal.id] };
      return { gross, withdrawal, drain: () => applyFixtureUnbondingWithdrawalDrain(drainRequest, env) };
    };
    const wrap = (after: (tx: DbTx) => Promise<void>) => () => ({
      db: { execute: conn.db.execute.bind(conn.db), transaction: async (callback: (tx: DbTx) => Promise<unknown>) => conn.db.transaction(async tx => {
        const result = await callback(tx); await after(tx); return result;
      }) } as unknown as Db, close: async () => {},
    });
    return { ...conn, sys, database, env, wallet, key, cookies, mint, owner, destination, first,
      confirmed, finalized, calls, factory, connection, close, windowId, drain, retire, retirementRequest, retirementJournalId,
      request, collect, credit, freeze, balance, snapshot, addWithdrawal, restart, post, paid, intent, connect, wrap,
      collector: () => collector, restartCollector: () => { collector = factory(); },
      setNow: (value: Date | undefined) => { now = value; }, setGenesis: (value: string) => { genesis = value; },
      setUnavailable: (value: boolean) => { unavailable = value; },
      setReadHook: (value: typeof readHook) => { readHook = value; }, dispose };
  } catch (error) { await dispose(); throw error; }
}
export type KeepCustodySourceFixture = Awaited<ReturnType<typeof keepCustodySourceFixture>>;

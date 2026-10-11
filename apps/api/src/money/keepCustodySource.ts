/** Trusted confirmed/finalized reader for the prospective local KEEP source rail.
 * Configuration owns every chain pin; requests carry identities only. */
import { createHash } from 'node:crypto';
import { Connection, PublicKey } from '@solana/web3.js';
import { isCanonicalSolanaSignature, keepAta, verifyKeepDeposit, verifyKeepDepositCommit } from '@shardkeep/chain';
import { TOKEN } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { type Db } from '../db/client';
import { applyFixtureKeepLateCredit, type FixtureKeepLateCreditRequest } from '../db/keepCustodyLateCredit';
import { assertKeepSourceId, connectKeepSource, keepSourceFixtureUrl, type KeepCustodySourceProof, type KeepSourceConnect } from '../db/keepCustodySource';
import { withDepositVerificationDeadline, type DepositPaymentCommitIntent, type DepositPaymentCommitVerifier } from './deposits';

const fail = (): never => { throw new Error('KEEP_SOURCE_PROOF_REQUIRED'); };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : fail();
const key = (s: unknown): PublicKey => {
  if (typeof s !== 'string') return fail();
  const p = new PublicKey(s); if (p.toBase58() !== s) return fail(); return p;
};
function canonical(v: unknown): string {
  if (v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const r = object(v); return `{${Object.keys(r).sort().map(k => `${JSON.stringify(k)}:${canonical(r[k])}`).join(',')}}`;
}
function hydrate(raw: Record<string, unknown>) {
  const body = object(raw.transaction), message = object(body.message), meta = object(raw.meta);
  const keys = (v: unknown) => Array.isArray(v) ? v.map(key) : fail();
  const loaded = meta.loadedAddresses === undefined ? undefined : object(meta.loadedAddresses);
  return { ...raw, transaction: { ...body, message: { ...message,
    ...(message.staticAccountKeys === undefined ? { accountKeys: keys(message.accountKeys) } : { staticAccountKeys: keys(message.staticAccountKeys) }),
  } }, meta: { ...meta, ...(loaded ? { loadedAddresses: { writable: keys(loaded.writable), readonly: keys(loaded.readonly) } } : {}) } } as unknown as NonNullable<Awaited<ReturnType<Connection['getTransaction']>>>;
}
export interface SourceRequest { fixtureId: string; retirementJournalId: string; depositId: string }
export function createKeepCustodySourceCollector(config: {
  connection: Pick<Connection, 'getGenesisHash' | 'getTransaction'>;
  genesisHash: string; keepMint: string; custodyOwner: string;
  now?: () => Date; otherCommitVerifier?: DepositPaymentCommitVerifier;
}) {
  const { connection, genesisHash, otherCommitVerifier } = config;
  const mint = key(config.keepMint), custodyOwner = key(config.custodyOwner), destination = keepAta(custodyOwner, mint);
  key(genesisHash);
  const getGenesisHash = connection.getGenesisHash.bind(connection), getTransaction = connection.getTransaction.bind(connection);
  const now = config.now ?? (() => new Date());
  async function observe(intent: DepositPaymentCommitIntent, commitment: 'confirmed' | 'finalized'): Promise<KeepCustodySourceProof> {
    if (intent.kind !== 'keep_deposit' || !isCanonicalSolanaSignature(intent.paymentSignature)) return fail();
    // Copy the one response before verifying it; no second read can silently
    // replace the evidence that supplied the delta or message identity.
    if (await getGenesisHash() !== genesisHash) return fail();
    const response = await getTransaction(intent.paymentSignature, { commitment, maxSupportedTransactionVersion: 0 });
    if (!response) return fail();
    const raw = object(JSON.parse(JSON.stringify(response))), body = object(raw.transaction), message = object(body.message), meta = object(raw.meta);
    const observed = now();
    if (!Number.isFinite(observed.getTime()) || !Number.isSafeInteger(raw.slot) || Number(raw.slot) < 0
      || !Number.isSafeInteger(raw.blockTime) || Number(raw.blockTime) < Math.floor(intent.createdAt.getTime() / 1000)
      || Number(raw.blockTime) > Math.floor(observed.getTime() / 1000) || observed < intent.createdAt
      || meta.err !== null || !Array.isArray(body.signatures) || body.signatures[0] !== intent.paymentSignature
      || !Number.isInteger(object(message.header).numRequiredSignatures) || Number(object(message.header).numRequiredSignatures) < 1) return fail();
    const chainTx = hydrate(raw), staticKeys = (message.staticAccountKeys ?? message.accountKeys) as string[];
    const loaded = meta.loadedAddresses === undefined ? { writable: [], readonly: [] } : object(meta.loadedAddresses);
    const allKeys = [...staticKeys, ...(loaded.writable as string[]), ...(loaded.readonly as string[])];
    const at = allKeys.indexOf(destination.toBase58());
    if (at < 0 || Number(object(message.header).numRequiredSignatures) > staticKeys.length) return fail();
    for (const side of ['preTokenBalances', 'postTokenBalances']) {
      const balances = meta[side]; if (!Array.isArray(balances)) return fail();
      const matches = balances.filter(b => object(b).accountIndex === at);
      if (matches.length > 1 || (side === 'postTokenBalances' && matches.length !== 1)) return fail();
      for (const v of matches) {
        const b = object(v), amount = object(b.uiTokenAmount);
        if (b.mint !== mint.toBase58() || (b.owner !== undefined && b.owner !== custodyOwner.toBase58())
          || amount.decimals !== TOKEN.decimals || typeof amount.amount !== 'string' || !/^(0|[1-9]\d*)$/.test(amount.amount)) return fail();
      }
    }
    const single = { getTransaction: async (signature: string, options: { commitment: string }) => {
      if (signature !== intent.paymentSignature || options.commitment !== commitment) return fail(); return chainTx;
    }, getSignaturesForAddress: async () => [] } as unknown as Connection;
    const params = { reference: key(intent.reference), keepMint: mint, destination, expectedSigner: key(intent.playerWallet), paymentSignature: intent.paymentSignature };
    const verified = commitment === 'confirmed' ? await verifyKeepDepositCommit(single, params)
      : await verifyKeepDeposit(single, { ...params, notBefore: intent.createdAt, strictUncertainty: true });
    if (!verified || verified.txSignature !== intent.paymentSignature || verified.amountBaseUnits / 10n ** BigInt(TOKEN.decimals) <= 0n) return fail();
    return { genesisHash: genesisHash, mint: mint.toBase58(), custodyOwner: custodyOwner.toBase58(), destination: destination.toBase58(),
      signature: intent.paymentSignature, observedAt: observed.toISOString(), amountBaseUnits: verified.amountBaseUnits.toString(),
      messageHash: createHash('sha256').update(canonical(message)).digest('hex'), transaction: raw };
  }
  const verifyCommit: DepositPaymentCommitVerifier = async intent => {
    if (intent.kind !== 'keep_deposit') return otherCommitVerifier?.(intent) ?? null;
    const proof = await observe(intent, 'confirmed');
    return { txSignature: proof.signature, keepCustodySource: proof };
  };
  async function collect(request: SourceRequest, env: NodeJS.ProcessEnv, connect: KeepSourceConnect = connectKeepSource) {
    if (Object.keys(request).sort().join(',') !== 'depositId,fixtureId,retirementJournalId') throw new Error('KEEP_SOURCE_INPUT');
    Object.values(request).forEach(assertKeepSourceId);
    const url = keepSourceFixtureUrl(env), c = connect(url);
    try {
      // Receipt recovery is available even when the configured RPC is down.
      const [completed] = await c.db.execute<{ request: FixtureKeepLateCreditRequest }>(sql`
        select a.request from public.keep_custody_late_authorizations a join public.keep_custody_late_journal j on j.id=a.id where a.id=${request.fixtureId}::uuid`);
      if (completed) {
        if (completed.request.sourceVersion !== 2 || completed.request.depositId !== request.depositId
          || completed.request.retirementJournalId !== request.retirementJournalId) throw new Error('KEEP_SOURCE_REPLAY_CONFLICT');
        return await applyFixtureKeepLateCredit(completed.request, env, () => ({ db: c.db, close: async () => {} }));
      }
      const [source] = await c.db.execute<{ proof: KeepCustodySourceProof; original: Record<string, unknown>; closed_at: Date }>(sql`
        select o.proof,o.original,w.closed_at from public.keep_custody_journal j
        join public.keep_custody_source_windows w on w.id=(j.request->>'custodyWindowId')::uuid
        join public.keep_custody_source_observations o on o.deposit_id=${request.depositId}::uuid and o.commitment='confirmed'
        where j.id=${request.retirementJournalId}::uuid and j.late_deposit_sources @> jsonb_build_array(o.original)`);
      if (!source || source.proof.genesisHash !== genesisHash || source.proof.mint !== mint.toBase58()
        || source.proof.custodyOwner !== custodyOwner.toBase58() || source.proof.destination !== destination.toBase58()) return fail();
      const original = source.original;
      const proof = await withDepositVerificationDeadline(() => observe({ id: request.depositId, kind: 'keep_deposit',
        reference: String(original.reference), playerWallet: String(original.player_wallet), createdAt: new Date(String(original.created_at)),
        paymentSignature: source.proof.signature }, 'finalized'), 'KEEP source finalization timed out');
      if (proof.messageHash !== source.proof.messageHash || proof.amountBaseUnits !== source.proof.amountBaseUnits) return fail();
      const bound: FixtureKeepLateCreditRequest = { ...request, sourceVersion: 2, proof: {
        signature: proof.signature, mint: proof.mint, custodyOwner: proof.custodyOwner, destination: proof.destination,
        broadcastObservedAt: source.proof.observedAt, withdrawalsClosedAt: new Date(source.closed_at).toISOString(),
        finalizedObservedAt: proof.observedAt, transaction: proof.transaction,
      } };
      return await c.db.transaction(async tx => {
        await tx.execute(sql`select public.shardkeep_keep_source_barrier()`);
        const [saved] = await tx.execute<{ request: FixtureKeepLateCreditRequest }>(sql`
          select a.request from public.keep_custody_late_authorizations a join public.keep_custody_late_journal j on j.id=a.id where a.id=${request.fixtureId}::uuid`);
        if (saved) {
          if (saved.request.sourceVersion !== 2 || saved.request.depositId !== request.depositId || saved.request.retirementJournalId !== request.retirementJournalId)
            throw new Error('KEEP_SOURCE_REPLAY_CONFLICT');
          return await applyFixtureKeepLateCredit(saved.request, env, () => ({ db: tx as unknown as Db, close: async () => {} }));
        }
        await tx.execute(sql`select public.shardkeep_retain_keep_source(${request.depositId}::uuid,'finalized',${JSON.stringify(proof)}::jsonb)`);
        return await applyFixtureKeepLateCredit(bound, env, () => ({ db: tx as unknown as Db, close: async () => {} }));
      });
    } finally { await c.close(); }
  }
  return { verifyCommit, collect };
}

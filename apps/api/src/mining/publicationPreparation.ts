import { isResourceMiningManifest } from './resourceMiningAudit';
/** Internal first-publication preparation. Persist the verified complete plan and
 * exact unsigned message together before a separate signer can attempt it. */
import { createHash } from 'node:crypto';
import { PublicKey, VersionedMessage } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { PHASE_E_MINING_PUBLICATION as POLICY } from '@shardkeep/shared';
import { phaseEMiningEnabled } from '../config';
import type { Db, DbOrTx } from '../db/client';
import { createInitialFreeAllocationPlanner, createCumulativeFreeAllocationPlanner, type InitialFreeAllocationSources } from './initialFreeAllocation';
import { auditStoredFreePublication, auditStoredResourcePublication, loadAuditedMiningPriorForBacking } from './publicationHistory';
import { assertMiningPublicationPreparationFence, MiningPublicationPreparationFenceError } from './publicationPreparationFence';
import { miningPublicationSchema as publicationSchema, miningPublicationMessage as publicationMessage, type PreparedMiningPublication } from './publicationEnvelope';
export type { PreparedMiningPublication } from './publicationEnvelope';
import type { MiningPublicationAttempt } from './publicationCustody';

const MAX_MANIFEST_BYTES = 4 * 1024 * 1024, MAX_PACKET_BYTES = 1232, RPC_TIMEOUT_MS = 30_000;
const PUBLISH_PAUSED = 2; // Wire ABI: mining_state.rs, not economy tuning.
const address = z.string().max(44).refine(v => {
  if (v.length > 44) return false; // Zod max does not short-circuit refinements.
  try { return new PublicKey(v).toBase58() === v; } catch { return false; }
});
const requestSchema = z.object({ epochId: z.uuid(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), policyVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  attemptKey: z.string().min(8).max(128).refine(v => v.trim() === v) }).strict();
type Code = 'INVALID_INPUT' | 'OWNER_REQUIRED' | 'DISABLED' | 'BUSY' | 'SOURCE_CHANGED' | 'SOURCE_CONFLICT'
  | 'PUBLISHER_UNAVAILABLE' | 'BLOCKHASH_UNAVAILABLE' | 'IDEMPOTENCY_BODY_MISMATCH' | 'ORIGINAL_IN_FLIGHT';
export class MiningPublicationPreparationError extends Error {
  constructor(readonly code: Code) { super(`Mining publication preparation refused: ${code}`); this.name = 'MiningPublicationPreparationError'; }
}
function fail(code: Code): never { throw new MiningPublicationPreparationError(code); }
const digest = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex');
async function owner(db: DbOrTx) {
  const [row] = await db.execute<{ allowed: boolean }>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_catalog.pg_class where oid='public.mining_publication_manifests'::regclass) allowed`);
  if (!row?.allowed) fail('OWNER_REQUIRED');
}
/** Immutable operator recovery; it validates the saved message without a new blockhash or RPC read. */
export async function getPreparedMiningPublication(db: DbOrTx, epochId: string): Promise<PreparedMiningPublication | null> {
  if (!z.uuid().safeParse(epochId).success) fail('INVALID_INPUT'); await owner(db);
  const [row] = await db.execute<{ epoch_id: string; attempt_key: string; manifest_json: string; source_hash: string;
    intent_hex: string; intent_sha256: string; publication: unknown; prepared_at: string;
    reservations: MiningPublicationAttempt['reservations'] | null }>(sql`select
    m.epoch_id,a.attempt_key,m.manifest_json,m.source_hash,encode(a.intent_bytes,'hex') intent_hex,
    a.intent_sha256,a.reservations,m.publication,to_char(m.prepared_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') prepared_at
    from mining_publication_manifests m join mining_publication_attempts a using(epoch_id) where m.epoch_id=${epochId}`);
  if (!row) return null;
  const parsed = publicationSchema.safeParse(row.publication);
  if (!parsed.success || Buffer.byteLength(row.manifest_json) > MAX_MANIFEST_BYTES || digest(row.manifest_json) !== row.source_hash
    || !/^(?:[0-9a-f]{2})+$/.test(row.intent_hex) || row.intent_hex.length > MAX_PACKET_BYTES * 2) fail('SOURCE_CONFLICT');
  const bytes = Buffer.from(row.intent_hex, 'hex');
  try {
    if (isResourceMiningManifest(JSON.parse(row.manifest_json).version)) {
      if (row.reservations !== null) fail('SOURCE_CONFLICT');
      await auditStoredResourcePublication(db, { manifestJson: row.manifest_json, publication: parsed.data });
    } else {
      if (!Array.isArray(row.reservations)) fail('SOURCE_CONFLICT');
      await auditStoredFreePublication(db, { manifestJson: row.manifest_json, publication: parsed.data, reservations: row.reservations });
    }
    if (!Buffer.from(VersionedMessage.deserialize(bytes).serialize()).equals(bytes) || digest(bytes) !== row.intent_sha256
    || !publicationMessage(parsed.data, row.source_hash).equals(bytes)) fail('SOURCE_CONFLICT'); }
  catch { fail('SOURCE_CONFLICT'); }
  return Object.freeze({ status: 'prepared', epochId: row.epoch_id, attemptKey: row.attempt_key, manifestJson: row.manifest_json,
    sourceHash: row.source_hash, intentHex: row.intent_hex, intentSha256: row.intent_sha256,
    publication: Object.freeze(parsed.data), preparedAt: row.prepared_at, publicationFinalized: false, consumptionAuthorized: false });
}
export interface MiningPublicationBlockhashReader {
  getGenesisHash(): Promise<string>;
  getLatestBlockhashAndContext(options: { commitment: 'finalized'; minContextSlot: number }): Promise<{
    context: { slot: number }; value: { blockhash: string; lastValidBlockHeight: number };
  }>;
}
export interface MiningPublicationPreparationOptions {
  sources: InitialFreeAllocationSources; signer: PublicKey; blockhashSource: (signal: AbortSignal) => MiningPublicationBlockhashReader;
}
export function createInitialFreePublicationPreparer(db: Db, options: MiningPublicationPreparationOptions) {
  return createPublicationPreparer(db, options, createInitialFreeAllocationPlanner(db, options.sources));
}
/** Application-owned history is the only predecessor source. Never request JSON. */
export function createCumulativeFreePublicationPreparer(db: Db, options: MiningPublicationPreparationOptions) {
  const plan = createCumulativeFreeAllocationPlanner(db, { ...options.sources,
    loadPrior: (funds, signal) => loadAuditedMiningPriorForBacking(db, funds, signal) });
  return createPublicationPreparer(db, options, plan);
}
type InitialPlan = Awaited<ReturnType<ReturnType<typeof createInitialFreeAllocationPlanner>>>;
type PublicationPlanner = (value:unknown) => Promise<Omit<Extract<InitialPlan,{projection:'READY'}>,'reservations'>
  | Omit<Exclude<InitialPlan,{projection:'READY'}>,'reservations'>>;
export function createPublicationPreparer(db: Db, options: MiningPublicationPreparationOptions,
  plan: PublicationPlanner) {
  const signer = new PublicKey(options.signer.toBytes());
  const connect = options.blockhashSource;
  return async function prepare(value: unknown) {
    const parsed = requestSchema.safeParse(value); if (!parsed.success) fail('INVALID_INPUT'); const input = parsed.data;
    const replay = (saved: PreparedMiningPublication) => {
      const scope = JSON.parse(saved.manifestJson).input as Record<string, unknown>;
      if (saved.attemptKey !== input.attemptKey || scope.epochId !== input.epochId || scope.day !== input.day || scope.policyVersion !== input.policyVersion)
        fail('IDEMPOTENCY_BODY_MISMATCH');
      return saved;
    };
    const prior = await getPreparedMiningPublication(db, input.epochId); if (prior) return replay(prior);
    if (!phaseEMiningEnabled()) fail('DISABLED');
    const result = await plan({ epochId: input.epochId, day: input.day, policyVersion: input.policyVersion });
    if (result.projection !== 'READY') return Object.freeze({ status: 'abort-proposed' as const, plan: result, consumptionAuthorized: false as const });
    const p = result.publication, manifest = JSON.parse(result.manifestJson);
    const funds = manifest.funding as { slot: number; config: { address: string; publisher: string; flags: number; latestDay: string };
      source: { genesisHash: string; programId: string }; };
    if (funds.config.publisher !== signer.toBase58() || (funds.config.flags & PUBLISH_PAUSED) !== 0
      || p.day - BigInt(funds.config.latestDay) > BigInt(POLICY.publisherMaxGapDays)) fail('PUBLISHER_UNAVAILABLE');
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    let block: Awaited<ReturnType<MiningPublicationBlockhashReader['getLatestBlockhashAndContext']>>;
    try {
      const rpc = connect(controller.signal);
      block = await Promise.race([(async () => {
        if (await rpc.getGenesisHash() !== funds.source.genesisHash) fail('BLOCKHASH_UNAVAILABLE');
        const b = await rpc.getLatestBlockhashAndContext({ commitment: 'finalized', minContextSlot: funds.slot });
        controller.signal.throwIfAborted();
        if (!Number.isSafeInteger(b.context.slot) || b.context.slot < funds.slot || !address.safeParse(b.value.blockhash).success
          || !Number.isSafeInteger(b.value.lastValidBlockHeight) || b.value.lastValidBlockHeight < 0
          || await rpc.getGenesisHash() !== funds.source.genesisHash) fail('BLOCKHASH_UNAVAILABLE');
        controller.signal.throwIfAborted(); return b;
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new MiningPublicationPreparationError('BLOCKHASH_UNAVAILABLE')); }, RPC_TIMEOUT_MS); })]);
    } catch { fail('BLOCKHASH_UNAVAILABLE'); }
    finally { if (timer) clearTimeout(timer); controller.abort(); }
    const c = manifest.funding.config as { keepMint: string; emissionReserveOwner: string };
    const identity = { programId: new PublicKey(funds.source.programId), keepMint: new PublicKey(c.keepMint), reserveOwner: new PublicKey(c.emissionReserveOwner) };
    const publication = publicationSchema.parse({ signer: signer.toBase58(), programId: identity.programId.toBase58(),
      keepMint: identity.keepMint.toBase58(), reserveOwner: identity.reserveOwner.toBase58(), sequence: String(p.sequence), root: p.root,
      total: String(p.total), leafCount: p.leafCount, kind: 0, day: String(p.day), budgetGross: String(p.budgetGross), freeGross: String(p.freeGross),
      deedGross: String(p.deedGross), playerNet: String(p.playerNet), recycle: String(p.recycle), tax: String(p.tax),
      taxCommitment: p.taxCommitment, taxVersion: p.taxVersion, splitStart: p.splitStart, splitEnd: p.splitEnd,
      blockhash: block.value.blockhash, lastValidBlockHeight: block.value.lastValidBlockHeight, blockhashContextSlot: block.context.slot });
    const bytes = publicationMessage(publication, result.sourceHash);
    try {
      return await db.transaction(async tx => {
        await owner(tx); await tx.execute(sql`select id from mining_ingot_epochs where id=${input.epochId} for update nowait`);
        const existing = await getPreparedMiningPublication(tx, input.epochId); if (existing) return replay(existing);
        // Every custody domain shares the same transaction-scoped sequence
        // fence. Losing preparation exits before either immutable INSERT.
        await assertMiningPublicationPreparationFence(tx, { epochId: input.epochId,
          genesisHash: funds.source.genesisHash, programId: publication.programId,
          configAddress: funds.config.address, sequence: publication.sequence }).catch(error => {
          if (error instanceof MiningPublicationPreparationFenceError) fail(error.code);
          throw error;
        });
        if (!phaseEMiningEnabled()) fail('DISABLED');
        await tx.execute(sql`insert into mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${input.epochId},${input.attemptKey},${bytes})`);
        const [attempt] = await tx.execute<{ reservations_sha256: string|null;contributions_sha256:string|null }>(sql`select reservations_sha256,contributions_sha256 from mining_publication_attempts where epoch_id=${input.epochId}`);
        if (!attempt) fail('SOURCE_CHANGED');
        if (isResourceMiningManifest(manifest.version)) {
          if (attempt.contributions_sha256 !== manifest.epoch.contributionSetSha256 || attempt.reservations_sha256 !== null) fail('SOURCE_CHANGED');
        } else if (attempt.reservations_sha256 !== manifest.epoch.reservationSetSha256 || attempt.contributions_sha256 !== null) fail('SOURCE_CHANGED');
        await tx.execute(sql`insert into mining_publication_manifests(epoch_id,manifest_json,publication) values(${input.epochId},${result.manifestJson},${JSON.stringify(publication)}::jsonb)`);
        const saved = await getPreparedMiningPublication(tx, input.epochId); if (!saved) fail('SOURCE_CONFLICT'); return saved;
      });
    } catch (error) {
      const e = error as { code?: string; cause?: { code?: string } }, code = e.cause?.code ?? e.code;
      if (code === '55P03') fail('BUSY'); if (code === '23505') fail('IDEMPOTENCY_BODY_MISMATCH'); throw error;
    }
  };
}

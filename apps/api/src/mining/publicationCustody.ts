/** Internal pre-publication fence. It neither proves publication nor consumes stock. */
import { PACKET_DATA_SIZE, VersionedMessage } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx } from '../db/client';
import { phaseEMiningEnabled } from '../config';

const MAX_RESERVATIONS = 10_000; // Technical bound shared with the capture trigger.
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const key = z.string().min(8).max(128).refine(value => value.trim() === value);
const requestSchema = z.object({ epochId: uuid, attemptKey: key, intentBytes: z.instanceof(Uint8Array) }).strict();
const sourceSchema = z.object({ reservationId: uuid, baseId: uuid, actorWallet: z.string().min(1).max(128), ingots: z.number().int().positive().max(2147483647) }).strict();
const receiptSchema = z.object({
  epochId: uuid, attemptKey: key, intentHex: z.string().regex(/^(?:[0-9a-f]{2})+$/).max(PACKET_DATA_SIZE * 2),
  intentSha256: z.string().regex(/^[0-9a-f]{64}$/), reservationSetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  reservationCount: z.number().int().positive().max(MAX_RESERVATIONS), reservedIngots: z.string().regex(/^[1-9][0-9]*$/),
  reservations: z.array(sourceSchema).min(1).max(MAX_RESERVATIONS), preparedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  publicationFinalized: z.literal(false), consumptionAuthorized: z.literal(false),
}).strict();
export type MiningPublicationAttempt = z.infer<typeof receiptSchema>;
export interface MiningPublicationAttemptRequest { epochId: string; attemptKey: string; intentBytes: Uint8Array }
type Code = 'INVALID_INPUT' | 'DISABLED' | 'BUSY' | 'OWNER_REQUIRED' | 'EPOCH_UNAVAILABLE' | 'SOURCE_CONFLICT' | 'ABORTED' | 'EMPTY' | 'TOO_LARGE' | 'IDEMPOTENCY_BODY_MISMATCH';
export class MiningPublicationCustodyError extends Error {
  constructor(readonly code: Code) { super(`Mining publication custody refused: ${code}`); this.name = 'MiningPublicationCustodyError'; }
}
function fail(code: Code): never { throw new MiningPublicationCustodyError(code); }
async function owner(db: DbOrTx): Promise<void> {
  const [row] = await db.execute<{ allowed: boolean }>(sql`select current_user=(select pg_get_userbyid(relowner) from pg_catalog.pg_class where oid='public.mining_publication_attempts'::regclass) allowed`);
  if (!row?.allowed) fail('OWNER_REQUIRED');
}
async function read(db: DbOrTx, epochId: string): Promise<MiningPublicationAttempt | null> {
  const [row] = await db.execute<{ receipt: unknown }>(sql`select jsonb_build_object(
    'epochId',epoch_id,'attemptKey',attempt_key,'intentHex',encode(intent_bytes,'hex'),'intentSha256',intent_sha256,
    'reservationSetSha256',reservations_sha256,'reservationCount',reservation_count,'reservedIngots',reserved_ingots::text,
    'reservations',reservations,'preparedAt',to_char(prepared_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'publicationFinalized',false,'consumptionAuthorized',false) receipt from public.mining_publication_attempts where epoch_id=${epochId}`);
  if (!row) return null;
  const parsed = receiptSchema.safeParse(row.receipt); if (!parsed.success) fail('SOURCE_CONFLICT');
  const receipt = parsed.data;
  if (receipt.reservationCount !== receipt.reservations.length || new Set(receipt.reservations.map(r => r.reservationId)).size !== receipt.reservationCount
      || receipt.reservations.reduce((sum, r) => sum + BigInt(r.ingots), 0n) !== BigInt(receipt.reservedIngots)) fail('SOURCE_CONFLICT');
  return receipt;
}
/** Operator recovery is GET-only and stays available while admission is paused. */
export async function getMiningPublicationAttempt(db: DbOrTx, epochId: string): Promise<MiningPublicationAttempt | null> {
  if (!uuid.safeParse(epochId).success) fail('INVALID_INPUT');
  await owner(db); return read(db, epochId);
}
/** Persist BEFORE signing/enqueuing. Bytes are a canonical unsigned Solana message,
 * not a caller assertion of funding, scoring or approval. No network work runs here. */
export async function beginMiningPublicationAttempt(db: Db, input: MiningPublicationAttemptRequest): Promise<MiningPublicationAttempt> {
  const parsed = requestSchema.safeParse(input); if (!parsed.success) fail('INVALID_INPUT');
  const { epochId, attemptKey } = parsed.data;
  if (!parsed.data.intentBytes.length || parsed.data.intentBytes.length > PACKET_DATA_SIZE) fail('INVALID_INPUT');
  const bytes = Buffer.from(parsed.data.intentBytes); // Own the exact body before any await.
  try { if (!Buffer.from(VersionedMessage.deserialize(bytes).serialize()).equals(bytes)) fail('INVALID_INPUT'); }
  catch { fail('INVALID_INPUT'); }
  const intentHex = bytes.toString('hex');
  const replay = (receipt: MiningPublicationAttempt): MiningPublicationAttempt => {
    if (receipt.attemptKey !== attemptKey || receipt.intentHex !== intentHex) fail('IDEMPOTENCY_BODY_MISMATCH');
    return receipt;
  };
  try {
    return await db.transaction(async tx => {
      await owner(tx);
      const prior = await read(tx, epochId); if (prior) return replay(prior);
      if (!phaseEMiningEnabled()) fail('DISABLED');
      const epoch = await tx.execute(sql`select id from public.mining_ingot_epochs where id=${epochId} for update nowait`);
      if (!epoch.length) fail('EPOCH_UNAVAILABLE');
      const duplicate = await read(tx, epochId); if (duplicate) return replay(duplicate);
      if (!phaseEMiningEnabled()) fail('DISABLED');
      await tx.execute(sql`insert into public.mining_publication_attempts(epoch_id,attempt_key,intent_bytes) values(${epochId},${attemptKey},${bytes})`);
      const saved = await read(tx, epochId); if (!saved) fail('SOURCE_CONFLICT'); return saved;
    });
  } catch (error) {
    const e = error as { code?: string; message?: string; cause?: { code?: string; message?: string } }; const code = e.cause?.code ?? e.code;
    const message = e.cause?.message ?? e.message;
    if (message === 'MINING_PUBLICATION_ABORTED') fail('ABORTED');
    if (message === 'MINING_PUBLICATION_EMPTY') fail('EMPTY');
    if (message === 'MINING_PUBLICATION_TOO_LARGE') fail('TOO_LARGE');
    if (code === '55P03') fail('BUSY'); if (code === '23505') fail('IDEMPOTENCY_BODY_MISMATCH'); throw error;
  }
}

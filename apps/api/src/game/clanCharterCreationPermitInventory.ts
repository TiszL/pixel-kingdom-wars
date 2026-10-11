/** Private unsigned candidate storage only. No issuer, policy admission, expiry
 * selection, signing, activation, cancellation execution or refund capability.
 * Uses the S5-held B6l funding and prospective 0221 hooks; no runtime is mounted. */
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { CHARTER_REGISTRATION_PERMIT_BYTES, decodeCharterRegistrationPermit, encodeCharterRegistrationPermit,
  hashCharterRegistrationPayload } from '@shardkeep/chain/charter-protocol';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import type { CharterCreationReservation } from './clanCharterCreationReservations';
import { copyCharterCreationConsent, recoverCharterCreationConsent } from './clanCharterCreationConsent';
import type { CharterCreationCancellationSavedRecord } from '@shardkeep/chain/charter-creation-cancellation';

export interface CharterCreationPermitInventory {
  readonly reservation: CharterCreationReservation;
  readonly admission: Readonly<{ version: 1; preimageHex: string; commitment: string }>;
  readonly permitInventory: Readonly<{ version: 1; revision: '0' | '1'; count: 0 | 1;
    messages: readonly Readonly<{ messageHex: string; messageSha256: string; permitId: string; expiry: bigint }>[] }>;
  readonly mintAuthorized: false; readonly paymentAuthorized: false; readonly signingAuthorized: false;
  readonly activationAuthorized: false; readonly refundAuthorized: false; readonly reservationReleaseAuthorized: false;
}
const uuid = z.string().length(36).pipe(z.uuid());
const hash = z.string().length(64).regex(/^[0-9a-f]+$/);
// Technical decoder cap, not a price, TTL or policy number. 0221 retains the
// same bounded SQL UTF8 byte preimage. Bound hex before allocation/JSON parsing.
const preimageHex = z.string().min(4).max(16384 * 2).regex(/^(?:[0-9a-f]{2})+$/);
const stored = z.object({
  reservation: z.object({ consent: z.unknown(), reserveTransactionId: uuid,
    state: z.enum(['reserved', 'activated', 'cancelled_unpaid', 'refunded']) }).strict(),
  admission: z.object({ version: z.literal(1), preimageHex, commitment: hash }).strict(),
  message: z.object({ messageHex: z.string().length(CHARTER_REGISTRATION_PERMIT_BYTES * 2).regex(/^[0-9a-f]+$/),
    messageSha256: hash }).strict().nullable(),
}).strict();
const preimage = z.object({ domain: z.literal('SHARDKEEP_CHARTER_CREATION_ADMISSION'), version: z.literal(1),
  consent: z.unknown(), reserveTransactionId: uuid }).strict();
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fail(suffix: string): never {
  throw new HttpError(suffix === 'CONFLICT' ? 409 : 503, 'Charter permit inventory refused', 'CLAN_CHARTER_INVENTORY_' + suffix);
}
function translate(error: unknown): never {
  if (error instanceof HttpError) throw error;
  let cause = error;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && (cause.code === 'P0001' || cause.code === '42501') && 'message' in cause
      && typeof cause.message === 'string' && /^CLAN_CHARTER_INVENTORY_[A-Z_]+$/.test(cause.message)) {
      return fail(cause.message.slice('CLAN_CHARTER_INVENTORY_'.length));
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return fail('HELD');
}
function intent(value: string): string {
  if (!uuid.safeParse(value).success) return fail('INPUT');
  return value;
}
function payer(value: string): string {
  if (typeof value !== 'string' || value.length < 32 || value.length > 44) return fail('INPUT');
  try { const key = new PublicKey(value); if (!key.equals(PublicKey.default) && key.toBase58() === value) return value; }
  catch { /* The caller identity is invalid, not a different original. */ }
  return fail('INPUT');
}
function candidate(value: Uint8Array): Buffer {
  try { if (value instanceof Uint8Array && value.byteLength === CHARTER_REGISTRATION_PERMIT_BYTES) return Buffer.from(value); }
  catch { /* Includes detached or otherwise unreadable typed arrays. */ }
  return fail('INPUT');
}

function decodeMessage(bytes: Buffer, reservation: CharterCreationReservation, commitment: string) {
  const c = reservation.consent, key = (field: keyof typeof c.chain) => new PublicKey(c.chain[field]);
  const expected = hashCharterRegistrationPayload({ config: key('config'), craftProgram: key('craftProgram'), craftControl: key('craftControl'),
    collection: key('collection'), collectionAuthority: key('collectionAuthority'), charter: key('charter'), asset: key('asset'),
    assetBinding: key('assetBinding'), freezeAuthority: key('freezeAuthority'), executor: key('executor'), creationReceipt: key('creationReceipt'),
    clanId: c.clanId, leader: new PublicKey(c.payer), creationIntentId: c.creationIntentId,
    metadataHash: Buffer.from(c.metadata.hash, 'hex'), admissionCommitment: Buffer.from(commitment, 'hex') });
  const value = decodeCharterRegistrationPermit(bytes);
  if (!encodeCharterRegistrationPermit(value).equals(bytes) || value.genesisHash.toBase58() !== c.chain.genesisHash
    || value.programId.toBase58() !== c.chain.economyProgram || value.wallet.toBase58() !== c.payer
    || !Buffer.from(value.payloadHash).equals(expected)) throw Error('Invalid original Charter permit');
  return Object.freeze({ messageHex: bytes.toString('hex'), messageSha256: sha(bytes),
    permitId: Buffer.from(value.permitId).toString('hex'), expiry: value.expiry });
}

/** Internal historical decoder for terminal recovery. It confers no candidate
 * append capability; every ordinary inventory operation stays reserved-only. */
export function decodeCharterCreationInventoryBacking(value: unknown, requested: string): CharterCreationPermitInventory {
  try {
    const data = stored.parse(value), consent = copyCharterCreationConsent(data.reservation.consent);
    if (consent.creationIntentId !== requested) return fail('HELD');
    const reservation = Object.freeze({ consent, reserveTransactionId: data.reservation.reserveTransactionId, state: data.reservation.state });
    const bytes = Buffer.from(data.admission.preimageHex, 'hex'), text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes) || sha(bytes) !== data.admission.commitment) return fail('HELD');
    const admitted = preimage.parse(JSON.parse(text));
    if (admitted.reserveTransactionId !== reservation.reserveTransactionId) return fail('HELD');
    // Compare two explicit canonical historical copies, not SQL versus JS JSON
    // serialization. Today's price, owner, policy flags and Clock are irrelevant.
    recoverCharterCreationConsent(consent, admitted.consent);
    const messages = data.message === null ? [] : [decodeMessage(Buffer.from(data.message.messageHex, 'hex'), reservation, data.admission.commitment)];
    if (data.message !== null && messages[0]!.messageSha256 !== data.message.messageSha256) return fail('HELD');
    const count = messages.length === 0 ? 0 : 1;
    return Object.freeze({ reservation, admission: Object.freeze({ ...data.admission }),
      permitInventory: Object.freeze({ version: 1 as const, revision: count === 0 ? '0' as const : '1' as const,
        count, messages: Object.freeze(messages) }),
      mintAuthorized: false as const, paymentAuthorized: false as const, signingAuthorized: false as const,
      activationAuthorized: false as const, refundAuthorized: false as const, reservationReleaseAuthorized: false as const });
  } catch { return fail('HELD'); }
}
async function locked(tx: DbTx, originalPayer: string | null, requested: string) {
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_permit_read(${originalPayer},${requested}::uuid) value`);
  const saved = decodeCharterCreationInventoryBacking(row?.value, requested);
  if (saved.reservation.state !== 'reserved') return fail('HELD');
  return saved;
}

/** Detached exact original for the internally constructed B6k reader. */
export function charterCreationCancellationRecord(saved: CharterCreationPermitInventory): CharterCreationCancellationSavedRecord {
  const c = saved.reservation.consent;
  return Object.freeze({ original: Object.freeze({ creationIntentId: c.creationIntentId, clanId: c.clanId, payer: c.payer,
    metadata: c.metadata, chain: c.chain, admissionCommitment: saved.admission.commitment }),
    permitInventory: Object.freeze({ version: 1 as const, revision: saved.permitInventory.revision, count: saved.permitInventory.count,
      messages: Object.freeze(saved.permitInventory.messages.map(m => Buffer.from(m.messageHex, 'hex'))) }) });
}

export function createCharterCreationPermitInventory(db: Db) {
  if ('rollback' in db) return fail('TOP_LEVEL');
  async function read(originalPayer: string, intentId: string): Promise<CharterCreationPermitInventory> {
    payer(originalPayer); intent(intentId);
    try { return await db.transaction(tx => locked(tx, originalPayer, intentId), { isolationLevel: 'read committed' }); }
    catch (error) { return translate(error); }
  }
  async function recordPrepared(originalPayer: string, intentId: string, message: Uint8Array): Promise<CharterCreationPermitInventory> {
    payer(originalPayer); intent(intentId);
    // Detach before the first database await, including lock acquisition.
    const bytes = candidate(message);
    try {
      return await db.transaction(async tx => {
        // Validate stored evidence first. A malformed retained candidate cannot
        // be filtered, repaired or replaced by presenting another valid input.
        const saved = await locked(tx, originalPayer, intentId), previous = saved.permitInventory.messages[0];
        if (previous) {
          if (previous.messageHex !== bytes.toString('hex')) return fail('CONFLICT');
          return saved;
        }
        try { decodeMessage(bytes, saved.reservation, saved.admission.commitment); }
        catch { return fail('INPUT'); }
        await tx.execute(sql`insert into public.charter_creation_permit_messages(reservation_id,message_bytes)
          values(${saved.reservation.consent.reservationId}::uuid,${bytes})`);
        const recorded = await locked(tx, originalPayer, intentId);
        if (recorded.permitInventory.count !== 1 || recorded.permitInventory.messages[0]!.messageHex !== bytes.toString('hex')) return fail('HELD');
        return recorded;
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  async function loadForCancellation(intentId: string): Promise<CharterCreationCancellationSavedRecord> {
    intent(intentId);
    try {
      const saved = await db.transaction(tx => locked(tx, null, intentId), { isolationLevel: 'read committed' });
      return charterCreationCancellationRecord(saved);
    } catch (error) { return translate(error); }
  }
  return Object.freeze({ read, recordPrepared, loadForCancellation });
}

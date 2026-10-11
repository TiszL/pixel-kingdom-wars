/** Private original Charter funding. No issuer or terminal/refund capability.
 * Today's price/flags and the application-owned new domain are trusted facade
 * admission inputs. SQL binds immutable consent to an actual affordable debit;
 * it does not independently authenticate deployment policy or earlier balances.
 */
import { BASE_OWNERSHIP } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { phaseECharterEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { bootstrapSystemAccounts, getOrCreateBaseAccount } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';
import {
  captureCharterCreationConsent, copyCharterCreationConsent, recoverCharterCreationConsent,
  CharterCreationConsentError, type CharterCreationConsent,
} from './clanCharterCreationConsent';
import { lockStablePrerequisiteBase } from './stableBasePrerequisites';

export interface CharterCreationReservation {
  readonly consent: CharterCreationConsent;
  readonly reserveTransactionId: string;
  readonly state: 'reserved' | 'activated' | 'cancelled_unpaid' | 'refunded';
}
export interface CharterCreationDomain {
  readonly genesisHash: string;
  readonly economyProgram: string;
  readonly craftProgram: string;
}
const uuid = z.uuid();
const address = z.string().min(32).max(44).refine(value => {
  try { const key = new PublicKey(value); return !key.equals(PublicKey.default) && key.toBase58() === value; }
  catch { return false; }
});
const domainSchema = z.object({ genesisHash: address, economyProgram: address, craftProgram: address }).strict();
const resultSchema = z.object({ consent: z.unknown(), reserveTransactionId: uuid,
  state: z.enum(['reserved', 'activated', 'cancelled_unpaid', 'refunded']) }).strict();
function fail(code: string): never {
  const conflict = code === 'CLAN_CHARTER_CREATION_PENDING' || code === 'CLAN_CHARTER_CREATION_OUTSTANDING'
    || code === 'CLAN_CHARTER_CREATION_CONSENT_CONFLICT';
  throw new HttpError(conflict ? 409 : 503, 'Charter creation reservation refused', code);
}
function translate(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof CharterCreationConsentError) return fail(
    error.code === 'CONSENT_CONFLICT' ? 'CLAN_CHARTER_CREATION_CONSENT_CONFLICT' : 'CLAN_CHARTER_CREATION_CONSENT',
  );
  // Inspect exact PostgreSQL leaf errors. Drizzle's outer message contains SQL
  // and caller metadata, neither of which is a trustworthy refusal identifier.
  let cause = error;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && cause.code === '55P03') return fail('CLAN_CHARTER_CREATION_BUSY');
    if ('code' in cause && (cause.code === 'P0001' || cause.code === '42501') && 'message' in cause
      && typeof cause.message === 'string') {
      if (/^CLAN_CHARTER_CREATION_[A-Z_]+$/.test(cause.message)) return fail(cause.message);
      if (/^CLAN_CHARTER_CUSTODY_[A-Z_]+$/.test(cause.message)) return fail('CLAN_CHARTER_CREATION_CUSTODY');
    }
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return fail('CLAN_CHARTER_CREATION_HELD');
}
function parseIdentity(wallet: string, intent: string) {
  if (!address.safeParse(wallet).success || !uuid.safeParse(intent).success) return fail('CLAN_CHARTER_CREATION_CONSENT');
}
function decode(value: unknown, wallet: string, intent: string): CharterCreationReservation | null {
  if (value === null) return null;
  const parsed = resultSchema.safeParse(value);
  if (!parsed.success) return fail('CLAN_CHARTER_CREATION_HELD');
  const consent = copyCharterCreationConsent(parsed.data.consent);
  if (consent.payer !== wallet || consent.creationIntentId !== intent) return fail('CLAN_CHARTER_CREATION_HELD');
  return Object.freeze({ consent, reserveTransactionId: parsed.data.reserveTransactionId, state: parsed.data.state });
}
async function readOriginal(tx: DbTx, wallet: string, intent: string) {
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_creation_read(${wallet},${intent}::uuid) value`);
  return decode(row?.value, wallet, intent);
}
async function currentCustody(tx: DbTx, consent: CharterCreationConsent) {
  const [row] = await tx.execute<{ value: Record<string, unknown> | null }>(sql`
    select public.shardkeep_charter_custody_read(${consent.funding.baseId}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);
  const proof = row?.value;
  if (!proof || proof['authority'] !== 'current' || proof['baseId'] !== consent.funding.baseId
    || proof['deedAssetId'] !== consent.funding.deedAssetId || proof['ownerWallet'] !== consent.payer
    || proof['id'] !== consent.funding.ownershipEpoch.id
    || proof['evidenceCommitment'] !== consent.funding.ownershipEpoch.evidenceCommitment) return fail('CLAN_CHARTER_CREATION_CUSTODY');
}

export function createCharterCreationReservations(db: Db, options: { newCreationDomain: CharterCreationDomain | null }) {
  if ('rollback' in db) return fail('CLAN_CHARTER_CREATION_TOP_LEVEL');
  const parsedDomain = domainSchema.nullable().safeParse(options.newCreationDomain);
  if (!parsedDomain.success) return fail('CLAN_CHARTER_CREATION_DOMAIN');
  const domain = parsedDomain.data === null ? null : Object.freeze(parsedDomain.data);

  async function read(wallet: string, intent: string): Promise<CharterCreationReservation | null> {
    parseIdentity(wallet, intent);
    try {
      return await db.transaction(async tx => {
        await tx.execute(sql`select public.shardkeep_charter_creation_owner()`);
        return readOriginal(tx, wallet, intent);
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  async function reserve(wallet: string, input: unknown): Promise<CharterCreationReservation> {
    try {
      // Copy before the first await. Historical structural copy deliberately
      // precedes today's price check, so an original can survive policy changes.
      const consent = copyCharterCreationConsent(input);
      parseIdentity(wallet, consent.creationIntentId);
      if (consent.payer !== wallet) return fail('CLAN_CHARTER_CREATION_PAYER');
      return await db.transaction(async tx => {
        await tx.execute(sql`select public.shardkeep_charter_creation_owner()`);
        const player = await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
        const prior = await readOriginal(tx, wallet, consent.creationIntentId);
        if (prior) {
          recoverCharterCreationConsent(prior.consent, consent);
          return prior;
        }
        if (!player.length) return fail('CLAN_CHARTER_CREATION_CUSTODY');
        captureCharterCreationConsent(consent);
        if (!phaseECharterEnabled()) return fail('CLAN_CHARTER_CREATION_DISABLED');
        if (!domain || domain.genesisHash !== consent.chain.genesisHash
          || domain.economyProgram !== consent.chain.economyProgram || domain.craftProgram !== consent.chain.craftProgram) {
          return fail('CLAN_CHARTER_CREATION_DOMAIN');
        }
        await lockStablePrerequisiteBase(tx, wallet, {
          baseId: consent.funding.baseId, assertAuthority: async locked => currentCustody(locked, consent),
        });
        // Account creation and the ledger's idempotency-first, sorted money
        // locks precede clan barriers. No burn or spend-quest helper is involved.
        const system = await bootstrapSystemAccounts(tx);
        const source = await getOrCreateBaseAccount(tx, consent.funding.baseId, 'base_shards');
        const amount = BigInt(consent.price.shards);
        const posted = await postTransaction(tx, {
          idempotencyKey: `charter-create:${consent.creationIntentId}`, type: 'clan.charter.reserve',
          metadata: { version: 1, consent },
          entries: [{ account: source.id, delta: -amount }, { account: system.charter_creation_escrow, delta: amount }],
        });
        if (posted.duplicate) return fail('CLAN_CHARTER_CREATION_HELD');
        await tx.execute(sql`lock table public.clans,public.clan_members in share mode nowait`);
        // The SQL guard repeats current custody and all pending/live exclusions
        // under these barriers, with only NOWAIT acquisition after the money.
        await currentCustody(tx, consent);
        if (!phaseECharterEnabled()) return fail('CLAN_CHARTER_CREATION_DISABLED');
        await tx.execute(sql`insert into public.charter_creation_reservations(consent,reserve_transaction_id)
          values(${JSON.stringify(consent)}::jsonb,${posted.transaction.id}::uuid)`);
        return await readOriginal(tx, wallet, consent.creationIntentId) ?? fail('CLAN_CHARTER_CREATION_HELD');
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  return Object.freeze({ reserve, read });
}

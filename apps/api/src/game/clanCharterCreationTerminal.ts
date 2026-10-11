/** Private original Charter completion and original-payer refund recovery.
 * The application supplies trusted chain transport/configuration, never caller
 * observations. No issuer, expiry policy or HTTP runtime is mounted here. */
import type { CharterCreationEvidenceRpc, CharterCreationEvidenceTrust } from '@shardkeep/chain/charter-creation-evidence';
import { createCharterCreationCancellationReader } from '@shardkeep/chain/charter-creation-cancellation';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import { bootstrapSystemAccounts, getOrCreateBaseAccount } from '../ledger/accounts';
import { postTransaction } from '../ledger/ledger';
import { clans, clanMembers } from '../db/schema';
import { copyCharterCreationConsent, recoverCharterCreationConsent, type CharterCreationConsent } from './clanCharterCreationConsent';
import { charterCreationCancellationRecord, createCharterCreationPermitInventory, decodeCharterCreationInventoryBacking,
  type CharterCreationPermitInventory } from './clanCharterCreationPermitInventory';
import { ensureQuests, progressQuestBatch } from './quests';

export interface CharterCreationTerminalResult {
  readonly consent: CharterCreationConsent;
  readonly reserveTransactionId: string;
  readonly state: 'activated' | 'cancelled_unpaid' | 'refunded';
  readonly terminalId: string;
  readonly terminalTransactionId: string | null;
  readonly refundTransactionId: string | null;
  readonly refundDestinationBaseId: string | null;
}
export interface CharterCreationTerminalOptions {
  readonly chain: Readonly<{
    connect: (signal: AbortSignal) => CharterCreationEvidenceRpc;
    trust: CharterCreationEvidenceTrust;
  }> | null;
}

const uuid = z.string().length(36).pipe(z.uuid());
const hash = z.string().length(64).regex(/^[0-9a-f]+$/);
const address = z.string().min(32).max(44).refine(value => {
  try { const key = new PublicKey(value); return !key.equals(PublicKey.default) && key.toBase58() === value; } catch { return false; }
});
const slot = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer = z.string().max(20).regex(/^-?(?:0|[1-9][0-9]*)$/).refine(value => BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n));
const positive = integer.refine(value => BigInt(value) > 0n);
const account = z.object({ address, owner: address.nullable(), executable: z.boolean().nullable(), dataSha256: hash.nullable() }).strict();
const source = z.object({ trust: z.literal('trusted-finalized-rpc-reviewed-program'), stateProvenance: z.literal('fresh-reviewed-deployment'), genesisHash: address,
  programs: z.array(z.object({ programId: address, reviewedDeploymentSlot: slot, reviewedProgramDataSha256: hash, upgradeAuthority: address.nullable() }).strict()).length(3),
  accounts: z.array(account).length(14) }).strict();
const noAuthority = { transactionProofVerified: z.literal(false), paymentAuthorized: z.literal(false), activationAuthorized: z.literal(false),
  reservationReleaseAuthorized: z.literal(false) };
const mint = z.object({ version: z.literal(1), creationIntentId: uuid, clanId: uuid, payer: address, charter: address, asset: address, creationReceipt: address,
  metadataHash: hash, admissionCommitment: hash, permitId: z.string().length(32).regex(/^[0-9a-f]+$/), slot, unixTimestamp: positive, createdAt: integer,
  source, finalizedMintObserved: z.literal(true), ...noAuthority }).strict();
const baseObservation = { version: z.literal(1), original: z.unknown(),
  inventory: z.object({ version: z.literal(1), revision: z.enum(['0', '1']), count: z.union([z.literal(0), z.literal(1)]),
    messages: z.array(z.object({ messageHex: z.string().length(322).regex(/^[0-9a-f]+$/),
      permitId: z.string().length(32).regex(/^[0-9a-f]+$/), expiry: integer }).strict()).max(1) }).strict(),
  slot, unixTimestamp: positive, source, inventoryAuthenticated: z.literal(false), signingAuthorized: z.literal(false), refundAuthorized: z.literal(false), ...noAuthority };
const observationSchema = z.discriminatedUnion('outcome', [z.object({ ...baseObservation, outcome: z.literal('minted'), mint }).strict(),
  z.object({ ...baseObservation, outcome: z.literal('absent-after-expiry') }).strict()]);
const resultSchema = z.object({ consent: z.unknown(), reserveTransactionId: uuid, state: z.enum(['activated', 'cancelled_unpaid', 'refunded']),
  terminalId: uuid, terminalTransactionId: uuid.nullable(), refundTransactionId: uuid.nullable(), refundDestinationBaseId: uuid.nullable() }).strict();
const envelope = z.object({ result: resultSchema, inventory: z.unknown(), observation: z.unknown() }).strict();
const json = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
function fail(code: string): never { throw new HttpError(code === 'BUSY' || code === 'STALE_INVENTORY' ? 409 : 503,
  'Charter creation completion refused', 'CLAN_CHARTER_TERMINAL_' + code); }
function translate(error: unknown): never {
  if (error instanceof HttpError && error.code?.startsWith('CLAN_CHARTER_TERMINAL_')) throw error;
  let cause = error;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && cause.code === '55P03') return fail('BUSY');
    if ('code' in cause && (cause.code === 'P0001' || cause.code === '42501') && 'message' in cause
      && typeof cause.message === 'string' && /^CLAN_CHARTER_TERMINAL_[A-Z_]+$/.test(cause.message))
      return fail(cause.message.slice('CLAN_CHARTER_TERMINAL_'.length));
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return fail('HELD');
}
function identity(wallet: string, intent: string) { if (!address.safeParse(wallet).success || !uuid.safeParse(intent).success) return fail('INPUT'); }
function snapshot(saved: CharterCreationPermitInventory) {
  return { reservation: { consent: saved.reservation.consent, reserveTransactionId: saved.reservation.reserveTransactionId }, admission: saved.admission,
    message: saved.permitInventory.count === 0 ? null : { messageHex: saved.permitInventory.messages[0]!.messageHex,
      messageSha256: saved.permitInventory.messages[0]!.messageSha256 } };
}

/** Recheck retained consistency from canonical message bytes, without opening
 * RPC or treating retained hashes as independent finality authentication. */
function observation(value: unknown, saved: CharterCreationPermitInventory) {
  const v = observationSchema.parse(value), record = charterCreationCancellationRecord(saved), c = saved.reservation.consent;
  if (!isDeepStrictEqual(v.original, record.original) || v.inventory.revision !== saved.permitInventory.revision || v.inventory.count !== saved.permitInventory.count
    || !isDeepStrictEqual(v.inventory.messages, saved.permitInventory.messages.map(m => ({ messageHex: m.messageHex, permitId: m.permitId, expiry: m.expiry.toString() })))) return fail('STALE_INVENTORY');
  const loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const programIds = [c.chain.economyProgram, c.chain.craftProgram, 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'];
  const addresses = programIds.flatMap(id => [id, PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], loader)[0].toBase58()]);
  addresses.push(c.chain.config, c.chain.craftControl, c.chain.charter, c.chain.creationReceipt, c.chain.assetBinding, c.chain.asset,
    c.chain.collection, SYSVAR_CLOCK_PUBKEY.toBase58());
  if (v.source.genesisHash !== c.chain.genesisHash || v.source.programs.some((p, i) => p.programId !== programIds[i] || p.reviewedDeploymentSlot > v.slot)
    || v.source.accounts.some((a, i) => a.address !== addresses[i])) return fail('HELD');
  for (const [i, a] of v.source.accounts.entries()) {
    const absent = v.outcome === 'absent-after-expiry' && i >= 8 && i <= 11;
    if (absent ? a.owner !== null || a.executable !== null || a.dataSha256 !== null : a.owner === null || a.executable === null || a.dataSha256 === null) return fail('HELD');
    if (i < 6 && (a.owner !== loader.toBase58() || a.executable !== (i % 2 === 0))) return fail('HELD');
    if (i < 6 && i % 2 === 1 && a.dataSha256 !== v.source.programs[Math.floor(i / 2)]!.reviewedProgramDataSha256) return fail('HELD');
    const owner = i === 7 ? c.chain.craftProgram : i === 11 || i === 12 ? programIds[2]
      : i === 13 ? 'Sysvar1111111111111111111111111111111111111' : c.chain.economyProgram;
    if (i >= 6 && !absent && (a.owner !== owner || a.executable !== false)) return fail('HELD');
  }
  if (v.outcome === 'minted') {
    const m = v.mint;
    if (saved.permitInventory.count !== 1 || m.creationIntentId !== c.creationIntentId || m.clanId !== c.clanId || m.payer !== c.payer
      || m.charter !== c.chain.charter || m.asset !== c.chain.asset || m.creationReceipt !== c.chain.creationReceipt
      || m.metadataHash !== c.metadata.hash || m.admissionCommitment !== saved.admission.commitment || m.permitId !== saved.permitInventory.messages[0]!.permitId
      || m.slot !== v.slot || m.unixTimestamp !== v.unixTimestamp || BigInt(m.createdAt) <= 0n || BigInt(m.createdAt) > BigInt(v.unixTimestamp)
      || !isDeepStrictEqual(m.source, v.source)) return fail('HELD');
  } else if (saved.permitInventory.messages.some(m => m.expiry >= BigInt(v.unixTimestamp))) return fail('HELD');
  return v;
}
function decode(value: unknown, wallet: string, intent: string): CharterCreationTerminalResult | null {
  if (value === null) return null;
  const raw = envelope.parse(value), saved = decodeCharterCreationInventoryBacking(raw.inventory, intent), c = copyCharterCreationConsent(raw.result.consent);
  recoverCharterCreationConsent(saved.reservation.consent, c);
  if (c.payer !== wallet || c.creationIntentId !== intent || raw.result.reserveTransactionId !== saved.reservation.reserveTransactionId
    || raw.result.state !== saved.reservation.state) return fail('HELD');
  const proof = observation(raw.observation, saved);
  if ((raw.result.state === 'activated') !== (proof.outcome === 'minted')) return fail('HELD');
  return Object.freeze({ ...raw.result, consent: c });
}
async function readLocked(tx: DbTx, wallet: string, intent: string) {
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_terminal_read(${wallet},${intent}::uuid,false) value`);
  return decode(row?.value, wallet, intent);
}
async function backing(tx: DbTx, wallet: string, intent: string) {
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_terminal_inventory(${wallet},${intent}::uuid) value`);
  return decodeCharterCreationInventoryBacking(row?.value, intent);
}

export function createCharterCreationTerminal(db: Db, options: CharterCreationTerminalOptions) {
  if ('rollback' in db) return fail('TOP_LEVEL');
  // One reader retains the B6k total deadline and bounded ignored-work slots.
  const inventory = createCharterCreationPermitInventory(db);
  const observe = options.chain === null ? null : createCharterCreationCancellationReader(options.chain.connect, options.chain.trust,
    intent => inventory.loadForCancellation(intent));
  async function read(wallet: string, intent: string): Promise<CharterCreationTerminalResult | null> {
    identity(wallet, intent);
    try { return await db.transaction(tx => readLocked(tx, wallet, intent), { isolationLevel: 'read committed' }); }
    catch (error) { return translate(error); }
  }
  async function recover(wallet: string, intent: string): Promise<CharterCreationTerminalResult> {
    identity(wallet, intent);
    try {
      const prior = await read(wallet, intent); if (prior) return prior;
      if (!observe) return fail('HELD');
      let observed: unknown;
      try { observed = JSON.parse(json(await observe(intent))); }
      catch (error) { const raced = await read(wallet, intent); if (raced) return raced; throw error; }
      // Resolve original base outside the mutation transaction; repeat all
      // immutable identity comparisons after taking the mutation locks.
      const original = await db.transaction(tx => backing(tx, wallet, intent), { isolationLevel: 'read committed' });
      return await db.transaction(async tx => {
        await tx.execute(sql`select public.shardkeep_charter_terminal_owner()`);
        await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
        await tx.execute(sql`select id from public.bases where id=${original.reservation.consent.funding.baseId}::uuid for update`);
        const existing = await readLocked(tx, wallet, intent); if (existing) return existing;
        const saved = await backing(tx, wallet, intent), c = saved.reservation.consent;
        recoverCharterCreationConsent(original.reservation.consent, c);
        const proof = observation(observed, saved), retained = snapshot(saved);
        if (proof.outcome === 'minted') {
          const [time] = await tx.execute<{ at: string }>(sql`select current_timestamp::text at`);
          const at = new Date(time!.at); await ensureQuests(tx, at.toISOString().slice(0, 10));
          const accounts = await bootstrapSystemAccounts(tx), amount = BigInt(c.price.shards);
          if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return fail('HELD');
          const posted = await postTransaction(tx, { idempotencyKey: `charter-activate:${intent}`, type: 'clan.charter.activate',
            entries: [{ account: accounts.charter_creation_escrow, delta: -amount }, { account: accounts.shard_burn, delta: amount }],
            metadata: { version: 1, reservationId: c.reservationId, inventory: retained, observation: proof } });
          if (posted.duplicate) return fail('HELD');
          await progressQuestBatch(tx, '', [['spend_200', Number(amount)], ['spend_500', Number(amount)]], at, c.funding.baseId);
          // Money and quest work are complete before taking this write-capable
          // barrier; NOWAIT avoids a SHARE-lock upgrade race with legacy paths.
          await tx.execute(sql`lock table public.clans,public.clan_members in share row exclusive mode nowait`);
          await tx.insert(clans).values({ id: c.clanId, name: c.clan.name, tag: c.clan.tag, leaderWallet: wallet,
            inviteMode: c.clan.inviteMode, inviteCode: c.clan.inviteMode === 'invite' ? randomBytes(6).toString('base64url') : null });
          await tx.insert(clanMembers).values({ clanId: c.clanId, playerWallet: wallet });
        }
        await tx.execute(sql`insert into public.charter_creation_terminals(reservation_id,inventory,observation)
          values(${c.reservationId}::uuid,${json(retained)}::jsonb,${json(proof)}::jsonb)`);
        const state = proof.outcome === 'minted' ? 'activated' : 'cancelled_unpaid';
        await tx.execute(sql`update public.charter_creation_reservations set state=${state} where id=${c.reservationId}::uuid`);
        return (await readLocked(tx, wallet, intent)) ?? fail('HELD');
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  async function claimRefund(wallet: string, intent: string, destinationBaseId?: string): Promise<CharterCreationTerminalResult> {
    identity(wallet, intent); if (destinationBaseId !== undefined && !uuid.safeParse(destinationBaseId).success) return fail('INPUT');
    try {
      const prior = await read(wallet, intent);
      if (!prior || prior.state === 'activated') return fail('STATE');
      if (prior.state === 'refunded') return prior;
      const destination = destinationBaseId ?? prior.consent.funding.baseId, automatic = destinationBaseId === undefined;
      return await db.transaction(async tx => {
        await tx.execute(sql`select public.shardkeep_charter_terminal_owner()`);
        await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
        // This wait is deliberately before reservation, inventory and money
        // locks. The subsequent SQL authority check sees committed fresh rows.
        await tx.execute(sql`select id from public.bases where id=${destination}::uuid for update`);
        await tx.execute(sql`select base_id from public.base_slots where base_id=${destination}::uuid and wallet=${wallet} for update`);
        await tx.execute(sql`select base_id from public.base_raid_locks where base_id=${destination}::uuid for update`);
        const current = await readLocked(tx, wallet, intent);
        if (!current || current.state === 'activated') return fail('STATE');
        if (current.state === 'refunded') return current;
        recoverCharterCreationConsent(prior.consent, current.consent);
        const c = current.consent;
        await tx.execute(sql`select public.shardkeep_charter_terminal_destination(${c.reservationId}::uuid,${destination}::uuid,${automatic})`);
        const accounts = await bootstrapSystemAccounts(tx), to = await getOrCreateBaseAccount(tx, destination, 'base_shards'), amount = BigInt(c.price.shards);
        const posted = await postTransaction(tx, { idempotencyKey: `charter-refund:${intent}`, type: 'clan.charter.refund',
          entries: [{ account: accounts.charter_creation_escrow, delta: -amount }, { account: to.id, delta: amount }],
          metadata: { version: 1, reservationId: c.reservationId, destinationBaseId: destination, automatic } });
        if (posted.duplicate) return fail('HELD');
        await tx.execute(sql`insert into public.charter_creation_refunds(reservation_id) values(${c.reservationId}::uuid)`);
        await tx.execute(sql`update public.charter_creation_reservations set state='refunded' where id=${c.reservationId}::uuid`);
        // The deferred completion repeats this fresh authority check and both
        // actual cache movements immediately before transaction commit.
        await tx.execute(sql`select public.shardkeep_charter_terminal_destination(${c.reservationId}::uuid,${destination}::uuid,${automatic})`);
        return (await readLocked(tx, wallet, intent)) ?? fail('HELD');
      }, { isolationLevel: 'read committed' });
    } catch (error) { return translate(error); }
  }
  return Object.freeze({ read, recover, claimRefund });
}

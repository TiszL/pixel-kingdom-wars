/** Private prospective policy admission descriptor, not a signing capability.
 * The application owns the trust, transport and process-monotonic clock. Past
 * records are historical consistency evidence, never current signing freshness.
 * S5-held: no route, signer or production configuration is mounted here. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { BASE_OWNERSHIP, PHASE_E_CHARTER_ADMISSION, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { createCharterAdmissionReader } from '@shardkeep/chain/charter-admission';
import type { CharterAdmissionObservation } from '@shardkeep/chain/charter-admission';
import type { CharterCreationEvidenceRpc, CharterCreationEvidenceTrust } from '@shardkeep/chain/charter-creation-evidence';
import { encodeCharterRegistrationPermit, hashCharterRegistrationPayload } from '@shardkeep/chain/charter-protocol';
import { phaseECharterEnabled } from '../config';
import type { Db, DbTx } from '../db/client';
import { HttpError } from '../lib/errors';
import type { CharterCreationConsent } from './clanCharterCreationConsent';
import { copyCharterCreationConsent, recoverCharterCreationConsent } from './clanCharterCreationConsent';
import { decodeCharterCreationInventoryBacking, type CharterCreationPermitInventory } from './clanCharterCreationPermitInventory';
import { lockStablePrerequisiteBase } from './stableBasePrerequisites';

export interface CharterCreationPolicyAdmission {
  readonly version: 1;
  readonly id: string;
  readonly original: Readonly<{ consent: CharterCreationConsent; reserveTransactionId: string }>;
  readonly admission: CharterCreationPermitInventory['admission'];
  readonly candidate: Readonly<{ messageHex: string; messageSha256: string; permitId: string; expiry: bigint }>;
  readonly policy: Readonly<{ version: 1; currentSigner: string; observation: CharterAdmissionObservation }>;
  readonly timing: Readonly<{ startedMs: number; recordSampleMs: number; elapsedMs: number }>;
  readonly transactionProofVerified: false; readonly signingAuthorized: false; readonly mintAuthorized: false;
  readonly paymentAuthorized: false; readonly activationAuthorized: false; readonly refundAuthorized: false;
  readonly reservationReleaseAuthorized: false;
}
export interface CharterCreationPolicyAdmissionOptions {
  readonly chain: Readonly<{ connect: (signal: AbortSignal) => CharterCreationEvidenceRpc;
    trust: CharterCreationEvidenceTrust; expectedCurrentSigner: string }> | null;
  readonly monotonicNow?: () => number;
}
const uuid = z.string().length(36).pipe(z.uuid());
const hash = z.string().length(64).regex(/^[0-9a-f]+$/);
const address = z.string().min(32).max(44).refine(value => {
  try { const key = new PublicKey(value); return !key.equals(PublicKey.default) && key.toBase58() === value; }
  catch { return false; }
});
const slot = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const clock = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const integer = z.string().max(20).regex(/^-?(?:0|[1-9][0-9]*)$/)
  .refine(value => BigInt(value) >= -(1n << 63n) && BigInt(value) < (1n << 63n)).transform(value => BigInt(value));
const positive = integer.refine(value => value > 0n);
const noAuthority = { transactionProofVerified: z.literal(false), signingAuthorized: z.literal(false), mintAuthorized: z.literal(false),
  paymentAuthorized: z.literal(false), activationAuthorized: z.literal(false), refundAuthorized: z.literal(false), reservationReleaseAuthorized: z.literal(false) };
const observationSchema = z.object({ version: z.literal(1),
  domain: z.object({ genesisHash: address, economyProgram: address, craftProgram: address }).strict(),
  authority: z.object({ address, currentPolicyKey: address, previousPolicyKey: address.nullable(), previousValidUntil: integer,
    admissionPaused: z.literal(false) }).strict(),
  craftControl: z.object({ address, admissionPaused: z.literal(false) }).strict(), expectedCurrentSigner: address, currentSignerObserved: z.literal(true),
  slot, unixTimestamp: positive,
  source: z.object({ trust: z.literal('trusted-finalized-rpc-reviewed-program'), stateProvenance: z.literal('fresh-reviewed-deployment'), genesisHash: address,
    programs: z.array(z.object({ programId: address, reviewedDeploymentSlot: slot, reviewedProgramDataSha256: hash, upgradeAuthority: address.nullable() }).strict()).length(3),
    accounts: z.array(z.object({ address, owner: address, executable: z.boolean(), dataSha256: hash }).strict()).length(10) }).strict(),
  ...noAuthority }).strict();
const recordSchema = z.object({ version: z.literal(1), id: uuid,
  original: z.object({ consent: z.unknown(), reserveTransactionId: uuid }).strict(),
  admission: z.object({ version: z.literal(1), preimageHex: z.string().min(4).max(32768).regex(/^(?:[0-9a-f]{2})+$/), commitment: hash }).strict(),
  candidate: z.object({ messageHex: z.string().length(322).regex(/^[0-9a-f]+$/), messageSha256: hash,
    permitId: z.string().length(32).regex(/^[0-9a-f]+$/), expiry: positive }).strict(),
  policy: z.object({ version: z.literal(1), currentSigner: address, observation: observationSchema }).strict(),
  timing: z.object({ startedMs: clock, recordSampleMs: clock, elapsedMs: clock }).strict(), ...noAuthority }).strict();
const envelope = z.object({ record: z.unknown().nullable(), inventory: z.unknown() }).strict();
const policy = PHASE_E_CHARTER_ADMISSION.v1;
const json = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item);
function fail(code: string): never { throw new HttpError(code === 'BUSY' ? 409 : 503, 'Charter policy admission refused', 'CLAN_CHARTER_POLICY_' + code); }
function translate(error: unknown): never {
  if (error instanceof HttpError && error.code?.startsWith('CLAN_CHARTER_POLICY_')) throw error;
  let cause = error;
  for (let n = 0; n < 8 && cause && typeof cause === 'object'; n++) {
    if ('code' in cause && cause.code === '55P03') return fail('BUSY');
    if ('code' in cause && (cause.code === 'P0001' || cause.code === '42501') && 'message' in cause
      && typeof cause.message === 'string' && /^CLAN_CHARTER_POLICY_[A-Z_]+$/.test(cause.message))
      return fail(cause.message.slice('CLAN_CHARTER_POLICY_'.length));
    cause = 'cause' in cause ? cause.cause : undefined;
  }
  return fail('HELD');
}
function identity(wallet: string, intent: string) { if (!address.safeParse(wallet).success || !uuid.safeParse(intent).success) return fail('INPUT'); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function checkObservation(observed: CharterAdmissionObservation, c: CharterCreationConsent, signer: string) {
  const chain = c.chain, loader = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
  const programIds = [chain.economyProgram, chain.craftProgram, 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d'];
  const authority = PublicKey.findProgramAddressSync([Buffer.from('seeker_authority')], new PublicKey(chain.economyProgram))[0].toBase58();
  const addresses = programIds.flatMap(id => [id, PublicKey.findProgramAddressSync([new PublicKey(id).toBuffer()], loader)[0].toBase58()]);
  addresses.push(authority, chain.config, chain.craftControl, SYSVAR_CLOCK_PUBKEY.toBase58());
  if (!isDeepStrictEqual(observed.domain, { genesisHash: chain.genesisHash, economyProgram: chain.economyProgram, craftProgram: chain.craftProgram })
    || observed.authority.address !== authority || observed.craftControl.address !== chain.craftControl
    || observed.expectedCurrentSigner !== signer || observed.authority.currentPolicyKey !== signer
    || observed.authority.previousPolicyKey === signer
    || (observed.authority.previousPolicyKey === null && observed.authority.previousValidUntil !== 0n)
    || observed.source.genesisHash !== chain.genesisHash) return fail('HELD');
  for (const [i, program] of observed.source.programs.entries()) {
    if (program.programId !== programIds[i] || program.reviewedDeploymentSlot > observed.slot
      || program.reviewedProgramDataSha256 !== observed.source.accounts[i * 2 + 1]!.dataSha256) return fail('HELD');
  }
  for (const [i, account] of observed.source.accounts.entries()) {
    const owner = i < 6 ? loader.toBase58() : i < 8 ? chain.economyProgram
      : i === 8 ? chain.craftProgram : 'Sysvar1111111111111111111111111111111111111';
    if (account.address !== addresses[i] || account.owner !== owner || account.executable !== (i < 6 && i % 2 === 0)) return fail('HELD');
  }
}
function decodeRecord(value: unknown, saved: CharterCreationPermitInventory): CharterCreationPolicyAdmission {
  const v = recordSchema.parse(value), c = copyCharterCreationConsent(v.original.consent), message = saved.permitInventory.messages[0];
  recoverCharterCreationConsent(saved.reservation.consent, c);
  if (v.original.reserveTransactionId !== saved.reservation.reserveTransactionId || !isDeepStrictEqual(v.admission, saved.admission)
    || !message || !isDeepStrictEqual(v.candidate, message)) return fail('HELD');
  checkObservation(v.policy.observation, c, v.policy.currentSigner);
  if (v.candidate.expiry !== v.policy.observation.unixTimestamp + BigInt(policy.issuedPermitTtlSec)
    || v.timing.recordSampleMs < v.timing.startedMs || v.timing.elapsedMs !== v.timing.recordSampleMs - v.timing.startedMs
    || v.timing.elapsedMs > policy.observationMaxAgeMs) return fail('HELD');
  return freeze({ ...v, original: { ...v.original, consent: c } });
}
async function load(tx: DbTx, wallet: string, intent: string) {
  const [row] = await tx.execute<{ value: unknown }>(sql`select public.shardkeep_charter_policy_read(${wallet},${intent}::uuid) value`);
  if (row?.value === null) return null;
  const raw = envelope.parse(row?.value), saved = decodeCharterCreationInventoryBacking(raw.inventory, intent);
  if (saved.reservation.consent.payer !== wallet) return fail('PAYER');
  return { saved, record: raw.record === null ? null : decodeRecord(raw.record, saved) };
}
async function currentCustody(tx: DbTx, c: CharterCreationConsent) {
  const [row] = await tx.execute<{ value: Record<string, unknown> | null }>(sql`
    select public.shardkeep_charter_custody_read(${c.funding.baseId}::uuid,${BASE_OWNERSHIP.mutationFreshnessMs}::integer) value`);
  const proof = row?.value;
  if (!proof || proof['authority'] !== 'current' || proof['baseId'] !== c.funding.baseId || proof['deedAssetId'] !== c.funding.deedAssetId
    || proof['ownerWallet'] !== c.payer || proof['id'] !== c.funding.ownershipEpoch.id
    || proof['evidenceCommitment'] !== c.funding.ownershipEpoch.evidenceCommitment) return fail('HELD');
}

export function createCharterCreationPolicyAdmission(db: Db, options: CharterCreationPolicyAdmissionOptions) {
  if ('rollback' in db) return fail('TOP_LEVEL');
  if (!Number.isSafeInteger(policy.issuedPermitTtlSec) || policy.issuedPermitTtlSec <= 0
    || policy.issuedPermitTtlSec > PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec) return fail('HELD');
  // B6m detaches and validates application-owned trust/key at construction. No
  // observer callback, caller candidate/expiry or policy assertion is accepted.
  const configured = options.chain;
  let observe: (() => Promise<CharterAdmissionObservation>) | null;
  try { observe = configured === null ? null
    : createCharterAdmissionReader(configured.connect, configured.trust, configured.expectedCurrentSigner); }
  catch { return fail('HELD'); }
  const domain = configured === null ? null : Object.freeze({ genesisHash: configured.trust.expectedGenesisHash,
    economyProgram: configured.trust.economy.programId, craftProgram: configured.trust.craft.programId });
  const time = options.monotonicNow ?? (() => performance.now());
  if (typeof time !== 'function') return fail('HELD');

  async function read(wallet: string, intent: string): Promise<CharterCreationPolicyAdmission | null> {
    identity(wallet, intent);
    try { return await db.transaction(async tx => (await load(tx, wallet, intent))?.record ?? null,
      { isolationLevel: 'read committed' }); }
    catch (error) { return translate(error); }
  }
  async function admit(wallet: string, intent: string): Promise<CharterCreationPolicyAdmission> {
    identity(wallet, intent);
    try {
      const original = await db.transaction(tx => load(tx, wallet, intent), { isolationLevel: 'read committed' });
      if (original?.record) return original.record;
      if (!original || original.saved.reservation.state !== 'reserved' || original.saved.permitInventory.count !== 0
        || !phaseECharterEnabled() || !observe || !domain) return fail('HELD');
      const c = original.saved.reservation.consent;
      if (domain.genesisHash !== c.chain.genesisHash || domain.economyProgram !== c.chain.economyProgram
        || domain.craftProgram !== c.chain.craftProgram) return fail('HELD');
      // Start immediately before RPC, outside all SQL locks. Keep every bit of
      // monotonic precision: 10000.9ms must not become an accepted 10000ms.
      const started = time(); if (!clock.safeParse(started).success) return fail('STALE');
      let previous = started;
      const sample = () => {
        const now = time();
        if (!clock.safeParse(now).success || now < previous || now - started > policy.observationMaxAgeMs) return fail('STALE');
        previous = now; return now;
      };
      const observed = await observe(); sample();
      checkObservation(observed, c, observed.expectedCurrentSigner);
      const expiry = observed.unixTimestamp + BigInt(policy.issuedPermitTtlSec);
      if (observed.unixTimestamp <= 0n || expiry <= observed.unixTimestamp || expiry >= (1n << 63n)) return fail('HELD');
      const key = (field: keyof typeof c.chain) => new PublicKey(c.chain[field]);
      const bytes = encodeCharterRegistrationPermit({ genesisHash: key('genesisHash'), programId: key('economyProgram'), kind: 5,
        permitId: randomBytes(16), wallet: new PublicKey(wallet), expiry,
        payloadHash: hashCharterRegistrationPayload({ config: key('config'), craftProgram: key('craftProgram'), craftControl: key('craftControl'),
          collection: key('collection'), collectionAuthority: key('collectionAuthority'), charter: key('charter'), asset: key('asset'),
          assetBinding: key('assetBinding'), freezeAuthority: key('freezeAuthority'), executor: key('executor'), creationReceipt: key('creationReceipt'),
          clanId: c.clanId, leader: new PublicKey(wallet), creationIntentId: c.creationIntentId,
          metadataHash: Buffer.from(c.metadata.hash, 'hex'), admissionCommitment: Buffer.from(original.saved.admission.commitment, 'hex') }) });
      // The same complete B6n decoder validates new and historical messages.
      const proposed = decodeCharterCreationInventoryBacking({ reservation: original.saved.reservation, admission: original.saved.admission,
        message: { messageHex: bytes.toString('hex'), messageSha256: createHash('sha256').update(bytes).digest('hex') } }, intent);
      return await db.transaction(async tx => {
        await tx.execute(sql`select public.shardkeep_charter_policy_owner()`);
        await tx.execute(sql`select wallet from public.players where wallet=${wallet} for update`);
        const base = await lockStablePrerequisiteBase(tx, wallet, { baseId: c.funding.baseId,
          assertAuthority: locked => currentCustody(locked, c) });
        if (!base.landPaidAt || base.deedAssetId !== c.funding.deedAssetId) return fail('HELD');
        const current = await load(tx, wallet, intent);
        if (current?.record) return current.record;
        if (!current || current.saved.reservation.state !== 'reserved' || current.saved.permitInventory.count !== 0
          || !isDeepStrictEqual(current.saved, original.saved)) return fail('HELD');
        if (!phaseECharterEnabled()) return fail('HELD');
        await currentCustody(tx, c);
        const recordSample = sample();
        const value: CharterCreationPolicyAdmission = { version: 1, id: randomUUID(),
          original: { consent: c, reserveTransactionId: original.saved.reservation.reserveTransactionId }, admission: original.saved.admission,
          candidate: proposed.permitInventory.messages[0]!, policy: { version: 1, currentSigner: observed.expectedCurrentSigner, observation: observed },
          timing: { startedMs: started, recordSampleMs: recordSample, elapsedMs: recordSample - started },
          transactionProofVerified: false, signingAuthorized: false, mintAuthorized: false, paymentAuthorized: false,
          activationAuthorized: false, refundAuthorized: false, reservationReleaseAuthorized: false };
        const wire = json(value); decodeRecord(JSON.parse(wire), proposed);
        await tx.execute(sql`insert into public.charter_creation_policy_admissions(id,reservation_id,record)
          values(${value.id}::uuid,${c.reservationId}::uuid,${wire}::jsonb)`);
        await tx.execute(sql`insert into public.charter_creation_permit_messages(reservation_id,message_bytes)
          values(${c.reservationId}::uuid,${bytes})`);
        const recorded = (await load(tx, wallet, intent))?.record;
        if (!recorded || !isDeepStrictEqual(recorded, value)) return fail('HELD');
        await currentCustody(tx, c);
        if (!phaseECharterEnabled()) return fail('HELD');
        // Last application acceptance check, after every private write/read.
        // Deliberately not persisted: historical samples cannot describe later
        // network commit latency, survive as fresh authority or permit signing.
        sample(); return recorded;
      }, { isolationLevel: 'read committed' });
    } catch (error) {
      // A concurrent legitimate first admission can win while RPC, custody or
      // a lock wait fails. Its immutable replay has no current-policy authority.
      const raced = await read(wallet, intent); if (raced) return raced;
      return translate(error);
    }
  }
  return Object.freeze({ admit, read });
}

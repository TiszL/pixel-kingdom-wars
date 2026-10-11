/** DARK D153.19 structural codec, not auction authority or dispatch admission.
 * No configured/fixture fallback, database access, source credit or tax payout.
 * Real readers must prove all registered auctions settled, including unsold spots,
 * against the actual network/program/config/PDA identities and finalized chain.
 * Neither a valid shape, a hash, nor this TypeScript type establishes that proof. */
import { createHash } from 'node:crypto';
import { isCanonicalSolanaSignature } from '@shardkeep/chain';
import { PHASE_E_POLICY, PHASE_E_EXPEDITION_TERM_V1 } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';

const u64Max = (1n << 64n) - 1n;
const u64 = z.string().refine(value => {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  const parsed = BigInt(value);
  return parsed <= u64Max && parsed.toString() === value;
}, 'Expected a canonical unsigned-int64 decimal string');
const key = z.string().min(32).max(44).refine(value => {
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}, 'Expected a canonical Solana 32-byte public key');
const signature = z.string().min(64).max(88).refine(isCanonicalSolanaSignature,
  'Expected a canonical Solana 64-byte signature');
const hash = z.string().length(64).regex(/^[0-9a-f]+$/);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const instant = z.string().length(24).datetime({ precision: 3 }).refine(value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}, 'Expected a canonical UTC millisecond timestamp');
const spot = z.object({
  spotId: z.number().int().min(0).max(PHASE_E_EXPEDITION_TERM_V1.totalSpots - 1),
  // Null means an explicitly settled unsold auction, never a missing row.
  ownerWallet: key.nullable(),
  auctionAccount: key,
  settlementSignature: signature,
  settlementSlot: u64,
  termsHash: hash,
}).strict();
const snapshotSchema = z.object({
  version: z.literal(1),
  termId: uuid,
  startsAt: instant,
  endsAt: instant,
  source: z.object({
    kind: z.literal('solana_auction_round'),
    // Genesis hash identifies the actual network, not a mutable RPC URL/label.
    genesisHash: key,
    programId: key,
    auctionConfig: key,
    round: u64,
  }).strict(),
  spots: z.array(spot).length(PHASE_E_EXPEDITION_TERM_V1.totalSpots),
}).strict().refine(value => Date.parse(value.endsAt) - Date.parse(value.startsAt)
  === PHASE_E_EXPEDITION_TERM_V1.operatingTermSec * 1_000,
'An operating term must contain exactly the frozen v1 seven days')
  .refine(value => new Set(value.spots.map(row => row.spotId)).size === value.spots.length,
    'Every registered spot needs exactly one settled result')
  .refine(value => new Set(value.spots.map(row => row.auctionAccount)).size === value.spots.length,
    'Different spots cannot reuse one auction account');

type ParsedSnapshot = z.infer<typeof snapshotSchema>;
export type ExpeditionTermSnapshot = Readonly<Omit<ParsedSnapshot, 'source' | 'spots'> & {
  source: Readonly<ParsedSnapshot['source']>;
  spots: ReadonlyArray<Readonly<ParsedSnapshot['spots'][number]>>;
}>;

/** Historical decoding never depends on today's term, flags or catalogue owner.
 * Canonical field order and spot order are stable; all nested values are cloned
 * and frozen. The format version must change before changing this hash encoding. */
export function parseExpeditionTermSnapshot(value: unknown): ExpeditionTermSnapshot {
  const parsed = snapshotSchema.parse(value);
  return Object.freeze({
    version: parsed.version, termId: parsed.termId, startsAt: parsed.startsAt, endsAt: parsed.endsAt,
    source: Object.freeze({
      kind: parsed.source.kind, genesisHash: parsed.source.genesisHash,
      programId: parsed.source.programId, auctionConfig: parsed.source.auctionConfig, round: parsed.source.round,
    }),
    spots: Object.freeze(parsed.spots.sort((a, b) => a.spotId - b.spotId).map(row => Object.freeze({
      spotId: row.spotId, ownerWallet: row.ownerWallet, auctionAccount: row.auctionAccount,
      settlementSignature: row.settlementSignature, settlementSlot: row.settlementSlot, termsHash: row.termsHash,
    }))),
  });
}

export function serializeExpeditionTermSnapshot(value: unknown): string {
  return JSON.stringify(parseExpeditionTermSnapshot(value));
}

export function hashExpeditionTermSnapshot(value: unknown): string {
  return createHash('sha256').update(serializeExpeditionTermSnapshot(value), 'utf8').digest('hex');
}

/** Integrity comparison for a future immutable stored identity, not authorization.
 * A real persistence layer must also enforce one snapshot per term identity. */
export function requireExpeditionTermIdentity(value: unknown, expectedTermId: string, expectedHash: string): ExpeditionTermSnapshot {
  const snapshot = parseExpeditionTermSnapshot(value);
  if (snapshot.termId !== uuid.parse(expectedTermId) || hashExpeditionTermSnapshot(snapshot) !== hash.parse(expectedHash))
    throw new Error('Expedition term identity does not match its original snapshot');
  return snapshot;
}

/** New operating admission uses today's supported policy. Keep this out of the
 * observation parser: that parser also reconstructs original saved receipts. */
export function requireCurrentExpeditionTermPolicy(): void {
  if (Number(PHASE_E_POLICY.seekerIsland.totalSpots) !== PHASE_E_EXPEDITION_TERM_V1.totalSpots
    || Number(PHASE_E_POLICY.seekerIsland.operatingTermSec) !== PHASE_E_EXPEDITION_TERM_V1.operatingTermSec)
    throw new Error('Expedition current policy differs from supported v1 term format');
}

const observationSchema = z.object({
  snapshot: snapshotSchema,
  finality: z.object({ commitment: z.literal('finalized'), contextSlot: u64, observedAt: instant }).strict(),
}).strict();
export interface ExpeditionTermObservation {
  readonly snapshot: ExpeditionTermSnapshot;
  readonly finality: Readonly<{ commitment: 'finalized'; contextSlot: string; observedAt: string }>;
}

/** Temporal/provenance consistency only. Server samples dispatch time under its
 * future admission locks. Auction finality must be observed no later than that
 * time; the OPERATING term is current, not finished. This does not verify RPC
 * claims or derive an authorized identity from the supplied addresses. */
export function parseExpeditionTermObservation(value: unknown, dispatchAt: string): ExpeditionTermObservation {
  const at = Date.parse(instant.parse(dispatchAt));
  const observation = observationSchema.parse(value);
  const snapshot = parseExpeditionTermSnapshot(observation.snapshot);
  if (at < Date.parse(snapshot.startsAt) || at >= Date.parse(snapshot.endsAt))
    throw new Error('Expedition operating term is not current at dispatch');
  if (Date.parse(observation.finality.observedAt) > at)
    throw new Error('Auction finality was not observed by dispatch');
  const contextSlot = BigInt(observation.finality.contextSlot);
  if (snapshot.spots.some(row => BigInt(row.settlementSlot) > contextSlot))
    throw new Error('Finalized observation precedes an auction settlement');
  return Object.freeze({ snapshot, finality: Object.freeze({ ...observation.finality }) });
}

/** Server-only injection boundary. A genuine adapter must positively close all
 * 100 spot auctions and verify full provenance before returning anything.
 * Unknown/partial/unfinalized data returns null or throws; never synthesize an
 * all-null owner list. Zero winners then retain tax in the ORIGINAL term until
 * separately authorized disposition, with no developer or later-term claimant. */
export interface ExpeditionTermReader {
  readOperatingTerm(dispatchAt: string): Promise<ExpeditionTermObservation | null>;
}
export const unavailableExpeditionTermReader: ExpeditionTermReader = Object.freeze({
  async readOperatingTerm(): Promise<null> { return null; },
});

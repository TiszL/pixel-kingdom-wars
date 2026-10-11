import { createHash } from 'node:crypto';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  hashExpeditionTermSnapshot, parseExpeditionTermObservation, parseExpeditionTermSnapshot,
  requireExpeditionTermIdentity, serializeExpeditionTermSnapshot, unavailableExpeditionTermReader,
} from '../src/game/expeditionTerms';

// Explicit test-only supplied data; these well-formed bytes establish no chain proof.
const pubkey = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const start = '2035-01-01T00:00:00.000Z';
const end = new Date(Date.parse(start) + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000).toISOString();
const signature = bs58.encode(new Uint8Array(64).fill(7));
function fixture() {
  return {
    version: 1, termId: 'f97d1830-0e72-4c4b-9d02-8e97e2c02d45', startsAt: start, endsAt: end,
    source: { kind: 'solana_auction_round', genesisHash: pubkey(201), programId: pubkey(202), auctionConfig: pubkey(203), round: '11' },
    spots: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({
      spotId, ownerWallet: spotId < 2 ? pubkey(204) : null,
      auctionAccount: pubkey(spotId + 1), settlementSignature: signature,
      settlementSlot: String(100 + spotId), termsHash: 'ab'.repeat(32),
    })),
  };
}
const observed = (snapshot = fixture()) => ({ snapshot,
  finality: { commitment: 'finalized', contextSlot: '200', observedAt: start } });

describe('dark expedition term integrity and observation boundary', () => {
  it('canonicalizes input field/spot order while retaining distinct shares for one owner', () => {
    const original = fixture();
    const reversed = { spots: [...original.spots].reverse(), source: { ...original.source },
      endsAt: end, startsAt: start, termId: original.termId.toUpperCase(), version: 1 };
    const canonical = serializeExpeditionTermSnapshot(original);
    expect(serializeExpeditionTermSnapshot(reversed)).toBe(canonical);
    expect(hashExpeditionTermSnapshot(reversed)).toBe(createHash('sha256').update(canonical).digest('hex'));
    const parsed = parseExpeditionTermSnapshot(reversed);
    expect(parsed.spots.map(row => row.spotId)).toEqual(original.spots.map(row => row.spotId));
    expect(parsed.spots.filter(row => row.ownerWallet === pubkey(204))).toHaveLength(2);
    expect(reversed.spots[0]!.spotId).toBe(PHASE_E_POLICY.seekerIsland.totalSpots - 1);
  });

  it('requires explicit settled evidence for every unsold spot rather than treating absence as zero winners', async () => {
    const zero = fixture(); zero.spots.forEach(row => { row.ownerWallet = null; });
    expect(parseExpeditionTermSnapshot(zero).spots.every(row => row.ownerWallet === null)).toBe(true);
    expect(parseExpeditionTermObservation(observed(zero), start).snapshot.termId).toBe(zero.termId);
    expect(await unavailableExpeditionTermReader.readOperatingTerm(start)).toBeNull();
    for (const spots of [[], zero.spots.slice(1), [...zero.spots, zero.spots[0]]])
      expect(() => parseExpeditionTermSnapshot({ ...zero, spots })).toThrow();
    const missing = fixture(); delete (missing.spots[99] as Partial<typeof missing.spots[number]>).settlementSignature;
    expect(() => parseExpeditionTermSnapshot(missing)).toThrow();
    expect(() => parseExpeditionTermSnapshot(null)).toThrow();
    expect(() => parseExpeditionTermSnapshot(undefined)).toThrow();
  });

  it('rejects unknown fields at every snapshot and observation level', () => {
    const term = fixture();
    for (const value of [{ ...term, verified: true }, { ...term, source: { ...term.source, trusted: true } },
      { ...term, spots: term.spots.map((row, i) => i === 0 ? { ...row, share: 99 } : row) }])
      expect(() => parseExpeditionTermSnapshot(value)).toThrow();
    expect(() => parseExpeditionTermObservation({ ...observed(), fallback: true }, start)).toThrow();
    expect(() => parseExpeditionTermObservation({ ...observed(), finality: { ...observed().finality, verified: true } }, start)).toThrow();
  });

  it.each([-1, 100, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid spot identity %s', spotId => {
    const term = fixture();
    expect(() => parseExpeditionTermSnapshot({ ...term, spots: term.spots.map((row, i) => i === 0 ? { ...row, spotId } : row) })).toThrow();
  });

  it('rejects duplicated spot IDs or auction accounts even when exactly100 rows were supplied', () => {
    const duplicateSpot = fixture(); duplicateSpot.spots[1]!.spotId = 0;
    expect(() => parseExpeditionTermSnapshot(duplicateSpot)).toThrow();
    const duplicateAuction = fixture(); duplicateAuction.spots[1]!.auctionAccount = duplicateAuction.spots[0]!.auctionAccount;
    expect(() => parseExpeditionTermSnapshot(duplicateAuction)).toThrow();
  });

  it.each(['wallet', '0'.repeat(32), '1'.repeat(31), '1'.repeat(33), `${pubkey(2)}\n`, '', 123, undefined])(
    'rejects invalid/noncanonical owner and source key %s', value => {
      const term = fixture();
      expect(() => parseExpeditionTermSnapshot({ ...term, spots: term.spots.map((row, i) => i === 0 ? { ...row, ownerWallet: value } : row) })).toThrow();
      expect(() => parseExpeditionTermSnapshot({ ...term, source: { ...term.source, genesisHash: value } })).toThrow();
    });

  it('requires canonical signature, terms hash, version, UUID and exact seven-day interval', () => {
    const term = fixture();
    for (const value of [{ ...term, version: '1' }, { ...term, version: 2 }, { ...term, termId: 'other' },
      { ...term, endsAt: start }, { ...term, endsAt: new Date(Date.parse(end) + 1).toISOString() },
      { ...term, startsAt: '2035-01-01T00:00:00Z' }, { ...term, startsAt: '2035-02-30T00:00:00.000Z' }])
      expect(() => parseExpeditionTermSnapshot(value)).toThrow();
    for (const patch of [{ settlementSignature: pubkey(1) }, { settlementSignature: `${signature}\n` },
      { termsHash: 'AB'.repeat(32) }, { termsHash: 'a'.repeat(63) + '\n' }])
      expect(() => parseExpeditionTermSnapshot({ ...term, spots: term.spots.map((row, i) => i === 0 ? { ...row, ...patch } : row) })).toThrow();
  });

  it.each(['-1', '+1', '01', '1\n', '1.0', '1e2', '18446744073709551616', 1])(
    'rejects malformed/overflow round, settlement slot and context slot %s', value => {
      const term = fixture();
      expect(() => parseExpeditionTermSnapshot({ ...term, source: { ...term.source, round: value } })).toThrow();
      expect(() => parseExpeditionTermSnapshot({ ...term, spots: term.spots.map((row, i) => i === 0 ? { ...row, settlementSlot: value } : row) })).toThrow();
      expect(() => parseExpeditionTermObservation({ ...observed(), finality: { ...observed().finality, contextSlot: value } }, start)).toThrow();
    });

  it('retains the full u64 domain without Number precision loss', () => {
    const term = fixture(); term.source.round = '18446744073709551615';
    term.spots.forEach(row => { row.settlementSlot = term.source.round; });
    const result = parseExpeditionTermObservation({ snapshot: term,
      finality: { commitment: 'finalized', contextSlot: term.source.round, observedAt: start } }, start);
    expect(result.snapshot.source.round).toBe(term.source.round);
    expect(result.snapshot.spots[99]!.settlementSlot).toBe(term.source.round);
  });

  it('includes start and excludes end at dispatch while historical decoding survives expiry', () => {
    expect(parseExpeditionTermObservation(observed(), start).snapshot.startsAt).toBe(start);
    expect(parseExpeditionTermObservation(observed(), new Date(Date.parse(end) - 1).toISOString()).snapshot.endsAt).toBe(end);
    for (const at of [new Date(Date.parse(start) - 1).toISOString(), end, 'not-time'])
      expect(() => parseExpeditionTermObservation(observed(), at)).toThrow();
    expect(parseExpeditionTermSnapshot(fixture()).endsAt).toBe(end);
  });

  it('requires finalized observations no later than dispatch and at/after every settlement slot', () => {
    for (const finality of [{ ...observed().finality, commitment: 'confirmed' },
      { ...observed().finality, observedAt: new Date(Date.parse(start) + 1).toISOString() },
      { ...observed().finality, contextSlot: '198' }])
      expect(() => parseExpeditionTermObservation({ snapshot: fixture(), finality }, start)).toThrow();
    expect(parseExpeditionTermObservation({ snapshot: fixture(), finality: { ...observed().finality, contextSlot: '199' } }, start).finality.contextSlot).toBe('199');
  });

  it('does not change stable identity when a later finalized RPC context reobserves it', () => {
    const first = parseExpeditionTermObservation(observed(), start);
    const laterAt = '2035-01-01T01:00:00.000Z';
    const later = parseExpeditionTermObservation({ snapshot: fixture(), finality: {
      commitment: 'finalized', contextSlot: '500', observedAt: laterAt,
    } }, laterAt);
    expect(hashExpeditionTermSnapshot(first.snapshot)).toBe(hashExpeditionTermSnapshot(later.snapshot));
    expect(later.finality).not.toEqual(first.finality);
  });

  it('refuses identity substitution in original economics and each stable provenance field', () => {
    const original = fixture(); const digest = hashExpeditionTermSnapshot(original);
    expect(requireExpeditionTermIdentity(original, original.termId, digest).termId).toBe(original.termId);
    const changes = [
      { ...original, termId: '053b157c-c6da-4216-a242-cdff9857c914' },
      { ...original, startsAt: '2035-01-02T00:00:00.000Z', endsAt: '2035-01-09T00:00:00.000Z' },
      ...['genesisHash', 'programId', 'auctionConfig'].map(field => ({ ...original, source: { ...original.source, [field]: pubkey(210) } })),
      { ...original, source: { ...original.source, round: '12' } },
      ...[{ ownerWallet: pubkey(205) }, { auctionAccount: pubkey(206) }, { settlementSignature: bs58.encode(new Uint8Array(64).fill(8)) },
        { settlementSlot: '201' }, { termsHash: 'cd'.repeat(32) }].map(patch => ({ ...original,
        spots: original.spots.map((row, i) => i === 0 ? { ...row, ...patch } : row) })),
    ];
    for (const changed of changes) expect(() => requireExpeditionTermIdentity(changed, original.termId, digest)).toThrow();
    expect(() => requireExpeditionTermIdentity(original, original.termId, digest.toUpperCase())).toThrow();
  });

  it('defensively clones and freezes every nested level without freezing caller input', () => {
    const input = observed(); const parsed = parseExpeditionTermObservation(input, start);
    const before = hashExpeditionTermSnapshot(parsed.snapshot);
    input.snapshot.spots[0]!.ownerWallet = pubkey(205); input.snapshot.source.round = '12';
    input.finality.contextSlot = '999'; input.snapshot.spots.reverse();
    expect(hashExpeditionTermSnapshot(parsed.snapshot)).toBe(before);
    for (const value of [parsed, parsed.snapshot, parsed.snapshot.source, parsed.snapshot.spots, ...parsed.snapshot.spots, parsed.finality])
      expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(input.snapshot)).toBe(false);
    expect(parsed.finality.contextSlot).toBe('200');
  });
});

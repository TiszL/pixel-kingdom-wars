/** Test-only reader observations, NOT finalized-chain authority. No fixture
 * reader is configured/exported in production; default admission refuses. */
import { createHash, randomUUID } from 'node:crypto';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { expeditionTermSnapshots } from '../src/db/schema';
import { hashExpeditionTermSnapshot, serializeExpeditionTermSnapshot, type ExpeditionTermReader } from '../src/game/expeditionTerms';
import { pinOperatingExpeditionTerm, readStoredExpeditionTerm } from '../src/game/expeditionTermStore';
import { connectTestDb } from './helpers';

const conn = connectTestDb(), db = conn.db;
afterAll(() => conn.sql.end());
const publicKey = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
const start = '2035-01-01T00:00:00.000Z';
const duration = PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000;
function fixture() {
  return { version: 1 as const, termId: randomUUID() as string, startsAt: start, endsAt: new Date(Date.parse(start) + duration).toISOString(),
    source: { kind: 'solana_auction_round' as const, genesisHash: publicKey(201), programId: publicKey(202), auctionConfig: Keypair.generate().publicKey.toBase58(), round: '1' },
    spots: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({ spotId, ownerWallet: spotId < 2 ? publicKey(204) : null,
      auctionAccount: publicKey(spotId + 1), settlementSignature: bs58.encode(new Uint8Array(64).fill(7)), settlementSlot: String(100 + spotId), termsHash: 'ab'.repeat(32) })) };
}
type Snapshot = ReturnType<typeof fixture>;
const reader = (snapshot: Snapshot, observedAt = snapshot.startsAt, contextSlot = '200'): ExpeditionTermReader => ({
  async readOperatingTerm() { return { snapshot, finality: { commitment: 'finalized', contextSlot, observedAt } }; },
});
const pin = (snapshot: Snapshot) => pinOperatingExpeditionTerm(db, new Date(snapshot.startsAt), reader(snapshot));
const shifted = (s: Snapshot, offset: number): Snapshot => ({ ...s, termId: randomUUID(), source: { ...s.source, round: String(BigInt(s.source.round) + 1n) },
  startsAt: new Date(Date.parse(s.startsAt) + offset).toISOString(), endsAt: new Date(Date.parse(s.endsAt) + offset).toISOString() });
const row = (s: Snapshot) => ({ termId: s.termId, snapshotHash: hashExpeditionTermSnapshot(s), canonical: serializeExpeditionTermSnapshot(s), snapshot: s,
  genesisHash: s.source.genesisHash, programId: s.source.programId, auctionConfig: s.source.auctionConfig, round: s.source.round,
  startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) });
const absent = async (s: Snapshot) => expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, s.termId))).toEqual([]);

describe('original term persistence behind a server reader', () => {
  it('pins canonical content once despite spot ordering and advancing observation metadata', async () => {
    const s = fixture(), proof = await pin(s);
    const at = new Date(Date.parse(start) + 1_000);
    const again = await pinOperatingExpeditionTerm(db, at, reader({ ...s, termId: s.termId.toUpperCase(), spots: [...s.spots].reverse() }, at.toISOString(), '500'));
    expect(again).toEqual(proof); expect(Object.isFrozen(again.snapshot.spots)).toBe(true);
    expect(await readStoredExpeditionTerm(db, s.termId.toUpperCase(), proof.hash)).toEqual(proof);
    expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, s.termId))).toHaveLength(1);
  });

  it('serializes concurrent exact duplicates to the same immutable proof', async () => {
    const s = fixture(), all = await Promise.all(Array.from({ length: 5 }, () => pin(s)));
    expect(all.every(p => p.hash === all[0]!.hash)).toBe(true);
    expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, s.termId))).toHaveLength(1);
  });

  it('refuses same UUID with changed body or source, including simultaneous different-source insertion', async () => {
    const s = fixture(), other = { ...fixture(), termId: s.termId };
    const results = await Promise.allSettled([pin(s), pin(other)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const a = fixture(), proof = await pin(a), changed = structuredClone(a);
    changed.spots[0]!.ownerWallet = publicKey(205);
    await expect(pin(changed)).rejects.toThrow('identity conflict');
    expect(await readStoredExpeditionTerm(db, a.termId, proof.hash)).toEqual(proof);
  });

  it('one source round cannot alias to another UUID even concurrently', async () => {
    const s = fixture(), alias = { ...s, termId: randomUUID() };
    const all = await Promise.allSettled([pin(s), pin(alias)]);
    expect(all.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(all.filter(r => r.status === 'rejected')).toHaveLength(1);
  });

  it.each([0, duration / 2, -duration / 2])('rejects overlapping source intervals at offset %s with different rounds', async offset => {
    const s = fixture(); await pin(s); const next = shifted(s, offset);
    await expect(pin(next)).rejects.toThrow('intervals overlap'); await absent(next);
  });

  it('serializes concurrent overlapping rounds but accepts adjacent half-open intervals', async () => {
    const s = fixture(), next = shifted(s, duration / 2);
    const all = await Promise.allSettled([pin(s), pin(next)]);
    expect(all.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(all.filter(r => r.status === 'rejected')).toHaveLength(1);
    const adjacent = fixture(); await pin(adjacent);
    expect((await pin(shifted(adjacent, duration))).snapshot.startsAt).toBe(adjacent.endsAt);
  });

  it('isolates network/program/config scope and preserves full u64 round strings', async () => {
    const s = fixture(); s.source.round = '18446744073709551615'; await pin(s);
    for (const field of ['genesisHash', 'programId', 'auctionConfig'] as const) {
      const independent = { ...s, termId: randomUUID(), source: { ...s.source, [field]: Keypair.generate().publicKey.toBase58() } };
      expect((await pin(independent)).snapshot.source.round).toBe(s.source.round);
    }
  });

  it('missing/null/error reader cannot fall back to a stored term or synthesize zero winners', async () => {
    const s = fixture(); await pin(s);
    await expect(pinOperatingExpeditionTerm(db, new Date(start))).rejects.toThrow('unavailable');
    await expect(pinOperatingExpeditionTerm(db, new Date(start), { async readOperatingTerm() { return null; } })).rejects.toThrow('unavailable');
    await expect(pinOperatingExpeditionTerm(db, new Date(start), { async readOperatingTerm() { throw new Error('RPC unavailable'); } })).rejects.toThrow('RPC unavailable');
    expect(await db.select().from(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, s.termId))).toHaveLength(1);
  });

  it('requires all explicit settled rows, while a positively supplied all-null winner set remains valid', async () => {
    const zero = fixture(); zero.spots.forEach(s => { s.ownerWallet = null; });
    expect((await pin(zero)).snapshot.spots.every(s => s.ownerWallet === null)).toBe(true);
    const partial = fixture(); partial.spots.pop(); await expect(pin(partial)).rejects.toThrow(); await absent(partial);
  });

  it('refuses stale/future term and observations obtained after the real dispatch sample', async () => {
    const s = fixture();
    for (const at of [new Date(Date.parse(start) - 1), new Date(s.endsAt)]) {
      await expect(pinOperatingExpeditionTerm(db, at, reader(s))).rejects.toThrow('not current');
    }
    await expect(pinOperatingExpeditionTerm(db, new Date(start), reader(s, new Date(Date.parse(start) + 1).toISOString()))).rejects.toThrow('not observed');
    await absent(s);
  });

  it('captures server time before awaiting the reader rather than accepting mutation/backdating', async () => {
    const s = fixture(), at = new Date(start);
    await expect(pinOperatingExpeditionTerm(db, at, { async readOperatingTerm(received) {
      expect(received).toBe(start); at.setTime(Date.parse(start) + 1_000);
      return { snapshot: s, finality: { commitment: 'finalized', contextSlot: '200', observedAt: at.toISOString() } };
    } })).rejects.toThrow('not observed'); await absent(s);
  });

  it('retains historical proof across restart/expiry without querying any reader', async () => {
    const s = fixture(), proof = await pin(s), reopened = connectTestDb();
    try { expect(await readStoredExpeditionTerm(reopened.db, s.termId, proof.hash)).toEqual(proof); }
    finally { await reopened.sql.end(); }
    await expect(pinOperatingExpeditionTerm(db, new Date(s.endsAt), reader(s))).rejects.toThrow();
    expect(await readStoredExpeditionTerm(db, s.termId, proof.hash)).toEqual(proof);
    await expect(readStoredExpeditionTerm(db, s.termId, '0'.repeat(64))).rejects.toThrow('hash differs');
    expect(await readStoredExpeditionTerm(db, randomUUID(), proof.hash)).toBeNull();
  });

  it('rolls back snapshot admission when the enclosing dispatch transaction fails', async () => {
    const s = fixture();
    await expect(db.transaction(async tx => { await pinOperatingExpeditionTerm(tx, new Date(start), reader(s)); throw new Error('job failed'); })).rejects.toThrow('job failed');
    await absent(s); expect((await pin(s)).hash).toBe(hashExpeditionTermSnapshot(s));
  });

  it('refuses repeatable-read outer transactions that could retain a stale pre-lock interval view', async () => {
    const s = fixture();
    await expect(db.transaction(tx => pinOperatingExpeditionTerm(tx, new Date(start), reader(s)), { isolationLevel: 'repeatable read' })).rejects.toThrow('read committed');
    await absent(s);
  });

  it('SQL independently rejects wrong hash, JSON/body projections, bounds and duration', async () => {
    for (const patch of ['hash', 'json', 'round', 'time', 'size'] as const) {
      const s = fixture(), r = row(s);
      if (patch === 'hash') r.snapshotHash = '0'.repeat(64);
      if (patch === 'json') r.snapshot = { ...s, termId: randomUUID() };
      if (patch === 'round') r.round = '18446744073709551616';
      if (patch === 'time') r.endsAt = new Date(Date.parse(s.endsAt) + 1);
      if (patch === 'size') { r.canonical += ' '.repeat(131072); r.snapshotHash = createHash('sha256').update(r.canonical).digest('hex'); }
      await expect(db.insert(expeditionTermSnapshots).values(r)).rejects.toThrow(); await absent(s);
    }
  });

  it('immutable SQL refuses update/delete/truncate of accepted evidence', async () => {
    const s = fixture(), proof = await pin(s);
    await expect(db.update(expeditionTermSnapshots).set({ snapshotHash: '0'.repeat(64) }).where(eq(expeditionTermSnapshots.termId, s.termId))).rejects.toThrow();
    await expect(db.delete(expeditionTermSnapshots).where(eq(expeditionTermSnapshots.termId, s.termId))).rejects.toThrow();
    let truncateSucceeded = false;
    await expect(db.transaction(async tx => {
      await tx.execute(sql`truncate expedition_term_snapshots`); truncateSucceeded = true;
      throw new Error('truncate unexpectedly succeeded');
    })).rejects.toThrow();
    expect(truncateSucceeded).toBe(false);
    expect(await readStoredExpeditionTerm(db, s.termId, proof.hash)).toEqual(proof);
  });

  it('historical decoding refuses hash-linked but noncanonical direct-SQL content', async () => {
    // Deliberately bypass the only runtime writer in a fixture. SQL checks byte
    // linkage, not full codec/canonical order; the reader must catch this too.
    const s = fixture(), r = row(s); r.canonical = JSON.stringify(s, null, 1);
    r.snapshotHash = createHash('sha256').update(r.canonical).digest('hex');
    await db.insert(expeditionTermSnapshots).values(r);
    await expect(readStoredExpeditionTerm(db, s.termId, r.snapshotHash)).rejects.toThrow('identity');
  });
});

/** K-night-08 (2026-10-10): the Seeker auction read over a multi-node RPC pool
 * (production SOLANA_RPC_URL is Helius). Account state here is a function of the
 * finalized slot; each call is answered by one pool node whose finalized slot the
 * scenario picks, and a node below minContextSlot answers JSON-RPC -32016 the way
 * Agave does. WHY it matters: every value the read publishes (bids, escrow, the
 * wallet balance, the bidding round) must be evidence at ONE finalized slot, or a
 * player is shown, and the issuer may sign over, a state that never existed. */
import { PHASE_E_SEEKER_AUCTION_RUNTIME } from '@shardkeep/shared';
import { SYSVAR_CLOCK_PUBKEY, type AccountInfo, type PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { readSeekerAuctionRound, withSeekerAuctionEvidenceBank, SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX }
  from '../src/seeker/auctionReadModel';
import { createSeekerAuctionFixture, wallet, type SeekerAuctionFixture } from '../../../packages/chain/src/testFixtures/seekerAuctionRead.fixture';

const R = PHASE_E_SEEKER_AUCTION_RUNTIME, CLOCK = SYSVAR_CLOCK_PUBKEY.toBase58();
type Row = AccountInfo<Buffer>;
type State = Map<string, Row>;
interface Scenario {
  /** Finalized slot of the pool node answering call `call` (1-based, in issue order). */
  node: (call: number, min: number) => number;
  /** Finalized edits visible from `slot` on (applied to a copy of the base state). */
  edit?: (state: State, slot: number, f: SeekerAuctionFixture) => void;
  /** A node that labels its answer one slot older than the bank it read (seen on Helius). */
  clockAhead?: (call: number) => boolean;
}
interface Call { label: string; keys: string[]; min: number; node: number; outcome: 'answered' | 'behind' }
const clone = (row: Row): Row => ({ ...row, data: Buffer.from(row.data) });

async function pool(scenario: Scenario, options: Parameters<typeof createSeekerAuctionFixture>[0] = { round: 5n, biddingRound: 5n }) {
  const f = await createSeekerAuctionFixture(options), base: State = new Map([...f.store].map(([key, row]) => [key, clone(row)]));
  const groups: [string, string[]][] = [
    ['core', []], ['selected', [f.termAddress.toBase58(), f.ata.toBase58()]],
    ['auctions', f.auctionAddresses.map(a => a.toBase58())], ['bids', f.bidAddresses.map(a => a.toBase58())]];
  const calls: Call[] = [];
  function stateAt(slot: number): State {
    const state: State = new Map([...base].map(([key, row]) => [key, clone(row)]));
    scenario.edit?.(state, slot, f);
    const clock = state.get(CLOCK)!.data; clock.writeBigUInt64LE(BigInt(slot)); clock.writeBigInt64LE(f.nowSec + BigInt(slot - 2000), 32);
    return state;
  }
  function label(keys: string[]): string {
    if (keys.length === 7 && keys[6] === CLOCK) return 'core';
    return groups.find(([, group]) => group.length === keys.length && group.every((key, i) => key === keys[i]))?.[0] ?? `recheck${keys.length}`;
  }
  const rpc = {
    getGenesisHash: async () => f.controls.genesisHash,
    getMultipleAccountsInfoAndContext: async (addresses: PublicKey[], options: { commitment: 'finalized'; minContextSlot: number }) => {
      const keys = addresses.map(a => a.toBase58()), call = calls.length + 1, node = scenario.node(call, options.minContextSlot);
      expect(options.commitment).toBe('finalized'); expect(keys.length).toBeLessThanOrEqual(100);
      if (node < options.minContextSlot) {
        calls.push({ label: label(keys), keys, min: options.minContextSlot, node, outcome: 'behind' });
        throw Object.assign(new Error('failed to get info about account: Minimum context slot has not been reached'), { code: -32016, data: { contextSlot: node } });
      }
      calls.push({ label: label(keys), keys, min: options.minContextSlot, node, outcome: 'answered' });
      const state = stateAt(scenario.clockAhead?.(call) ? node + 1 : node);
      return { context: { slot: node }, value: keys.map(key => { const row = state.get(key); return row ? clone(row) : null; }) };
    },
  };
  const source = { trust: f.source.trust, connect: (signal: AbortSignal) => { signal.throwIfAborted(); return rpc; } };
  const trace = () => calls.map(c => `${c.label}@${c.node}${c.outcome === 'behind' ? ' behind' : ''} min=${c.min}`);
  return { f, calls, stateAt, source, trace, read: (signal?: AbortSignal) => readSeekerAuctionRound(source, wallet.toBase58(), undefined, signal) };
}
const sequence = (slots: number[]) => (call: number) => slots[call - 1] ?? slots.at(-1)!;
const amountAt = (state: State, ata: PublicKey) => state.get(ata.toBase58())!.data.readBigUInt64LE(64);
const bumpAta = (from: number) => (state: State, slot: number, f: SeekerAuctionFixture) => {
  if (slot >= from) { const data = state.get(f.ata.toBase58())!.data; data.writeBigUInt64LE(data.readBigUInt64LE(64) + 1n, 64); }
};

describe('K-night-08 Seeker auction read over a multi-node pool', () => {
  it('re-validates admitted evidence when a pool node is ahead, retries a node behind the floor, and adopts one common slot', async () => {
    // Jitter: the auctions batch lands two slots ahead; the re-validation's two
    // concurrent batches first split (2003 vs 2002), and two nodes are behind.
    const p = await pool({ node: sequence([2000, 1999, 2000, 2002, 2003, 2002, 2001, 2003, 2003, 2003]) });
    const result = await p.read();
    expect(p.trace()).toEqual([
      'core@2000 min=100', 'selected@1999 behind min=2000', 'selected@2000 min=2000', 'auctions@2002 min=2000',
      'recheck100@2003 min=2002', 'recheck9@2002 min=2002', 'recheck100@2001 behind min=2003', 'recheck9@2003 min=2003',
      'recheck100@2003 min=2003', 'bids@2003 min=2003']);
    // The re-validation re-read every admitted address plus the batch that moved, once, at the new floor.
    const rechecked = new Set(p.calls.slice(4, 6).flatMap(c => c.keys));
    for (const call of p.calls.slice(0, 4)) for (const key of call.keys) expect(rechecked.has(key)).toBe(true);
    // The node-behind retry asked the same batch at the same floor.
    expect(p.calls[2]!.keys).toEqual(p.calls[1]!.keys); expect(p.calls[8]!.keys).toEqual(p.calls[6]!.keys);
    // Coherence: time and every account come from the adopted slot.
    expect(result.slot).toBe(2003); expect(result.view.observedSlot).toBe('2003');
    expect(result.nowSec).toBe(p.f.nowSec + 3n); expect(result.view.chainUnixTime).toBe((p.f.nowSec + 3n).toString());
    expect(result.walletAta?.amount).toBe(amountAt(p.stateAt(2003), p.f.ata));
  });

  it('restarts from scratch at the new floor when an admitted account changed, never returning a mixed bank', async () => {
    // The wallet ATA (admitted at 2000) changes at 2001, when the auctions batch moves the bank.
    const p = await pool({ node: sequence([2000, 2000, 2001]), edit: bumpAta(2001) });
    const result = await p.read();
    expect(p.trace()).toEqual(['core@2000 min=100', 'selected@2000 min=2000', 'auctions@2001 min=2000', 'recheck100@2001 min=2001',
      'recheck9@2001 min=2001', 'core@2001 min=2001', 'selected@2001 min=2001', 'auctions@2001 min=2001', 'bids@2001 min=2001']);
    expect(result.slot).toBe(2001); expect(result.walletAta?.amount).toBe(p.f.walletBalance + 1n);
    expect(result.walletAta?.amount).toBe(amountAt(p.stateAt(2001), p.f.ata)); expect(result.nowSec).toBe(p.f.nowSec + 1n);
  });

  it('bounds changed-data restarts to the configured complete-snapshot attempts', async () => {
    // Mint supply (not auction evidence beyond its identity) changes every slot and every call lands one slot later.
    const p = await pool({ node: call => 2000 + call, edit: (state, slot, f) => { state.get(f.mint.toBase58())!.data.writeBigUInt64LE(BigInt(slot), 36); } });
    await expect(p.read()).rejects.toThrow('finalized bank keeps moving');
    expect(p.calls.filter(c => c.label === 'core')).toHaveLength(R.snapshotReadAttempts);
    expect(p.trace()).toEqual(['core@2001 min=100', 'selected@2002 min=2001', 'recheck9@2003 min=2002',
      'core@2004 min=2003', 'selected@2005 min=2004', 'recheck9@2006 min=2005',
      'core@2007 min=2006', 'selected@2008 min=2007', 'recheck9@2009 min=2008']);
  });

  it('re-derives the Clock and bidding round at the adopted slot instead of carrying the first bank\'s time', async () => {
    // Round 0 bidding ends at firstStart; the Clock reaches it at slot 2001, after the bank moved there.
    const p = await pool({ node: sequence([2000, 2001, 2001]) }, { round: 0n, biddingRound: 0n });
    expect(p.f.nowSec + 1n).toBe(p.f.firstStart);
    const result = await p.read();
    expect(result.slot).toBe(2001); expect(result.nowSec).toBe(p.f.firstStart);
    expect(result.view).toMatchObject({ biddingRound: '1', round: '1', observedSlot: '2001', openedCount: 0 });
    expect(result.term).toBeNull();
  });

  it('keeps a Clock above its context fail-closed, on the first bank and on a re-validated one', async () => {
    const first = await pool({ node: () => 2000, clockAhead: call => call === 1 });
    await expect(first.read()).rejects.toThrow('Clock above context'); expect(first.calls).toHaveLength(1);
    const later = await pool({ node: sequence([2000, 2001, 2001]), clockAhead: call => call === 3 });
    await expect(later.read()).rejects.toThrow('Clock above context');
    expect(later.trace()).toEqual(['core@2000 min=100', 'selected@2001 min=2000', 'recheck9@2001 min=2001']);
  });

  it('fails closed with the RPC error after the bounded node-behind retries, and stops waiting on cancellation', async () => {
    const stuck = await pool({ node: call => call === 1 ? 2000 : 1999 });
    await expect(stuck.read()).rejects.toThrow('Minimum context slot has not been reached');
    expect(stuck.calls.filter(c => c.outcome === 'behind')).toHaveLength(SEEKER_AUCTION_NODE_BEHIND_RETRY_MAX + 1);
    expect(new Set(stuck.calls.slice(1).map(c => c.label))).toEqual(new Set(['selected']));
    const cancel = new AbortController(), waiting = await pool({ node: call => { if (call === 2) setTimeout(() => cancel.abort(), 10); return call === 1 ? 2000 : 1999; } });
    await expect(waiting.read(cancel.signal)).rejects.toThrow(); expect(waiting.calls).toHaveLength(2);
  });

  it('refuses one finalized slot that answers with two different states for an admitted account', async () => {
    const p = await pool({ node: () => 2000 });
    let served = 0; const original = p.source.connect;
    const lying = { ...p.source, connect: (signal: AbortSignal) => {
      const rpc = original(signal);
      return { ...rpc, getMultipleAccountsInfoAndContext: async (addresses: PublicKey[], options: { commitment: 'finalized'; minContextSlot: number }) => {
        const answer = await rpc.getMultipleAccountsInfoAndContext(addresses, options);
        if (++served === 3) answer.value[0]!.data[0]! ^= 1; return answer;
      } };
    } };
    await expect(withSeekerAuctionEvidenceBank(lying, wallet.toBase58(), undefined, async bank => {
      await bank.read([p.f.termAddress]); return bank.read([p.f.termAddress, p.f.ata]);
    })).rejects.toThrow('one finalized slot with two account states');
  });
});

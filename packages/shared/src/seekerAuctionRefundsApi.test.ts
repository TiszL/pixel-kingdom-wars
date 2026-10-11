/** review 4dbfed12: additive wallet refund contract. The frozen round DTO is unchanged. */
import { describe, expect, it } from 'vitest';
import { SeekerAuctionRefundsPageSchema, SeekerAuctionRefundsRequestSchema } from './seekerAuctionRefundsApi';

const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function key(n: number): string {
  let value = BigInt(`0x${n.toString(16).padStart(2, '0').repeat(32)}`), result = '';
  while (value > 0n) { result = alphabet[Number(value % 58n)]! + result; value /= 58n; }
  return result;
}
const entry = (spot = 0, round = '0') => ({ bid: key(10 + spot), auction: key(110 + spot), round, spot, amountRaw: '9007199254740993' });
const page = () => ({ version: 1, source: 'chain', wallet: key(1), observedSlot: '2000', chainUnixTime: '1791158400',
  programId: key(2), config: key(3), mint: key(4), decimals: 6, entries: [entry()], nextCursor: null as null | { round: string; spot: number } });

describe('wallet-scoped Seeker refund page contract', () => {
  it('retains exact u64 escrow and finalized evidence without changing the round interface', () => {
    expect(SeekerAuctionRefundsPageSchema.parse(page())).toEqual(page());
    const value = page(); value.entries[0]!.amountRaw = '18446744073709551615';
    expect(SeekerAuctionRefundsPageSchema.parse(value).entries[0]!.amountRaw).toBe('18446744073709551615');
    expect(SeekerAuctionRefundsPageSchema.parse({ ...page(), entries: [] })).toMatchObject({ entries: [], nextCursor: null });
  });
  it.each(['0', '01', '-1', '1.5', '1e6', '18446744073709551616', 1, null])('refuses invalid positive escrow %s', amountRaw => {
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...page(), entries: [{ ...entry(), amountRaw }] }).success).toBe(false);
  });
  it('requires chain provenance, wallet binding, exact context and bounded mint decimals', () => {
    for (const patch of [{ source: 'fixture' }, { source: undefined }, { wallet: key(1) + ' ' }, { wallet: '1'.repeat(32) },
      { observedSlot: '01' }, { observedSlot: -1 }, { chainUnixTime: '-0' }, { chainUnixTime: '9223372036854775808' },
      { decimals: 20 }, { decimals: -1 }, { decimals: 1.5 }])
      expect(SeekerAuctionRefundsPageSchema.safeParse({ ...page(), ...patch }).success).toBe(false);
    expect(SeekerAuctionRefundsPageSchema.parse({ ...page(), chainUnixTime: '-1', decimals: 19 }).chainUnixTime).toBe('-1');
  });
  it('rejects unknown fields at the page, entry, request and cursor boundaries', () => {
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...page(), totalRefunds: 0 }).success).toBe(false);
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...page(), entries: [{ ...entry(), refundable: true }] }).success).toBe(false);
    expect(SeekerAuctionRefundsRequestSchema.safeParse({ wallet: key(1) }).success).toBe(false);
    expect(SeekerAuctionRefundsRequestSchema.safeParse({ after: { round: '0', spot: 0, slot: '2000' } }).success).toBe(false);
  });
  it('uses stable numeric round/spot keys and never treats strings as lexicographic rounds', () => {
    const value = page(); value.entries = [entry(0, '2'), entry(1, '10')];
    expect(SeekerAuctionRefundsPageSchema.parse(value)).toEqual(value);
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...value, entries: [...value.entries].reverse() }).success).toBe(false);
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...value, entries: [entry(), entry()] }).success).toBe(false);
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...value, entries: [entry(), { ...entry(1), bid: entry().bid }] }).success).toBe(false);
    expect(SeekerAuctionRefundsPageSchema.safeParse({ ...value, entries: [entry(), { ...entry(1), auction: entry().auction }] }).success).toBe(false);
  });
  it('caps pages at 25 rows and only accepts a continuation equal to a full page final key', () => {
    const entries = Array.from({ length: 25 }, (_, spot) => entry(spot));
    expect(SeekerAuctionRefundsPageSchema.parse({ ...page(), entries, nextCursor: { round: '0', spot: 24 } }).entries).toHaveLength(25);
    for (const value of [{ ...page(), entries: [...entries, entry(25)] }, { ...page(), entries: [], nextCursor: { round: '0', spot: 0 } },
      { ...page(), nextCursor: { round: '0', spot: 0 } }, { ...page(), entries, nextCursor: { round: '0', spot: 23 } },
      { ...page(), entries, nextCursor: { round: '0', spot: 24, wallet: key(1) } }])
      expect(SeekerAuctionRefundsPageSchema.safeParse(value).success).toBe(false);
  });
  it('accepts absent or canonical keyset cursors without caller-selectable limits or wallets', () => {
    expect(SeekerAuctionRefundsRequestSchema.parse({})).toEqual({});
    expect(SeekerAuctionRefundsRequestSchema.parse({ after: { round: '18446744073709551615', spot: 99 } })).toEqual({ after: { round: '18446744073709551615', spot: 99 } });
    for (const after of [null, 'opaque', {}, { round: '01', spot: 0 }, { round: '-1', spot: 0 }, { round: '0', spot: -1 },
      { round: '0', spot: 100 }, { round: '0', spot: 1.5 }, { round: '0', spot: '0' }])
      expect(SeekerAuctionRefundsRequestSchema.safeParse({ after }).success).toBe(false);
    expect(SeekerAuctionRefundsRequestSchema.safeParse({ limit: 1024 }).success).toBe(false);
  });
});

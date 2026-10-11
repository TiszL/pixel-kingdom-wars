/** Synthetic codec fixtures ONLY. No fixture establishes finalized chain authority. */
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { canonicalSeekerRegistry, hashSeekerRegistry, hashSeekerAuctionTerms } from './seekerAuctionProtocol';
import { SEEKER_TERM_ACCOUNT_BYTES, verifySeekerTermAccounts, type SeekerRawAccount, type SeekerTermAccountPolicy } from './seekerTermAccounts';
const { BorshAccountsCoder, BN } = anchorPkg;
const coder = new BorshAccountsCoder(idl as Idl);
const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION;
const pk = (n: number) => new PublicKey(Buffer.alloc(32, n));
const program = new PublicKey(idl.address);
const le = (value: bigint) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(value); return bytes; };
const pda = (...seeds: (string | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds.map(x => typeof x === 'string' ? Buffer.from(x) : Buffer.from(x)), program);
function anchorValue(value: unknown): unknown {
  if (typeof value === 'bigint') return new BN(value.toString());
  if (value instanceof PublicKey || value === null) return value;
  if (Array.isArray(value)) return value.map(anchorValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, anchorValue(v)]));
  return value;
}
async function fixture(round = 0n, unsold = false) {
  const [authority, authorityBump] = pda('seeker_authority'), [config, configBump] = pda('auction_config'), [registry, registryBump] = pda('seeker_registry');
  const [term, termBump] = pda('seeker_term', config.toBytes(), le(round));
  const genesisHash = pk(200), mint = pk(201), prizeOwner = pk(202);
  const prizeAta = getAssociatedTokenAddressSync(mint, prizeOwner, true), entries = canonicalSeekerRegistry(), registryHash = hashSeekerRegistry(entries);
  const firstStart = 1_800_000_000n, operatingStart = firstStart + round * BigInt(P.operatingTermSec), operatingEnd = operatingStart + BigInt(P.operatingTermSec);
  const auctionStart = operatingStart - BigInt(P.overlappingAuctionSec), completedAt = operatingStart + 20n;
  const decimals = 6, openingBid = BigInt(A.openingBidSkr) * 10n ** BigInt(decimals);
  const full = Array(Math.ceil(P.totalSpots / 8)).fill(0) as number[];
  for (let i = 0; i < P.totalSpots; i++) full[i >> 3]! |= 1 << (i % 8);
  const expected: SeekerTermAccountPolicy = { programId: program, config, round, mint, prizeOwner, prizeAta, genesisHash, operatingAt: operatingStart + 30n };
  const models = {
    authority: { version: 1, admin: pk(210), pending_admin: null as PublicKey | null, guardian: pk(211), current_policy_key: pk(212),
      previous_policy_key: null as PublicKey | null, previous_valid_until: 0n, cluster_genesis: [...genesisHash.toBytes()], admission_paused: true, bump: authorityBump },
    config: { version: 1, authority, registry, registry_hash: [...registryHash], registry_version: 1, mint, token_program: TOKEN_PROGRAM_ID,
      decimals, prize_owner: prizeOwner, prize_ata: prizeAta, prize_bps: A.prizeBps as number, opening_bid: openingBid, first_operating_start: firstStart,
      term_sec: BigInt(P.operatingTermSec), auction_sec: BigInt(P.overlappingAuctionSec), grace_sec: BigInt(A.settlementGraceSec), auction_format: 1, terms_format: 1, bump: configBump },
    registry: { version: 1, island: 1, entries: entries.map(e => ({ id: e.spotId, class: e.class as number, realm_mask: e.realmMask })), hash: [...registryHash], bump: registryBump },
    term: { version: 1, config, registry, registry_hash: [...registryHash], round,
      previous: round === 0n ? null : pda('seeker_term', config.toBytes(), le(round - 1n))[0], auction_start: auctionStart, auction_end: operatingStart,
      operating_start: operatingStart, operating_end: operatingEnd, opened: [...full], settled: [...full], completed_count: P.totalSpots as number,
      winner_count: unsold ? 0 : 3, completed_at: completedAt as bigint | null, completed_slot: BigInt(1000 + P.totalSpots - 1) as bigint | null, bump: termBump },
    auctions: entries.map(entry => {
      const [address, bump] = pda('auction', config.toBytes(), Uint8Array.of(entry.spotId), le(round));
      const vault = getAssociatedTokenAddressSync(mint, address, true), winner = !unsold && entry.spotId < 3 ? pk(entry.spotId < 2 ? 220 : 221) : null;
      const termsHash = hashSeekerAuctionTerms({ config, term, auction: address, registry, registryHash, spotId: entry.spotId, class: entry.class,
        realmMask: entry.realmMask, round, auctionStart, auctionEnd: operatingStart, operatingStart, operatingEnd,
        mint, tokenProgram: TOKEN_PROGRAM_ID, vault, prizeOwner, prizeAta, prizeBps: A.prizeBps, grace: BigInt(A.settlementGraceSec), openingBid,
        registryVersion: 1, auctionFormat: 1, termsFormat: 1 });
      return { address, fields: { version: 1, config, term, registry, spot: { id: entry.spotId, class: entry.class as number, realm_mask: entry.realmMask }, round,
        auction_start: auctionStart, auction_end: operatingStart, operating_start: operatingStart, operating_end: operatingEnd, terms_hash: [...termsHash], vault,
        high_bid: winner ? openingBid * BigInt(entry.spotId + 1) : 0n, high_bidder: winner, outstanding_escrow: 0n, settled: true,
        result_owner: winner, settled_at: completedAt as bigint | null, settled_slot: BigInt(1000 + entry.spotId) as bigint | null, bump } };
    }),
  };
  async function pack(name: keyof typeof SEEKER_TERM_ACCOUNT_BYTES, address: PublicKey, model: unknown): Promise<SeekerRawAccount> {
    const encoded = await coder.encode(name, anchorValue(model) as object);
    const data = Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES[name]); encoded.copy(data);
    expect(encoded.length).toBeLessThanOrEqual(data.length);
    return { address, owner: program, executable: false, data };
  }
  async function bytes() {
    return { authority: await pack('SeekerAuthority', authority, models.authority), config: await pack('AuctionConfig', config, models.config),
      registry: await pack('SeekerRegistry', registry, models.registry), term: await pack('SeekerTerm', term, models.term),
      auctions: await Promise.all(models.auctions.map(a => pack('Auction', a.address, a.fields))) };
  }
  return { expected, models, bytes, pack };
}

describe('pure Seeker term account verifier, not RPC/settlement provenance', () => {
  it('decodes the actual IDL variable Options, mixed winners and positively settled unsold rows', async () => {
    const f = await fixture(), accounts = await f.bytes(), result = verifySeekerTermAccounts(f.expected, accounts);
    expect(result.auctions).toHaveLength(P.totalSpots); expect(result.winnerCount).toBe(3);
    expect(result.auctions[0]!.winner).toBe(result.auctions[1]!.winner); expect(result.auctions[3]!.winner).toBeNull();
    expect(result.auctions[0]!.terms.config).toBe(f.expected.config.toBase58()); expect(result.previousTerm).toBeNull();
    expect(result.authority.admissionPaused).toBe(true); // Pause never erases a real completed result.
    expect(result.completedSlot).toBe(1099n);
  });
  it('accepts explicit complete zero-winner evidence, never absence', async () => {
    const f = await fixture(0n, true), result = verifySeekerTermAccounts(f.expected, await f.bytes());
    expect(result.winnerCount).toBe(0); expect(result.auctions.every(a => a.winner === null && a.highBid === 0n)).toBe(true);
  });
  it('accepts later-round predecessor Option and both authority key Options without fixed-offset drift', async () => {
    const f = await fixture(2n); f.models.authority.pending_admin = pk(230); f.models.authority.previous_policy_key = pk(231);
    f.models.authority.previous_valid_until = f.expected.operatingAt - 1n; // Expired previous key remains stored history.
    expect(verifySeekerTermAccounts(f.expected, await f.bytes()).previousTerm).toBe(f.models.term.previous!.toBase58());
  });
  it('ignores nonzero allocation padding after fully decoded None fields', async () => {
    const f = await fixture(), accounts = await f.bytes();
    accounts.authority.data.fill(255, 149); // None pending and previous keys: meaningful payload ends149.
    accounts.term.data.fill(255, 193); // round0 completed manifest leaves32 unused bytes.
    accounts.auctions[3]!.data.fill(255, 250); // settled unsold leaves64 unused bytes.
    expect(verifySeekerTermAccounts(f.expected, accounts).winnerCount).toBe(3);
  });
  it('returns sorted detached deeply frozen terms without mutable account buffers or keys', async () => {
    const f = await fixture(), accounts = await f.bytes(); accounts.auctions.reverse();
    const result = verifySeekerTermAccounts(f.expected, accounts), originalHash = result.auctions[0]!.termsHash;
    accounts.auctions[99]!.data.fill(0); accounts.term.data.fill(0);
    expect(result.auctions.map(a => a.terms.spotId)).toEqual(Array.from({ length: P.totalSpots }, (_, i) => i));
    expect(result.auctions[0]!.termsHash).toBe(originalHash);
    for (const object of [result, result.source, result.authority, result.auctions, result.auctions[0], result.auctions[0]!.terms]) expect(Object.isFrozen(object)).toBe(true);
  });
  for (const name of ['authority', 'config', 'registry', 'term', 'auction'] as const) {
    it(`rejects ${name} owner/executable/discriminator and both allocation directions`, async () => {
      const f = await fixture(), original = await f.bytes(), target = name === 'auction' ? original.auctions[0]! : original[name];
      const corrupted = Buffer.from(target.data); corrupted[0]! ^= 1;
      for (const patch of [{ owner: pk(240) }, { executable: true }, { data: corrupted },
        { data: target.data.subarray(0, target.data.length - 1) }, { data: Buffer.concat([target.data, Buffer.from([0])]) }]) {
        const bad = { ...target, ...patch }, accounts = name === 'auction' ? { ...original, auctions: [bad, ...original.auctions.slice(1)] } : { ...original, [name]: bad };
        expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
      }
    });
  }
  it('rejects noncanonical boolean and Option tags, including terminal fields after variable winner keys', async () => {
    const f = await fixture(), original = await f.bytes();
    for (const [name, index, offset] of [['authority', 0, 41], ['term', 0, 113], ['auction', 0, 220], ['auction', 0, 261],
      ['auction', 0, 262], ['auction', 0, 295], ['auction', 3, 231]] as const) {
      const target = name === 'auction' ? original.auctions[index]! : original[name]; const data = Buffer.from(target.data); data[offset] = 2;
      const bad = { ...target, data }, accounts = name === 'auction' ? { ...original, auctions: original.auctions.map((x, i) => i === index ? bad : x) } : { ...original, [name]: bad };
      expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    }
  });
  it('rejects mutated expected scope and invalid bigint domains rather than normalizing caller input', async () => {
    const f = await fixture(), accounts = await f.bytes();
    for (const patch of [{ programId: pk(240) }, { config: pk(240) }, { genesisHash: pk(240) }, { mint: pk(240) },
      { prizeOwner: pk(240) }, { prizeAta: pk(240) }, { round: -1n }, { round: 1n << 64n }, { round: 0 }, { operatingAt: '1800000030' }]) {
      expect(() => verifySeekerTermAccounts({ ...f.expected, ...patch } as never, accounts)).toThrow();
    }
  });
  it('rejects off-curve PDA/address substitutions and incorrect stored bumps', async () => {
    const f = await fixture(); f.models.auctions[0]!.fields.bump ^= 1;
    const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    const clean = await fixture(), original = await clean.bytes();
    expect(() => verifySeekerTermAccounts(clean.expected, { ...original, term: { ...original.term, address: pk(240) } })).toThrow();
  });
  it('rejects shared-policy, version, scaling and immutable destination changes', async () => {
    const f = await fixture();
    const edits = [{ version: 2 }, { registry_version: 2 }, { opening_bid: f.models.config.opening_bid + 1n }, { decimals: 255 },
      { prize_bps: A.prizeBps - 1 }, { term_sec: BigInt(P.operatingTermSec) - 1n }, { auction_sec: 1n }, { grace_sec: 1n },
      { auction_format: 2 }, { terms_format: 2 }, { prize_ata: pk(240) }, { token_program: pk(240) }];
    const original = { ...f.models.config };
    for (const patch of edits) { Object.assign(f.models.config, original, patch); const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow(); }
  });
  it('rejects registry reorder, mapping drift and hash drift even with100 rows', async () => {
    for (const edit of ['order', 'class', 'mask', 'hash'] as const) {
      const f = await fixture();
      if (edit === 'order') f.models.registry.entries.reverse();
      if (edit === 'class') f.models.registry.entries[0]!.class = 0;
      if (edit === 'mask') f.models.registry.entries[20]!.realm_mask ^= 1;
      if (edit === 'hash') f.models.registry.hash[0]! ^= 1;
      const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    }
  });
  it('requires both full100-bit maps with unused bits clear and exact completed counters', async () => {
    for (const edit of ['opened', 'settled', 'padding', 'count', 'winners', 'missingAt', 'missingSlot'] as const) {
      const f = await fixture();
      if (edit === 'opened') f.models.term.opened[0]! &= ~1;
      if (edit === 'settled') f.models.term.settled[0]! &= ~1;
      if (edit === 'padding') f.models.term.settled[f.models.term.settled.length - 1]! |= 128;
      if (edit === 'count') f.models.term.completed_count -= 1;
      if (edit === 'winners') f.models.term.winner_count += 1;
      if (edit === 'missingAt') f.models.term.completed_at = null;
      if (edit === 'missingSlot') f.models.term.completed_slot = null;
      const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    }
  });
  it('requires exact predecessor and deterministic clocks, including int64 overflow rejection', async () => {
    for (const edit of ['previous', 'deadline', 'overflow'] as const) {
      const f = await fixture(1n);
      if (edit === 'previous') f.models.term.previous = pk(240);
      if (edit === 'deadline') f.models.term.operating_end += 1n;
      if (edit === 'overflow') f.models.config.first_operating_start = (1n << 63n) - 1n;
      const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    }
  });
  it('enforces operating interval inclusive start and exclusive end without wall-clock access', async () => {
    const f = await fixture(), accounts = await f.bytes();
    for (const operatingAt of [f.models.term.operating_start - 1n, f.models.term.operating_end]) expect(() => verifySeekerTermAccounts({ ...f.expected, operatingAt }, accounts)).toThrow();
    const z = await fixture(0n, true); z.models.term.completed_at = z.models.term.operating_start;
    for (const a of z.models.auctions) a.fields.settled_at = z.models.term.operating_start;
    expect(verifySeekerTermAccounts({ ...z.expected, operatingAt: z.models.term.operating_start }, await z.bytes()).winnerCount).toBe(0);
  });
  it('refuses omitted, duplicated or unknown-spot auctions rather than fabricating unsold outcomes', async () => {
    const f = await fixture(), original = await f.bytes();
    expect(() => verifySeekerTermAccounts(f.expected, { ...original, auctions: original.auctions.slice(1) })).toThrow();
    expect(() => verifySeekerTermAccounts(f.expected, { ...original, auctions: [original.auctions[1]!, ...original.auctions.slice(1)] })).toThrow();
    f.models.auctions[0]!.fields.spot.id = P.totalSpots;
    const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
  });
  it('refuses terms hash, vault, target, clock and realm substitution independently of stored owners', async () => {
    for (const edit of ['hash', 'vault', 'config', 'term', 'registry', 'clock', 'mask'] as const) {
      const f = await fixture(), a = f.models.auctions[0]!.fields;
      if (edit === 'hash') a.terms_hash[0]! ^= 1;
      if (edit === 'vault') a.vault = pk(240);
      if (edit === 'config') a.config = pk(240);
      if (edit === 'term') a.term = pk(240);
      if (edit === 'registry') a.registry = pk(240);
      if (edit === 'clock') a.operating_end += 1n;
      if (edit === 'mask') a.spot.realm_mask ^= 1;
      const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    }
  });
  it('refuses unsettled, missing or contradictory terminal evidence', async () => {
    for (const edit of ['unsettled', 'owner', 'zeroWinner', 'belowMinimum', 'missingAt', 'missingSlot', 'early', 'futureSlot'] as const) {
      const f = await fixture(), a = f.models.auctions[0]!.fields;
      if (edit === 'unsettled') a.settled = false;
      if (edit === 'owner') a.result_owner = pk(240);
      if (edit === 'zeroWinner') a.high_bid = 0n;
      if (edit === 'belowMinimum') a.high_bid = f.models.config.opening_bid - 1n;
      if (edit === 'missingAt') a.settled_at = null;
      if (edit === 'missingSlot') a.settled_slot = null;
      if (edit === 'early') a.settled_at = f.models.term.auction_end - 1n;
      if (edit === 'futureSlot') a.settled_slot = f.models.term.completed_slot! + 1n;
      const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
    }
  });
  it('refuses a manifest completion that is not an actual last auction result', async () => {
    const f = await fixture(); f.models.term.completed_slot! += 1n;
    const accounts = await f.bytes(); expect(() => verifySeekerTermAccounts(f.expected, accounts)).toThrow();
  });
  it('keeps immutable terms identical when losing escrow is refunded later', async () => {
    const f = await fixture(), initial = verifySeekerTermAccounts(f.expected, await f.bytes());
    f.models.auctions[0]!.fields.outstanding_escrow = 123n;
    const after = verifySeekerTermAccounts(f.expected, await f.bytes()); expect(after).toEqual(initial);
  });
});

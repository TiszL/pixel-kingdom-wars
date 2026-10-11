import { keccak_256 } from '@noble/hashes/sha3.js';
import { PHASE_E_POLICY } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  canonicalSeekerRegistry, decodeSeekerActionPermit, encodeSeekerActionPermit, encodeSeekerAuctionTerms,
  encodeSeekerRegistry, encodeOpenSeekerAuctionPayload, encodeSettleSeekerAuctionPayload,
  hashSeekerRegistry, hashSeekerAuctionTerms, hashOpenSeekerAuctionPayload, hashSettleSeekerAuctionPayload,
  seekerAuthorityPda, seekerRegistryPda, seekerAuctionConfigPda, seekerTermPda, seekerAuctionPda,
  seekerBidPda, seekerPermitReceiptPda, type SeekerAuctionTerms, type SeekerActionPermit,
} from './seekerAuctionProtocol';

const pk = (fill: number) => new PublicKey(Buffer.alloc(32, fill));
const program = new PublicKey('27bgnruDhviykKK12k5t2imTEgLUYfAgZRwGiD4zxWDf'); // local test identity only
const hexHash = (hex: string) => Buffer.from(keccak_256(Buffer.from(hex, 'hex')));
const repeated = (hex: string) => hex.repeat(32);
const permit = (): SeekerActionPermit => ({ genesisHash: pk(1), programId: pk(2), kind: 7,
  permitId: Buffer.alloc(16, 3), wallet: pk(4), expiry: 1234n, payloadHash: Buffer.alloc(32, 5) });
const terms = (): SeekerAuctionTerms => ({ config: pk(1), term: pk(2), auction: pk(3), registry: pk(4),
  registryHash: Buffer.alloc(32, 5), spotId: 20, class: 0, realmMask: 15, round: 3n,
  auctionStart: 100n, auctionEnd: 200n, operatingStart: 200n, operatingEnd: 300n,
  mint: pk(6), tokenProgram: pk(7), vault: pk(8), prizeOwner: pk(9), prizeAta: pk(10),
  prizeBps: 10000, grace: 600n, openingBid: 10000000n, registryVersion: 1, auctionFormat: 1, termsFormat: 1 });
// Fixed wire vector, not authorized account/clock evidence. Values distinguish every field's position.
const IMMUTABLE_HEX = repeated('01') + repeated('02') + repeated('03') + repeated('04') + repeated('05')
  + '14000f' + '0300000000000000' + '6400000000000000' + 'c800000000000000'
  + 'c800000000000000' + '2c01000000000000'
  + repeated('06') + repeated('07') + repeated('08') + repeated('09') + repeated('0a')
  + '1027' + '5802000000000000' + '8096980000000000' + '010001000100';
const TERMS_HEX = '534b415445524d31' + IMMUTABLE_HEX;

describe('Seeker auction v1 protocol, never a signer or authority reader', () => {
  it('pins all161 permit bytes and returns detached decoded byte fields', () => {
    const value = permit();
    const encoded = encodeSeekerActionPermit(value);
    expect(encoded.length).toBe(161);
    expect(encoded.toString('hex')).toBe('534b5045524d5432' + repeated('01') + repeated('02')
      + '07' + '03'.repeat(16) + repeated('04') + 'd204000000000000' + repeated('05'));
    const decoded = decodeSeekerActionPermit(encoded);
    expect(encodeSeekerActionPermit(decoded)).toEqual(encoded);
    encoded.fill(0);
    expect(decoded.permitId).toEqual(Buffer.alloc(16, 3));
    expect(decoded.payloadHash).toEqual(Buffer.alloc(32, 5));
    expect(decoded.expiry).toBe(1234n);
    (value.permitId as Uint8Array).fill(9);
    expect(decoded.permitId).toEqual(Buffer.alloc(16, 3));
  });
  it('accepts canonical PublicKey objects across package copies, not inconsistent byte/text views', () => {
    const original = pk(4);
    const otherCopy = { toBytes: () => original.toBytes(), toBase58: () => original.toBase58() } as PublicKey;
    expect(encodeSeekerActionPermit({ ...permit(), wallet: otherCopy })).toEqual(encodeSeekerActionPermit(permit()));
    const inconsistent = { ...otherCopy, toBase58: () => pk(5).toBase58() };
    expect(() => encodeSeekerActionPermit({ ...permit(), wallet: inconsistent } as never)).toThrow();
  });
  it('rejects domain, kind, truncation and extension instead of decoding partial permits', () => {
    const encoded = encodeSeekerActionPermit(permit());
    for (const input of [encoded.subarray(0, 160), Buffer.concat([encoded, Buffer.from([0])])]) {
      expect(() => decodeSeekerActionPermit(input)).toThrow();
    }
    const domain = Buffer.from(encoded); domain[0] = 0;
    const wrongKind = Buffer.from(encoded); wrongKind[72] = 1;
    expect(() => decodeSeekerActionPermit(domain)).toThrow();
    expect(() => decodeSeekerActionPermit(wrongKind)).toThrow();
  });
  it('requires exact permit fields and typed widths without coercing caller input', () => {
    for (const amendment of [{ kind: 1 }, { kind: '7' }, { permitId: Buffer.alloc(15) },
      { payloadHash: Buffer.alloc(33) }, { expiry: 1 }, { expiry: '1' },
      { expiry: 1n << 63n }, { expiry: -(1n << 63n) - 1n }, { wallet: '11111111111111111111111111111111' },
      { extra: true }]) {
      expect(() => encodeSeekerActionPermit({ ...permit(), ...amendment } as never)).toThrow();
    }
    for (const expiry of [-(1n << 63n), (1n << 63n) - 1n]) {
      expect(decodeSeekerActionPermit(encodeSeekerActionPermit({ ...permit(), expiry })).expiry).toBe(expiry);
    }
  });
  it('pins exact terms and open payload field order with separate domains', () => {
    const value = terms();
    expect(encodeSeekerAuctionTerms(value).toString('hex')).toBe(TERMS_HEX);
    expect(encodeSeekerAuctionTerms(value).length).toBe(395);
    const expectedHash = hexHash(TERMS_HEX);
    expect(hashSeekerAuctionTerms(value)).toEqual(expectedHash);
    expect(expectedHash.toString('hex')).toBe('2e02c4a891bc4e06caeb2532416389ba685151dc728bf0eb03a49f34790d4e45');
    const openHex = '534b414f50454e31' + IMMUTABLE_HEX + expectedHash.toString('hex');
    expect(encodeOpenSeekerAuctionPayload(value).toString('hex')).toBe(openHex);
    expect(encodeOpenSeekerAuctionPayload(value).length).toBe(427);
    expect(hashOpenSeekerAuctionPayload(value)).toEqual(hexHash(openHex));
    expect(hashOpenSeekerAuctionPayload(value).toString('hex')).toBe('45a717f5f19c484565c91471ed06cd40c0dcefde61e3facf62a6e69820a45954');
    expect(hashOpenSeekerAuctionPayload(value)).not.toEqual(expectedHash);
  });
  it('binds every immutable term field rather than hashing only account identities', () => {
    const original = terms();
    const baseline = hashOpenSeekerAuctionPayload(original);
    const edits: Partial<SeekerAuctionTerms>[] = [
      ...(['config', 'term', 'auction', 'registry', 'mint', 'tokenProgram', 'vault', 'prizeOwner', 'prizeAta'] as const)
        .map(field => ({ [field]: pk(22) })),
      { registryHash: Buffer.alloc(32, 11) }, { spotId: 21 }, { class: 1 }, { realmMask: 31 }, { round: 4n },
      { auctionStart: 101n }, { auctionEnd: 201n }, { operatingStart: 201n }, { operatingEnd: 301n },
      { prizeBps: 9999 }, { grace: 601n }, { openingBid: 10000001n },
    ];
    for (const edit of edits) expect(hashOpenSeekerAuctionPayload({ ...original, ...edit })).not.toEqual(baseline);
    for (const field of ['registryVersion', 'auctionFormat', 'termsFormat']) {
      expect(() => hashOpenSeekerAuctionPayload({ ...original, [field]: 2 })).toThrow();
    }
  });
  it('rejects malformed integer/hash/shape inputs before producing a signed digest', () => {
    for (const amendment of [{ round: -1n }, { round: 1n << 64n }, { round: 1 }, { round: '1' },
      { spotId: 100 }, { spotId: 0.5 }, { class: 2 }, { realmMask: 256 }, { prizeBps: 65536 },
      { grace: 1n << 63n }, { openingBid: -1n }, { registryHash: [1, 2] }, { extra: true }]) {
      expect(() => hashSeekerAuctionTerms({ ...terms(), ...amendment } as never)).toThrow();
    }
  });
  it('pins fixed33-byte optional winner and exact zero-bid settlement', () => {
    const value = { auction: pk(3), config: pk(1), term: pk(2), termsHash: Buffer.alloc(32, 5), highBid: 10000000n, highBidder: pk(11) };
    const prefix = '534b415345544c31' + repeated('03') + repeated('01') + repeated('02') + repeated('05');
    const winHex = prefix + '8096980000000000' + '01' + repeated('0b');
    expect(encodeSettleSeekerAuctionPayload(value).toString('hex')).toBe(winHex);
    expect(encodeSettleSeekerAuctionPayload(value).length).toBe(177);
    expect(hashSettleSeekerAuctionPayload(value)).toEqual(hexHash(winHex));
    expect(hashSettleSeekerAuctionPayload(value).toString('hex')).toBe('d0988320db6aab703fbe0725c22fc4f4a09408352a20f6dffaad944165b28f49');
    expect(hashSettleSeekerAuctionPayload({ ...value, highBid: 0n, highBidder: null }).toString('hex'))
      .toBe('a4ef2af4d82921ff50f1726731f1ab528970c4732691e372296c43a9ac9809f7');
    expect(encodeSettleSeekerAuctionPayload({ ...value, highBid: 0n, highBidder: null }).toString('hex'))
      .toBe(prefix + '00'.repeat(8 + 33));
    for (const edit of [{ highBid: 0n }, { highBidder: null }, { highBid: -1n }, { highBid: 1n << 64n }, { highBid: '1' }, { extra: true }]) {
      expect(() => encodeSettleSeekerAuctionPayload({ ...value, ...edit } as never)).toThrow();
    }
  });
  it('does not let later high bids or winner substitutions reuse a settle payload', () => {
    const value = { auction: pk(3), config: pk(1), term: pk(2), termsHash: Buffer.alloc(32, 5), highBid: 10n, highBidder: pk(11) };
    for (const edit of [{ highBid: 11n }, { highBidder: pk(12) }, { auction: pk(12) }, { config: pk(12) },
      { term: pk(12) }, { termsHash: Buffer.alloc(32, 12) }]) {
      expect(hashSettleSeekerAuctionPayload({ ...value, ...edit })).not.toEqual(hashSettleSeekerAuctionPayload(value));
    }
  });
  it('canonicalizes the complete fixed registry without mutating caller order', () => {
    const rows = canonicalSeekerRegistry();
    const reversed = [...rows].reverse();
    const encoded = encodeSeekerRegistry(reversed);
    expect(encoded.length).toBe(311);
    expect(encoded.subarray(0, 11).toString('hex')).toBe('534b415245473031010001');
    expect(encoded.subarray(11, 14)).toEqual(Buffer.from([0, 1, 255]));
    expect(encoded.subarray(11 + 20 * 3, 14 + 20 * 3)).toEqual(Buffer.from([20, 0, 15]));
    expect(encoded.subarray(11 + 27 * 3, 14 + 27 * 3)).toEqual(Buffer.from([27, 0, 135]));
    expect(hashSeekerRegistry(reversed)).toEqual(hashSeekerRegistry(rows));
    expect(hashSeekerRegistry(rows).toString('hex')).toBe('a4aacd9f6dd5caa33c42b3163d9ad45b0efcb9a500520315792b2b677db9e200');
    expect(reversed[0]!.spotId).toBe(PHASE_E_POLICY.seekerIsland.totalSpots - 1);
    expect(rows.filter(row => row.class === 1)).toHaveLength(PHASE_E_POLICY.seekerIsland.kingSpots);
  });
  it('rejects missing, duplicate, unknown or substituted registry entries', () => {
    const rows = canonicalSeekerRegistry();
    for (const changed of [rows.slice(1), [...rows.slice(0, -1), rows[0]!],
      [{ ...rows[0]!, class: 0 }, ...rows.slice(1)], [{ ...rows[0]!, realmMask: 15 }, ...rows.slice(1)],
      [{ ...rows[0]!, spotId: 100 }, ...rows.slice(1)], [{ ...rows[0]!, extra: true }, ...rows.slice(1)]]) {
      expect(() => hashSeekerRegistry(changed as never)).toThrow();
    }
  });
  it('pins every canonical seed boundary and separates program, wallet, spot and round', () => {
    const config = pk(1), auction = pk(2), wallet = pk(3), permitId = Buffer.alloc(16, 4);
    const derive = (seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, program)[0];
    const round = Buffer.from('0300000000000000', 'hex');
    expect(seekerAuthorityPda(program)).toEqual(derive([Buffer.from('seeker_authority')]));
    expect(seekerRegistryPda(program)).toEqual(derive([Buffer.from('seeker_registry')]));
    expect(seekerAuctionConfigPda(program)).toEqual(derive([Buffer.from('auction_config')]));
    expect(seekerTermPda(program, config, 3n)).toEqual(derive([Buffer.from('seeker_term'), config.toBuffer(), round]));
    expect(seekerAuctionPda(program, config, 20, 3n)).toEqual(derive([Buffer.from('auction'), config.toBuffer(), Buffer.from([20]), round]));
    expect(seekerBidPda(program, auction, wallet)).toEqual(derive([Buffer.from('bid'), auction.toBuffer(), wallet.toBuffer()]));
    expect(seekerPermitReceiptPda(program, permitId)).toEqual(derive([Buffer.from('permit'), permitId]));
    expect(seekerTermPda(program, config, 3n)).not.toEqual(seekerTermPda(pk(22), config, 3n));
    expect(seekerTermPda(program, config, 3n)).not.toEqual(seekerTermPda(program, config, 4n));
    expect(seekerAuctionPda(program, config, 20, 3n)).not.toEqual(seekerAuctionPda(program, config, 21, 3n));
    expect(seekerBidPda(program, auction, wallet)).not.toEqual(seekerBidPda(program, auction, pk(4)));
    expect(() => seekerTermPda(program, config, -1n)).toThrow();
    expect(() => seekerAuctionPda(program, config, 100, 3n)).toThrow();
    expect(() => seekerPermitReceiptPda(program, Buffer.alloc(17))).toThrow();
  });
});

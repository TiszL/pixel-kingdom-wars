import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  charterAssetPda, charterClanIdBytes, charterConfigPda, charterExecutorPda,
  charterFreezePda, charterPda,
  charterMintPda, charterCreationPda, encodeCharterMetadata, hashCharterMetadata,
  encodeCharterRegistrationPayload, hashCharterRegistrationPayload,
  encodeCharterRegistrationPermit, decodeCharterRegistrationPermit,
  CHARTER_REGISTRATION_PAYLOAD_BYTES, CHARTER_REGISTRATION_PERMIT_BYTES,
  type CharterRegistrationPayload, type CharterRegistrationPermit,
} from './charterProtocol';
import { keccak_256 } from '@noble/hashes/sha3.js';

// Synthetic ABI vectors only: these are not deployed program or asset identities.
const pk = (fill: number) => new PublicKey(Buffer.alloc(32, fill));
const economy = pk(1), craft = pk(2), asset = pk(3);
const clan = '12345678-1234-5678-9abc-def012345678';
const clanDomains = [charterPda, charterFreezePda, charterExecutorPda];
const derive = (program: PublicKey) => [
  charterConfigPda(program), charterPda(program, clan), charterAssetPda(program, asset),
  charterFreezePda(program, clan), charterExecutorPda(program, clan),
];

describe('Charter UUID and PDA ABI without signing or authority', () => {
  it('encodes all16 UUID bytes in textual hex order without endian swaps or hashing', () => {
    expect(charterClanIdBytes(clan)).toEqual(Buffer.from('12345678123456789abcdef012345678', 'hex'));
    expect(charterClanIdBytes(clan)).toHaveLength(16);
  });

  it('preserves differences in either UUID half and leading zero bytes', () => {
    const first = charterClanIdBytes('12345679-1234-5678-9abc-def012345678');
    const second = charterClanIdBytes('12345678-1234-5678-9abc-def012345679');
    const original = charterClanIdBytes(clan);
    expect(first.subarray(0, 8)).not.toEqual(original.subarray(0, 8));
    expect(first.subarray(8)).toEqual(original.subarray(8));
    expect(second.subarray(0, 8)).toEqual(original.subarray(0, 8));
    expect(second.subarray(8)).not.toEqual(original.subarray(8));
    expect(charterClanIdBytes('00000000-0000-4000-8000-000000000001').toString('hex'))
      .toBe('00000000000040008000000000000001');
  });

  it('accepts canonical UUID versions1–8 and every RFC variant nibble', () => {
    for (const version of '12345678') for (const variant of '89ab') {
      const value = `00112233-4455-${version}677-${variant}899-aabbccddeeff`;
      expect(charterClanIdBytes(value).toString('hex')).toBe(value.replaceAll('-', ''));
    }
  });

  it('refuses UUID aliases, malformed versions/variants and empty sentinel identities', () => {
    for (const value of [undefined, null, 1, {}, Buffer.alloc(16), '',
      '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
      clan.toUpperCase(), clan.replaceAll('-', ''), `{${clan}}`, `urn:uuid:${clan}`,
      ` ${clan}`, `${clan} `, `${clan}\n`, clan.slice(1), `${clan}0`,
      '00112233-4455-0677-8899-aabbccddeeff', '00112233-4455-9677-8899-aabbccddeeff',
      '00112233-4455-4677-7899-aabbccddeeff', '00112233-4455-4677-c899-aabbccddeeff',
      '00112233-4455-4677-8899-aabbccddeefg']) {
      expect(() => charterClanIdBytes(value as never)).toThrow(TypeError);
      for (const fn of clanDomains) expect(() => fn(economy, value as never)).toThrow(TypeError);
    }
  });

  it('returns a fresh byte buffer for each UUID conversion', () => {
    const first = charterClanIdBytes(clan), second = charterClanIdBytes(clan);
    first.fill(0);
    expect(second.toString('hex')).toBe('12345678123456789abcdef012345678');
    expect(charterClanIdBytes(clan)).toEqual(second);
  });

  it('pins the five PDA seed domains with explicit synthetic program identities', () => {
    const values = [charterConfigPda(economy), charterPda(economy, clan), charterAssetPda(economy, asset),
      charterFreezePda(craft, clan), charterExecutorPda(economy, clan)];
    expect(values.map(key => key.toBase58())).toEqual([
      'AqpJVrUEYs6cUyZEiZBwoKPJtQzL6VhTYDG92pHJrfmM',
      'Ahmr6ZxPALnJcRaGAab6FJzXTs8TD6i7MyNNNhyy1PnQ',
      '2rczKro1HbWybDSyGdD9KEYNpxQrzxGCFW664oK2HccZ',
      '9PxAuT9D41znMPmvPTCJtovc54CE2KKrVv2fK8s7qEKH',
      'J3bLRJNipftFt6aWC5onshCr5wNvAboJngpncHosnauY',
    ]);
    for (const value of values) expect(PublicKey.isOnCurve(value.toBytes())).toBe(false);
  });

  it('binds both UUID halves in every clan-specific PDA', () => {
    for (const fn of clanDomains) {
      const original = fn(economy, clan).toBase58();
      expect(fn(economy, '12345679-1234-5678-9abc-def012345678').toBase58()).not.toBe(original);
      expect(fn(economy, '12345678-1234-5678-9abc-def012345679').toBase58()).not.toBe(original);
    }
  });

  it('separates domains even under one program and binds every supplied program identity', () => {
    const original = derive(economy).map(key => key.toBase58());
    const alternate = derive(craft).map(key => key.toBase58());
    expect(new Set(original).size).toBe(5);
    for (const [index, value] of alternate.entries()) expect(value).not.toBe(original[index]);
    expect(charterAssetPda(economy, pk(4)).toBase58()).not.toBe(charterAssetPda(economy, asset).toBase58());
  });

  it('accepts canonical PublicKey objects across package copies without retaining caller bytes', () => {
    const bytes = economy.toBytes();
    const copy = { toBytes: () => bytes, toBase58: () => economy.toBase58() } as PublicKey;
    const actual = derive(copy).map(key => key.toBase58());
    const assetCopy = { toBytes: () => asset.toBytes(), toBase58: () => asset.toBase58() } as PublicKey;
    expect(charterAssetPda(copy, assetCopy).equals(charterAssetPda(economy, asset))).toBe(true);
    bytes.fill(7);
    expect(actual).toEqual(derive(economy).map(key => key.toBase58()));
    expect(() => derive(copy)).toThrow(TypeError);
  });

  it('refuses zero, malformed, implicit or inconsistent program and asset public keys', () => {
    for (const value of [undefined, null, '', economy.toBase58(), Buffer.alloc(32, 1), pk(0), {},
      { toBytes: () => Buffer.alloc(31, 1), toBase58: () => economy.toBase58() },
      { toBytes: () => Buffer.alloc(33, 1), toBase58: () => economy.toBase58() },
      { toBytes: () => Array(32).fill(1), toBase58: () => economy.toBase58() },
      { toBytes: () => economy.toBytes(), toBase58: () => craft.toBase58() },
      { toBytes: () => economy.toBytes(), toBase58: () => ` ${economy.toBase58()}` },
      { toBytes: () => economy.toBytes(), toBase58: () => '' }]) {
      expect(() => derive(value as never)).toThrow(TypeError);
      expect(() => charterAssetPda(economy, value as never)).toThrow(TypeError);
    }
  });
});

const intent = 'abcdef01-2345-4678-9abc-def012345678';
const registration: CharterRegistrationPayload = {
  config: pk(1), craftProgram: pk(2), craftControl: pk(3), collection: pk(4), collectionAuthority: pk(5),
  charter: pk(6), asset: pk(7), assetBinding: pk(8), freezeAuthority: pk(9), executor: pk(10), creationReceipt: pk(11),
  clanId: clan, leader: pk(12), creationIntentId: intent, metadataHash: Buffer.alloc(32, 13), admissionCommitment: Buffer.alloc(32, 14),
};
const permit: CharterRegistrationPermit = { genesisHash: pk(15), programId: economy, kind: 5, permitId: Buffer.alloc(16, 16),
  wallet: pk(12), expiry: 1_700_000_000n, payloadHash: Buffer.alloc(32, 17) };

describe('Charter kind5 registration wire bytes without policy authority', () => {
  it('separates canonical mint and permanent creation receipt PDA domains with full UUIDs', () => {
    expect(charterMintPda(craft, clan)).toEqual(PublicKey.findProgramAddressSync([Buffer.from('charter_mint'), charterClanIdBytes(clan)], craft)[0]);
    expect(charterCreationPda(economy, intent)).toEqual(PublicKey.findProgramAddressSync([Buffer.from('charter_creation'), charterClanIdBytes(intent)], economy)[0]);
    for (const fn of [charterMintPda, charterCreationPda]) {
      expect(fn(craft, clan)).not.toEqual(fn(economy, clan));
      expect(fn(craft, clan)).not.toEqual(fn(craft, '12345679-1234-5678-9abc-def012345678'));
      expect(fn(craft, clan)).not.toEqual(fn(craft, '12345678-1234-5678-9abc-def012345679'));
      expect(() => fn(craft, clan.toUpperCase())).toThrow(TypeError);
      expect(() => fn(pk(0), clan)).toThrow(TypeError);
    }
  });
  it('binds metadata byte lengths, exact Unicode and the SKCHMET1 domain', () => {
    const value = { name: 'é', uri: 'u' };
    const expected = Buffer.from('534b43484d45543102000000c3a90100000075', 'hex');
    expect(encodeCharterMetadata(value)).toEqual(expected);
    expect(hashCharterMetadata(value)).toEqual(Buffer.from(keccak_256(expected)));
    expect(encodeCharterMetadata({ name: 'é'.repeat(32), uri: 'u'.repeat(512) })).toHaveLength(8 + 4 + 64 + 4 + 512);
    expect(hashCharterMetadata({ name: 'é', uri: 'u' })).not.toEqual(hashCharterMetadata({ name: 'e\u0301', uri: 'u' }));
  });
  it('rejects empty or oversized metadata, lone surrogates and extra caller fields', () => {
    for (const value of [null, [], { name: '', uri: 'u' }, { name: 'n', uri: '' }, { name: 'é'.repeat(33), uri: 'u' },
      { name: 'n', uri: 'u'.repeat(513) }, { name: '\ud800', uri: 'u' }, { name: 'n', uri: '\udfff' },
      { name: 'n', uri: 'u', version: 1 }, { name: 1, uri: 'u' }]) expect(() => encodeCharterMetadata(value as never)).toThrow();
  });
  it('pins all eleven identities and every immutable record field in490 exact bytes', () => {
    const expected = Buffer.from('534b4348524547310100'
      + Array.from({ length: 11 }, (_, index) => (index + 1).toString(16).padStart(2, '0').repeat(32)).join('')
      + '12345678123456789abcdef012345678' + '0c'.repeat(32)
      + 'abcdef01234546789abcdef012345678' + '0d'.repeat(32) + '0e'.repeat(32), 'hex');
    expect(CHARTER_REGISTRATION_PAYLOAD_BYTES).toBe(490);
    expect(encodeCharterRegistrationPayload(registration)).toEqual(expected);
    expect(hashCharterRegistrationPayload(registration)).toEqual(Buffer.from(keccak_256(expected)));
  });
  it('changes the commitment for every pin, UUID half, leader and original digest', () => {
    const original = hashCharterRegistrationPayload(registration);
    for (const field of ['config', 'craftProgram', 'craftControl', 'collection', 'collectionAuthority', 'charter', 'asset',
      'assetBinding', 'freezeAuthority', 'executor', 'creationReceipt', 'leader'] as const) {
      expect(hashCharterRegistrationPayload({ ...registration, [field]: pk(22) })).not.toEqual(original);
    }
    for (const field of ['clanId', 'creationIntentId'] as const) {
      for (const value of ['12345679-1234-5678-9abc-def012345678', '12345678-1234-5678-9abc-def012345679']) {
        expect(hashCharterRegistrationPayload({ ...registration, [field]: value })).not.toEqual(original);
      }
    }
    for (const field of ['metadataHash', 'admissionCommitment'] as const) expect(hashCharterRegistrationPayload({ ...registration, [field]: Buffer.alloc(32, 23) })).not.toEqual(original);
  });
  it('refuses incomplete, extended, zero-key, alias-UUID or absent-hash payloads', () => {
    for (const field of Object.keys(registration)) {
      const missing = { ...registration } as Record<string, unknown>; delete missing[field];
      expect(() => encodeCharterRegistrationPayload(missing as never)).toThrow();
    }
    for (const value of [{ ...registration, arbitrary: true }, { ...registration, config: pk(0) },
      { ...registration, creationReceipt: pk(0) }, { ...registration, clanId: clan.toUpperCase() },
      { ...registration, creationIntentId: intent.replaceAll('-', '') },
      ...['metadataHash', 'admissionCommitment'].flatMap(field => [0, 31, 33].map(length => ({ ...registration, [field]: Buffer.alloc(length) }))),
      { ...registration, metadataHash: Buffer.alloc(32) }, { ...registration, admissionCommitment: Buffer.alloc(32) }]) {
      expect(() => encodeCharterRegistrationPayload(value as never)).toThrow();
    }
  });
  it('pins the existing161-byte native permit domain to kind5 without changing opaque permit IDs', () => {
    const expected = Buffer.from('534b5045524d5432' + '0f'.repeat(32) + '01'.repeat(32) + '05'
      + '10'.repeat(16) + '0c'.repeat(32) + '00f1536500000000' + '11'.repeat(32), 'hex');
    expect(CHARTER_REGISTRATION_PERMIT_BYTES).toBe(161);
    expect(encodeCharterRegistrationPermit(permit)).toEqual(expected);
    expect(decodeCharterRegistrationPermit(expected)).toEqual(permit);
    const opaqueZero = { ...permit, permitId: Buffer.alloc(16) };
    expect(decodeCharterRegistrationPermit(encodeCharterRegistrationPermit(opaqueZero))).toEqual(opaqueZero);
    for (const expiry of [-(1n << 63n), (1n << 63n) - 1n]) expect(decodeCharterRegistrationPermit(encodeCharterRegistrationPermit({ ...permit, expiry })).expiry).toBe(expiry);
  });
  it('rejects other permit purposes, domains, lengths, key aliases and invalid integer types', () => {
    for (const kind of [0, 1, 4, 6, 7, 8, 255]) expect(() => encodeCharterRegistrationPermit({ ...permit, kind } as never)).toThrow();
    for (const expiry of [1, '1', -(1n << 63n) - 1n, 1n << 63n]) expect(() => encodeCharterRegistrationPermit({ ...permit, expiry } as never)).toThrow();
    for (const value of [{ ...permit, wallet: pk(0) }, { ...permit, programId: economy.toBase58() }, { ...permit, payloadHash: Buffer.alloc(31) },
      { ...permit, permitId: Buffer.alloc(15) }, { ...permit, permitId: Buffer.alloc(17) }, { ...permit, authority: true }]) expect(() => encodeCharterRegistrationPermit(value as never)).toThrow();
    const valid = encodeCharterRegistrationPermit(permit);
    for (const length of [0, 160, 162]) expect(() => decodeCharterRegistrationPermit(Buffer.alloc(length))).toThrow();
    for (const at of [0, 72]) { const changed = Buffer.from(valid); changed[at] = changed[at]! ^ 1; expect(() => decodeCharterRegistrationPermit(changed)).toThrow(); }
  });
  it('copies incoming and outgoing digest and permit-ID buffers', () => {
    const encoded = encodeCharterRegistrationPermit(permit), decoded = decodeCharterRegistrationPermit(encoded);
    encoded.fill(0); (decoded.permitId as Buffer).fill(42); (decoded.payloadHash as Buffer).fill(43);
    expect(permit.permitId).toEqual(Buffer.alloc(16, 16)); expect(permit.payloadHash).toEqual(Buffer.alloc(32, 17));
    expect(encodeCharterRegistrationPermit(permit)).toHaveLength(161);
    const bytes = encodeCharterRegistrationPayload(registration); bytes.fill(0);
    expect(registration.metadataHash).toEqual(Buffer.alloc(32, 13));
    expect(hashCharterRegistrationPayload(registration)).not.toEqual(Buffer.alloc(32));
  });
});

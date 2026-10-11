import { CLANS } from '@shardkeep/shared';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  charterAssetPda, charterConfigPda, charterCreationPda, charterExecutorPda,
  charterFreezePda, charterMintPda, charterPda, hashCharterMetadata,
} from '@shardkeep/chain/charter-protocol';
import {
  captureCharterCreationConsent, copyCharterCreationConsent, recoverCharterCreationConsent,
  CharterCreationConsentError,
} from '../src/game/clanCharterCreationConsent';

// These declared references prove consistency only. No fixture value is an
// authenticated ownership epoch, reserved SHARDS balance or mint permit.
// Founding is an untaxed SHARDS spend: creation terms are this consent, not a
// Seeker earning-term snapshot or an eligibility certificate.
const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte));
const clanId = '12345678-1234-5678-9abc-def012345678';
const creationIntentId = '87654321-4321-4321-8abc-def012345678';
const otherId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
function fixture(clan = clanId, intent = creationIntentId) {
  const economy = key(2), craft = key(3), asset = charterMintPda(craft, clan);
  const metadata = { name: 'Orchard Charter', uri: 'https://invalid.example/orchard.json' };
  const craftPda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], craft)[0].toBase58();
  return {
    version: 1 as const, creationIntentId: intent, clanId: clan, payer: key(4).toBase58(),
    funding: { baseId: '11111111-2222-4333-8444-555555555555', deedAssetId: key(5).toBase58(),
      ownershipEpoch: { id: '22222222-3333-4444-8555-666666666666', evidenceCommitment: 'ab'.repeat(32) } },
    clan: { name: 'Orchard', tag: 'ORCH', inviteMode: 'open' as 'open' | 'invite' },
    price: { source: 'CLANS.createCostShards' as const, version: 1 as const, shards: String(CLANS.createCostShards) },
    metadata: { ...metadata, hash: hashCharterMetadata(metadata).toString('hex') },
    chain: { genesisHash: key(1).toBase58(), economyProgram: economy.toBase58(), craftProgram: craft.toBase58(),
      config: charterConfigPda(economy).toBase58(), craftControl: craftPda('charter_control'), collection: craftPda('charter_collection'),
      collectionAuthority: craftPda('charter_collection_authority'), charter: charterPda(economy, clan).toBase58(), asset: asset.toBase58(),
      assetBinding: charterAssetPda(economy, asset).toBase58(), freezeAuthority: charterFreezePda(craft, clan).toBase58(),
      executor: charterExecutorPda(economy, clan).toBase58(), creationReceipt: charterCreationPda(economy, intent).toBase58() },
    reservationId: '44444444-5555-4666-8777-888888888888',
  };
}
type Fixture = ReturnType<typeof fixture>;
function metadataChanged(value: Fixture, name = 'A different Charter') {
  value.metadata.name = name;
  value.metadata.hash = hashCharterMetadata({ name: value.metadata.name, uri: value.metadata.uri }).toString('hex');
}
function expectInvalid(value: unknown) {
  expect(() => copyCharterCreationConsent(value)).toThrow(CharterCreationConsentError);
}

describe('pure declared Charter creation consent; no authority or funds', () => {
  it('captures the existing SHARDS price and all exact original identities without adding authority', () => {
    const source = fixture(), captured = captureCharterCreationConsent(source);
    expect(captured).toEqual(source);
    expect(captured.price.shards).toBe(String(CLANS.createCostShards));
    expect(Object.keys(captured).sort()).toEqual(['version', 'creationIntentId', 'clanId', 'payer', 'funding', 'clan', 'price', 'metadata', 'chain', 'reservationId'].sort());
  });

  it('detaches and freezes every nested object so later caller mutation cannot rewrite original consent', () => {
    const source = fixture(), expected = structuredClone(source), saved = captureCharterCreationConsent(source);
    source.payer = key(9).toBase58(); source.funding.ownershipEpoch.evidenceCommitment = 'ef'.repeat(32);
    source.chain.asset = key(10).toBase58(); source.metadata.uri = 'changed';
    expect(saved).toEqual(expected);
    for (const nested of [saved, saved.funding, saved.funding.ownershipEpoch, saved.clan, saved.price, saved.metadata, saved.chain]) {
      expect(Object.isFrozen(nested)).toBe(true);
    }
    const replay = recoverCharterCreationConsent(expected, structuredClone(expected));
    expected.funding.baseId = otherId;
    expect(replay.funding.baseId).toBe(fixture().funding.baseId);
    expect(replay).not.toBe(saved);
  });

  it('copies and recovers historical price facts without repricing from current constants', () => {
    const historical = fixture(); historical.price.shards = String(BigInt(CLANS.createCostShards) + 1n);
    expect(() => captureCharterCreationConsent(historical)).toThrow(CharterCreationConsentError);
    expect(copyCharterCreationConsent(historical).price).toEqual(historical.price);
    // Object insertion order is not new consent; every field value still binds.
    const reordered = { reservationId: historical.reservationId, chain: historical.chain,
      metadata: historical.metadata, price: historical.price, clan: historical.clan, funding: historical.funding,
      payer: historical.payer, clanId: historical.clanId, creationIntentId: historical.creationIntentId, version: historical.version };
    expect(recoverCharterCreationConsent(historical, reordered)).toEqual(historical);
  });

  it('refuses price aliases, extra fees, missing fields and unsupported versions', () => {
    const source = fixture();
    for (const price of [null, { ...source.price, shards: 0 }, { ...source.price, shards: '0' }, { ...source.price, shards: '01' },
      { ...source.price, shards: '-1' }, { ...source.price, shards: '9223372036854775808' }, { ...source.price, shards: '1\n' },
      { ...source.price, source: 'Workshop' }, { ...source.price, version: 2 }, { ...source.price, feeSol: '0.01' }]) {
      expectInvalid({ ...source, price });
    }
    expectInvalid({ ...source, version: 2 });
    expect(() => captureCharterCreationConsent({ ...source, price: { ...source.price, shards: String(CLANS.createCostShards - 1) } })).toThrow(CharterCreationConsentError);
  });

  it('requires already canonical game names/tags and explicit invite mode, preserving exact-case name uniqueness', () => {
    for (const name of [' Orchard', 'Orchard ', 'A'.repeat(CLANS.nameMinLen - 1), 'A'.repeat(CLANS.nameMaxLen + 1), 'Clan\n', 'Clán']) {
      expectInvalid({ ...fixture(), clan: { ...fixture().clan, name } });
    }
    for (const tag of ['orch', ' ORCH', 'A'.repeat(CLANS.tagMinLen - 1), 'A'.repeat(CLANS.tagMaxLen + 1), 'O-R']) {
      expectInvalid({ ...fixture(), clan: { ...fixture().clan, tag } });
    }
    expectInvalid({ ...fixture(), clan: { name: 'Orchard', tag: 'ORCH' } });
    const lower = fixture(); lower.clan.name = 'orchard';
    expect(copyCharterCreationConsent(lower).clan.name).toBe('orchard');
    expect(() => recoverCharterCreationConsent(fixture(), lower)).toThrow(CharterCreationConsentError);
  });

  it('refuses UUID aliases rather than collapsing distinct recovery identities', () => {
    for (const value of [clanId.toUpperCase(), '00000000-0000-0000-0000-000000000000', clanId + '\n', clanId.replace('-5678-', '-0678-'), clanId.replace('-9abc-', '-7abc-')]) {
      expectInvalid({ ...fixture(), clanId: value }); expectInvalid({ ...fixture(), creationIntentId: value });
    }
    for (const value of [null, '', otherId.toUpperCase()]) {
      const source = fixture();
      expectInvalid({ ...source, reservationId: value });
      expectInvalid({ ...source, funding: { ...source.funding, baseId: value } });
      expectInvalid({ ...source, funding: { ...source.funding, ownershipEpoch: { ...source.funding.ownershipEpoch, id: value } } });
    }
  });

  it('reuses the exact B6g metadata hash/UTF8 byte profile and rejects independently altered content', () => {
    const source = fixture();
    expectInvalid({ ...source, metadata: { ...source.metadata, hash: 'aa'.repeat(32) } });
    expectInvalid({ ...source, metadata: { ...source.metadata, uri: source.metadata.uri + '?changed' } });
    const bounded = fixture(); bounded.metadata.name = 'é'.repeat(32); bounded.metadata.uri = 'u'.repeat(512);
    bounded.metadata.hash = hashCharterMetadata({ name: bounded.metadata.name, uri: bounded.metadata.uri }).toString('hex');
    expect(copyCharterCreationConsent(bounded).metadata).toEqual(bounded.metadata);
    for (const patch of [{ name: 'é'.repeat(33) }, { uri: 'u'.repeat(513) }, { name: '' }, { uri: '' }, { name: '\ud800' }]) {
      expectInvalid({ ...source, metadata: { ...source.metadata, ...patch } });
    }
  });

  it('checks every B6g derived identity instead of accepting caller-chosen asset/config pins', () => {
    const source = fixture();
    for (const field of ['config', 'craftControl', 'collection', 'collectionAuthority', 'charter', 'asset', 'assetBinding', 'freezeAuthority', 'executor', 'creationReceipt'] as const) {
      expectInvalid({ ...source, chain: { ...source.chain, [field]: key(99).toBase58() } });
    }
    // craftProgram is the remaining registration identity; replacing it must
    // also fail the other craft-derived pins, never silently rederive them.
    expectInvalid({ ...source, chain: { ...source.chain, craftProgram: key(98).toBase58() } });
    expectInvalid({ ...source, chain: { ...source.chain, economyProgram: key(97).toBase58() } });
  });

  it('refuses absent/noncanonical keys and empty or malformed declared evidence commitments', () => {
    const source = fixture();
    for (const invalid of ['', 'wallet', PublicKey.default.toBase58(), key(4).toBase58() + '\n']) {
      expectInvalid({ ...source, payer: invalid });
      expectInvalid({ ...source, funding: { ...source.funding, deedAssetId: invalid } });
      expectInvalid({ ...source, chain: { ...source.chain, genesisHash: invalid } });
    }
    for (const invalid of ['', '00'.repeat(32), 'AB'.repeat(32), 'a'.repeat(63) + '\n']) {
      expectInvalid({ ...source, funding: { ...source.funding, ownershipEpoch: { ...source.funding.ownershipEpoch, evidenceCommitment: invalid } } });
    }
  });

  it('rejects authority assertions and guessed ownership revisions at every declared object boundary', () => {
    const source = fixture();
    for (const value of [{ ...source, ready: true }, { ...source, signingAuthorized: true }, { ...source, refundAuthorized: true },
      { ...source, funding: { ...source.funding, updatedAt: '2035-01-01T00:00:00Z' } },
      { ...source, funding: { ...source.funding, ownershipEpoch: { ...source.funding.ownershipEpoch, vehicleRevision: 1 } } },
      { ...source, clan: { ...source.clan, reserved: true } }, { ...source, metadata: { ...source.metadata, verified: true } },
      { ...source, chain: { ...source.chain, deployed: true } }, { ...source, terms: { authenticated: true } }]) expectInvalid(value);
    expectInvalid({ ...source, funding: { baseId: source.funding.baseId, deedAssetId: source.funding.deedAssetId, ownershipRevision: 1 } });
  });

  it('refuses every changed original consent field even when the replacement is independently well-formed', () => {
    const original = fixture();
    const mutations: Array<(value: Fixture) => void> = [
      value => { value.payer = key(91).toBase58(); }, value => { value.funding.baseId = otherId; },
      value => { value.funding.deedAssetId = key(92).toBase58(); }, value => { value.funding.ownershipEpoch.id = otherId; },
      value => { value.funding.ownershipEpoch.evidenceCommitment = 'de'.repeat(32); }, value => { value.reservationId = otherId; },
      value => { value.price.shards = String(CLANS.createCostShards + 1); }, value => { value.clan.name = 'Another clan'; },
      value => { value.clan.tag = 'NEW'; }, value => { value.clan.inviteMode = 'invite'; }, value => { metadataChanged(value); },
      value => { value.chain.genesisHash = key(93).toBase58(); },
    ];
    const changed = mutations.map(change => { const value = fixture(); change(value); return value; });
    changed.push(fixture('12345678-1234-5678-9abc-def012345679'));
    changed.push(fixture(clanId, '87654321-4321-4321-8abc-def012345679'));
    for (const candidate of changed) {
      expect(copyCharterCreationConsent(candidate)).toEqual(candidate);
      expect(() => recoverCharterCreationConsent(original, candidate)).toThrow(CharterCreationConsentError);
    }
    expect(original).toEqual(fixture());
  });

  it('requires no Seeker earning term for untaxed clan founding', () => {
    const source = fixture();
    expect(captureCharterCreationConsent(source)).toEqual(source);
    expectInvalid({ ...source, seekerTerm: { id: otherId, snapshotHash: 'ab'.repeat(32) } });
  });

  it('never treats two equally corrupted historical records as matching consent', () => {
    const corrupt = fixture(); corrupt.metadata.hash = 'ef'.repeat(32);
    expect(() => recoverCharterCreationConsent(corrupt, structuredClone(corrupt))).toThrow(CharterCreationConsentError);
    expectInvalid(null); expectInvalid(undefined); expectInvalid([]);
  });
});

/** Night devnet-test profile (slice S7). WHY: the profile exists so ONE fresh test economy program
 * can run a short auction and pass the economy identity pins on a test server, while the accepted
 * economy id keeps its 86,400 s auction and its identity whatever the environment says. A leaked
 * variable must never change production, and a misconfigured test host must fail loudly. */
import anchorPkg, { type Idl } from '@coral-xyz/anchor';
import { PHASE_E_DEVNET_TEST, PHASE_E_POLICY, PHASE_E_SEEKER_AUCTION } from '@shardkeep/shared';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import idl from './idl/shardkeep_economy.json' with { type: 'json' };
import { devnetTestEconomyProgram, isEconomyProgramIdentity, seekerAuctionSecFor } from './devnetTestProfile';
import { canonicalSeekerRegistry, hashSeekerRegistry } from './seekerAuctionProtocol';
import { decodeSeekerAuctionConfig, seekerBiddingRoundAt } from './seekerAuctionLive';
import { SEEKER_TERM_ACCOUNT_BYTES, type SeekerRawAccount } from './seekerTermAccounts';
import { realmSaleConfigPda, RealmSaleProtocolError } from './seekerRealmSaleProtocol';
import { createSeekerRealmAccessSnapshotReader, SeekerRealmAccessSnapshotError } from './seekerRealmAccessSnapshot';

const { BorshAccountsCoder, BN } = anchorPkg;
const coder = new BorshAccountsCoder(idl as Idl);
const P = PHASE_E_POLICY.seekerIsland, A = PHASE_E_SEEKER_AUCTION, DEV_TEST = PHASE_E_DEVNET_TEST;
const ACCEPTED = idl.address;
const TEST_ID = new PublicKey(Buffer.alloc(32, 7)).toBase58();
const OTHER_ID = new PublicKey(Buffer.alloc(32, 8)).toBase58();
// economy, craft, league, core, distributor: the accepted program ids
const PROTECTED = [ACCEPTED, '4FnNXB9FFSnDmGnwyML28XBugxgzdHqJfXZ1vxXjye59', '2x3PP9GeyvcwvrBCwAjYacTaaLRMhXbzBnRLDAWtninE',
  'mYYQFnpyGofG31y5oJkiKVmNwifbSXBMnQ5aUgQkL6b', '6Tgc32nfuEDwvVQii47eLKZXeu39evzG5142UheuxpKU'];

type ProfileEnv = { profile?: string; cluster?: string; id?: string };
function stub(env: ProfileEnv) {
  vi.stubEnv('PKW_DEVNET_TEST_PROFILE', env.profile);
  vi.stubEnv('SOLANA_CLUSTER', env.cluster);
  vi.stubEnv('PKW_DEVNET_TEST_ECONOMY_PROGRAM_ID', env.id);
}
const active = (id: string) => stub({ profile: DEV_TEST.profile, cluster: 'devnet', id });
afterEach(() => { vi.unstubAllEnvs(); });

/** One AuctionConfig account owned by `programId`, valid in every field except possibly its auction length. */
async function configAccount(programId: string, auctionSec: number): Promise<{ program: PublicKey; raw: SeekerRawAccount }> {
  const program = new PublicKey(programId);
  const pda = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], program);
  const [config, bump] = pda('auction_config');
  const mint = new PublicKey(Buffer.alloc(32, 201)), prizeOwner = new PublicKey(Buffer.alloc(32, 202)), decimals = 6;
  const model = { version: 1, authority: pda('seeker_authority')[0], registry: pda('seeker_registry')[0],
    registry_hash: [...hashSeekerRegistry(canonicalSeekerRegistry())], registry_version: 1, mint, token_program: TOKEN_PROGRAM_ID,
    decimals, prize_owner: prizeOwner, prize_ata: getAssociatedTokenAddressSync(mint, prizeOwner, true), prize_bps: A.prizeBps,
    opening_bid: new BN((BigInt(A.openingBidSkr) * 10n ** BigInt(decimals)).toString()),
    first_operating_start: new BN('1791158400'), term_sec: new BN(String(P.operatingTermSec)), auction_sec: new BN(String(auctionSec)),
    grace_sec: new BN(String(A.settlementGraceSec)), auction_format: 1, terms_format: 1, bump };
  const encoded = await coder.encode('AuctionConfig', model);
  const data = Buffer.alloc(SEEKER_TERM_ACCOUNT_BYTES.AuctionConfig);
  expect(encoded.length).toBeLessThanOrEqual(data.length); encoded.copy(data);
  return { program, raw: { address: config, owner: program, executable: false, data } };
}

describe('night devnet-test profile, keyed by one program id', () => {
  it('is off with the environment unset, so only the IDL address is the economy and it keeps 86,400 s', () => {
    stub({});
    expect(devnetTestEconomyProgram()).toBeNull();
    expect(isEconomyProgramIdentity(ACCEPTED)).toBe(true);
    expect(isEconomyProgramIdentity(TEST_ID)).toBe(false);
    expect(seekerAuctionSecFor(ACCEPTED)).toBe(86_400);
    expect(seekerAuctionSecFor(TEST_ID)).toBe(P.overlappingAuctionSec);
  });

  it('shortens the auction below both the accepted auction and the operating term', () => {
    expect(DEV_TEST.overlappingAuctionSec).toBeGreaterThan(0);
    expect(DEV_TEST.overlappingAuctionSec).toBeLessThan(P.overlappingAuctionSec);
    expect(DEV_TEST.overlappingAuctionSec).toBeLessThan(P.operatingTermSec);
  });

  it('refuses loudly when the test id names an accepted or protected program, and the accepted id is untouched', () => {
    for (const id of [...PROTECTED, PublicKey.default.toBase58()]) {
      active(id);
      expect(() => devnetTestEconomyProgram()).toThrow('Devnet test profile refused');
      expect(() => isEconomyProgramIdentity(OTHER_ID)).toThrow('Devnet test profile refused');
      expect(() => seekerAuctionSecFor(OTHER_ID)).toThrow('Devnet test profile refused');
      // The accepted id never reads the environment: same identity and calendar as production.
      expect(isEconomyProgramIdentity(ACCEPTED)).toBe(true);
      expect(seekerAuctionSecFor(ACCEPTED)).toBe(P.overlappingAuctionSec);
    }
  });

  it('refuses loudly when the test id is not a canonical base58 public key', () => {
    for (const id of ['not-a-key', `${TEST_ID} `, ` ${TEST_ID}`, '1111']) {
      active(id);
      expect(() => devnetTestEconomyProgram()).toThrow('Devnet test profile refused');
    }
  });

  it('stays off unless the profile name matches, the cluster is explicitly devnet and an id is given', () => {
    const off: ProfileEnv[] = [
      { profile: DEV_TEST.profile, cluster: 'mainnet-beta', id: TEST_ID },
      // config.ts defaults SOLANA_CLUSTER to devnet; the profile still needs it written out.
      { profile: DEV_TEST.profile, id: TEST_ID },
      { profile: 'night-devnet-test', cluster: 'devnet', id: TEST_ID },
      { cluster: 'devnet', id: TEST_ID },
      { profile: DEV_TEST.profile, cluster: 'devnet', id: '' },
      { profile: DEV_TEST.profile, cluster: 'devnet' },
    ];
    for (const env of off) {
      stub(env);
      expect(devnetTestEconomyProgram()).toBeNull();
      expect(isEconomyProgramIdentity(TEST_ID)).toBe(false);
      expect(seekerAuctionSecFor(TEST_ID)).toBe(P.overlappingAuctionSec);
      expect(seekerAuctionSecFor(ACCEPTED)).toBe(P.overlappingAuctionSec);
    }
  });

  it('gives only the named fresh id the test calendar and identity; the accepted id keeps 86,400 s', () => {
    active(TEST_ID);
    expect(devnetTestEconomyProgram()).toBe(TEST_ID);
    expect(isEconomyProgramIdentity(TEST_ID)).toBe(true);
    expect(isEconomyProgramIdentity(ACCEPTED)).toBe(true);
    expect(isEconomyProgramIdentity(OTHER_ID)).toBe(false);
    expect(seekerAuctionSecFor(TEST_ID)).toBe(DEV_TEST.overlappingAuctionSec);
    expect(seekerAuctionSecFor(ACCEPTED)).toBe(86_400);
    expect(seekerAuctionSecFor(OTHER_ID)).toBe(P.overlappingAuctionSec);
  });

  it('reads the environment on every call, so removing the variables switches the profile off at once', () => {
    active(TEST_ID);
    expect(isEconomyProgramIdentity(TEST_ID)).toBe(true);
    stub({});
    expect(isEconomyProgramIdentity(TEST_ID)).toBe(false);
    expect(seekerAuctionSecFor(TEST_ID)).toBe(P.overlappingAuctionSec);
  });
});

describe('the live readers follow the profile for the test id only', () => {
  it('keeps the accepted program on 86,400 s in the live config decoder while the profile is active', async () => {
    active(TEST_ID);
    const accepted = await configAccount(ACCEPTED, P.overlappingAuctionSec);
    expect(decodeSeekerAuctionConfig(accepted.program, accepted.raw).auctionSec).toBe(BigInt(P.overlappingAuctionSec));
    const shortened = await configAccount(ACCEPTED, DEV_TEST.overlappingAuctionSec);
    expect(() => decodeSeekerAuctionConfig(shortened.program, shortened.raw)).toThrow('calendar duration');
  });

  it('decodes the named test program on the test calendar, and only while the profile is active', async () => {
    const short = await configAccount(TEST_ID, DEV_TEST.overlappingAuctionSec);
    stub({});
    expect(() => decodeSeekerAuctionConfig(short.program, short.raw)).toThrow('calendar duration');
    active(TEST_ID);
    const config = decodeSeekerAuctionConfig(short.program, short.raw);
    expect(config.auctionSec).toBe(BigInt(DEV_TEST.overlappingAuctionSec));
    expect(config.termSec).toBe(BigInt(P.operatingTermSec));
    expect(seekerBiddingRoundAt(config, config.firstOperatingStart - 1n)).toBe(0n);
    const long = await configAccount(TEST_ID, P.overlappingAuctionSec);
    expect(() => decodeSeekerAuctionConfig(long.program, long.raw)).toThrow('calendar duration');
  });

  it('lets the realm-sale identity pin accept the named test program only while the profile is active', () => {
    const test = new PublicKey(TEST_ID), other = new PublicKey(OTHER_ID);
    stub({});
    expect(() => realmSaleConfigPda(test)).toThrow(RealmSaleProtocolError);
    expect(realmSaleConfigPda(new PublicKey(ACCEPTED))).toBeInstanceOf(PublicKey);
    active(TEST_ID);
    expect(realmSaleConfigPda(test).equals(PublicKey.findProgramAddressSync([Buffer.from('realm_sale_config')], test)[0])).toBe(true);
    expect(() => realmSaleConfigPda(other)).toThrow(RealmSaleProtocolError);
  });

  it('lets the realm access reader be built for the named test program only while the profile is active', () => {
    const trust = (programId: string) => ({ programId: new PublicKey(programId), developer: new PublicKey(Buffer.alloc(32, 9)),
      expectedGenesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG', reviewedDeploymentSlot: 1,
      reviewedProgramDataSha256: '0'.repeat(64), upgradeAuthority: null, stateProvenance: 'fresh-reviewed-deployment' as const });
    const connect = () => { throw new Error('no RPC in this test'); };
    stub({});
    expect(() => createSeekerRealmAccessSnapshotReader(connect, trust(TEST_ID))).toThrow(SeekerRealmAccessSnapshotError);
    expect(typeof createSeekerRealmAccessSnapshotReader(connect, trust(ACCEPTED))).toBe('function');
    active(TEST_ID);
    expect(typeof createSeekerRealmAccessSnapshotReader(connect, trust(TEST_ID))).toBe('function');
    expect(() => createSeekerRealmAccessSnapshotReader(connect, trust(OTHER_ID))).toThrow(SeekerRealmAccessSnapshotError);
  });
});

import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { PHASE_E_CHARTER_TRANSFER, PHASE_E_DEVNET_TEST, PHASE_E_POLICY, PHASE_E_SEEKER_SALE, PHASE_E_SEEKER_AUCTION, PHASE_E_MINING_PUBLICATION, TOKEN } from '@shardkeep/shared';
import { ECONOMY_CONSTANTS_FILE, ECONOMY_DEVNET_TEST_CONSTANTS_FILE, generateEconomyConstants, generateEconomyDevnetTestConstants } from './generate-economy-constants';

describe('economy Rust policy projection', () => {
  it('keeps the compiled Rust policy identical to the shared authority', async () => {
    expect(await readFile(ECONOMY_CONSTANTS_FILE, 'utf8')).toBe(generateEconomyConstants());
  });
  it('retains independent duration policies and emits only fixed-width numeric declarations', () => {
    const source = generateEconomyConstants();
    const declarations = source.split('\n').filter(line => line.startsWith('pub const'));
    expect(declarations).toHaveLength(35);
    for (const line of declarations) expect(line).toMatch(/^pub const [A-Z_]+: (usize|u64|u32|u16|u8|i64) = [0-9]+;$/);
    // Ordinary Charter sales must use the same royalty policy in Rust and the API.
    expect(source).toContain(`CHARTER_ROYALTY_BPS: u16 = ${PHASE_E_CHARTER_TRANSFER.royaltyBps};`);
    expect(source).toContain(`SETTLEMENT_GRACE_SEC: i64 = ${PHASE_E_SEEKER_AUCTION.settlementGraceSec};`);
    expect(source).toContain(`MAX_POLICY_PERMIT_TTL_SEC: i64 = ${PHASE_E_SEEKER_AUCTION.maxPolicyPermitTtlSec};`);
    expect(source).toContain(`OPERATING_TERM_SEC: i64 = ${PHASE_E_POLICY.seekerIsland.operatingTermSec};`);
    expect(source).toContain(`OVERLAPPING_AUCTION_SEC: i64 = ${PHASE_E_POLICY.seekerIsland.overlappingAuctionSec};`);
    expect(source).toContain(`MINING_GROSS_DAILY_CEILING_BASE_UNITS: u64 = ${PHASE_E_POLICY.mining.grossDailyCeilingKeep * 10 ** TOKEN.decimals};`);
    expect(source).toContain(`MINING_CLAIM_DELAY_SEC: i64 = ${PHASE_E_MINING_PUBLICATION.claimDelaySec};`);
    expect(source).toContain(`MINING_FREE_POOL_BPS: u64 = ${PHASE_E_POLICY.mining.freePoolBps};`);
    expect(source).toContain(`MINING_DEED_POOL_BPS: u64 = ${PHASE_E_POLICY.mining.deedPoolBps};`);
    const p=PHASE_E_MINING_PUBLICATION,t=PHASE_E_POLICY.taxes.minedKeep;
    expect(p.splitPlayerUnits+p.splitRecycleUnits+p.splitTaxUnits).toBe(p.splitPeriod);
    expect(p.splitPlayerUnits*PHASE_E_POLICY.basisPoints).toBe(t.playerBps*p.splitPeriod);
    expect(p.splitRecycleUnits*PHASE_E_POLICY.basisPoints).toBe(t.recycleBps*p.splitPeriod);
    expect(p.splitTaxUnits*PHASE_E_POLICY.basisPoints).toBe(t.islandPoolBps*p.splitPeriod);
    const sale = PHASE_E_POLICY.seekerIsland;
    expect(source).toContain(`REALM_SALE_VERSION: u8 = ${PHASE_E_SEEKER_SALE.version};`);
    expect(source).toContain(`REALM_SALE_QUOTE_TTL_SEC: i64 = ${PHASE_E_SEEKER_SALE.quoteTtlSec};`);
    expect(source).toContain(`REALM_SALE_PRICE_LAMPORTS: u64 = ${sale.permitPriceLamports};`);
    expect(source).toContain(`REALM_SALE_DURATION_SEC: i64 = ${sale.permitDurationSec};`);
    expect(source).toContain(`REALM_SALE_SELLER_BPS: u16 = ${sale.contractSellerBps};`);
    expect(source).toContain(`REALM_SALE_DEV_BPS: u16 = ${sale.contractDevBps};`);
    expect(source).toContain(`REALM_SALE_DAILY_QUOTA: u8 = ${sale.paidContractsPerSpotDayMax};`);
    expect(source).toBe(generateEconomyConstants());
  });
});

describe('devnet-test economy projection', () => {
  // WHY: the night 2026-10-06 devnet TEST build swaps only the auction length. Any other drift would make the
  // rehearsal prove a different program than the accepted one, so every other declaration must stay identical.
  const declarations = (source: string) => source.split('\n').filter(line => line.startsWith('pub const'));

  it('keeps the compiled devnet-test Rust file identical to its generator', async () => {
    expect(await readFile(ECONOMY_DEVNET_TEST_CONSTANTS_FILE, 'utf8')).toBe(generateEconomyDevnetTestConstants());
  });
  it('emits the same 35 fixed-width numeric declarations as the accepted projection', () => {
    const lines = declarations(generateEconomyDevnetTestConstants());
    expect(lines).toHaveLength(35);
    for (const line of lines) expect(line).toMatch(/^pub const [A-Z_]+: (usize|u64|u32|u16|u8|i64) = [0-9]+;$/);
  });
  it('differs from the accepted projection in exactly one line, the overlapping auction length', () => {
    const accepted = declarations(generateEconomyConstants());
    const devnetTest = declarations(generateEconomyDevnetTestConstants());
    expect(devnetTest).toHaveLength(accepted.length);
    const differing = devnetTest.filter((line, index) => line !== accepted[index]);
    expect(differing).toEqual([`pub const OVERLAPPING_AUCTION_SEC: i64 = ${PHASE_E_DEVNET_TEST.overlappingAuctionSec};`]);
  });
  it('keeps the seven-day operating term and the settlement grace of the accepted build', () => {
    // WHY: the expedition term code and the settlement window assume these; only the auction may be shortened.
    const accepted = declarations(generateEconomyConstants());
    const devnetTest = declarations(generateEconomyDevnetTestConstants());
    for (const line of [
      `pub const OPERATING_TERM_SEC: i64 = ${PHASE_E_POLICY.seekerIsland.operatingTermSec};`,
      `pub const SETTLEMENT_GRACE_SEC: i64 = ${PHASE_E_SEEKER_AUCTION.settlementGraceSec};`,
    ]) {
      expect(accepted).toContain(line);
      expect(devnetTest).toContain(line);
    }
  });
  it('keeps the test auction positive, shorter than the accepted auction, and inside one operating term', () => {
    const seconds = PHASE_E_DEVNET_TEST.overlappingAuctionSec;
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(PHASE_E_POLICY.seekerIsland.overlappingAuctionSec);
    expect(seconds).toBeLessThanOrEqual(PHASE_E_POLICY.seekerIsland.operatingTermSec);
  });
});

import { describe, expect, it } from 'vitest';
import { PHASE_E_DIVINE_FRAGMENTS as P, PHASE_E_POLICY } from './constants';
import { RAW_RESOURCE_STORAGE_MAX as MAX } from './phaseEResources';
import { DIVINE_FRAGMENT_POLICY, divineFragmentIndividualBudget, divineFragmentSeekerShare, divineFragmentWeekAt, splitDivineFragmentAward, divineFragmentClanSite, splitDivineClanFragmentAward } from './divineFragments';

describe('D192 bounded individual issuance arithmetic, without source authority', () => {
  it('selects the accepted partition without adopting salvage or a recipe', () => {
    expect(DIVINE_FRAGMENT_POLICY).toEqual({ version: 1, resourceId: 'crystal_fragment', weeklyGross: '10000', periodDays: 7,
      individualGross: '7000', clanGross: '2000', salvageGross: '1000', individualSites: 500, grossPerSite: '14',
      basisPoints: 10000, playerBps: 8000, seekerBps: 2000, developerBps: 0 });
    expect(Object.isFrozen(DIVINE_FRAGMENT_POLICY)).toBe(true);
  });
  it('conserves the whole global budget for every possible occupied-site count', () => {
    for (let sites = 0; sites <= P.individualSites; sites++) {
      const b = divineFragmentIndividualBudget(sites);
      expect(b.issuedGross).toBe(BigInt(sites) * 14n);
      expect(b.issuedGross + b.unissuedIndividual + b.unissuedOther).toBe(b.weeklyGross);
      expect(b.unissuedOther).toBe(3000n);
      expect(b.unissuedTotal).toBe(b.weeklyGross - b.issuedGross);
    }
  });
  it.each([-1, 501, 1.5, NaN, Infinity])('rejects invalid occupied count %s', n => expect(() => divineFragmentIndividualBudget(n)).toThrow());
  it('proves all carry states conserve the locked tax numerator', () => {
    for (let carry = 0n; carry < BigInt(P.basisPoints); carry++) {
      const split = splitDivineFragmentAward(carry);
      expect(split.net + split.tax).toBe(14n);
      expect(split.tax * BigInt(P.basisPoints) + split.nextCarry).toBe(14n * BigInt(P.seekerBps) + carry);
      expect(split.nextCarry >= 0n && split.nextCarry < BigInt(P.basisPoints)).toBe(true);
    }
  });
  it('preserves wallet carry over five distinct weeks, bases and original Seeker terms', () => {
    let carry = 0n, net = 0n, tax = 0n;
    const originalTermTaxes: bigint[] = [];
    for (let week = 0; week < 5; week++) {
      const award = splitDivineFragmentAward(carry);
      carry = award.nextCarry; net += award.net; tax += award.tax; originalTermTaxes.push(award.tax);
    }
    expect({ carry, net, tax, originalTermTaxes }).toEqual({ carry: 0n, net: 56n, tax: 14n, originalTermTaxes: [2n, 3n, 3n, 3n, 3n] });
    expect(net * BigInt(P.basisPoints)).toBe(70n * BigInt(P.playerBps));
  });
  it.each([-1n, 10000n, MAX])('rejects invalid carry %s', carry => expect(() => splitDivineFragmentAward(carry)).toThrow());
  it('aligns canonical weeks to the Unix epoch, not Saturday entry', () => {
    expect(divineFragmentWeekAt('1970-01-01T00:00:00.000Z')).toBe('1970-01-01T00:00:00.000Z');
    expect(divineFragmentWeekAt('1970-01-03T00:00:00.000Z')).toBe('1970-01-01T00:00:00.000Z');
    expect(divineFragmentWeekAt('1970-01-07T23:59:59.999Z')).toBe('1970-01-01T00:00:00.000Z');
    expect(divineFragmentWeekAt('1970-01-08T00:00:00.000Z')).toBe('1970-01-08T00:00:00.000Z');
    expect(divineFragmentWeekAt('1969-12-31T23:59:59.999Z')).toBe('1969-12-25T00:00:00.000Z');
  });
  it.each(['2026-02-30T00:00:00.000Z', '2026-01-01', '2026-01-01T00:00:00Z'])('rejects noncanonical earning time %s', value => expect(() => divineFragmentWeekAt(value)).toThrow());
  it('retains equal-spot division dust and only pays cumulative increments', () => {
    for (let winners = 1; winners <= PHASE_E_POLICY.seekerIsland.totalSpots; winners++) {
      const first = divineFragmentSeekerShare(1400n, winners, 0n);
      const next = divineFragmentSeekerShare(2800n, winners, first.cumulativeTotal);
      expect(first.cumulativeTotal * BigInt(winners) + first.dust).toBe(1400n);
      expect(first.quantity + next.quantity).toBe(next.cumulativeTotal);
    }
  });
  it.each([[1n, 0, 0n], [1n, 101, 0n], [-1n, 1, 0n], [MAX + 1n, 1, 0n], [1n, 1, 2n]] as const)('holds invalid or zero-winner pool %s/%s/%s', (pool, winners, previous) => expect(() => divineFragmentSeekerShare(pool, winners, previous)).toThrow());
});

describe('D193 bounded original roster production shares', () => {
  it('conserves the full clan partition and leaves vacancy and roster division dust unissued', () => {
    for(let roster=1;roster<=P.clanRosterCap;roster++){
      const share=divineFragmentClanSite(roster);
      expect(share.issuedGross+share.unissuedDust).toBe(40n);
      for(let occupied=0;occupied<=P.clanSites;occupied++)
        expect(share.issuedGross*BigInt(occupied)+share.unissuedDust*BigInt(occupied)+share.siteGross*BigInt(P.clanSites-occupied)).toBe(2000n);
    }
    expect(divineFragmentClanSite(3)).toEqual({siteGross:40n,gross:13n,issuedGross:39n,unissuedDust:1n});
  });
  it('carries one wallet fraction through individual and clan production without retaxing a claim',()=>{
    const individual=splitDivineFragmentAward(0n),clan=splitDivineClanFragmentAward(3,individual.nextCarry),next=splitDivineFragmentAward(clan.nextCarry);
    expect([individual.tax,clan.tax,next.tax]).toEqual([2n,3n,3n]);
    expect(individual.gross+clan.gross+next.gross).toBe(41n);
    expect(next.nextCarry).toBe(2000n);
    expect(divineFragmentSeekerShare(individual.tax+clan.tax,2,1n).quantity).toBe(1n);
  });
  it.each([0,-1,21,1.5,NaN])('rejects invalid original roster %s',n=>expect(()=>divineFragmentClanSite(n)).toThrow());
});

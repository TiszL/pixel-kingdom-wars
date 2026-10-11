import { REALM_IDS } from '@shardkeep/shared/baseVisual';
import { describe, expect, it } from 'vitest';
import { ISLAND_MODEL_PARAMS as P, admitExpedition, assessEarnedTax, expeditionDue,
  purchaseRealmPermit, splitRevenue, resourceEarningsLedger, miningEarningsLedger, marketKeepLedger,
  permitRevenueLedger, allocateIslandTaxPool, balancedSpotCatalogue, issueSpotPermit, validateSpot, islandCycleAt,
  type OccupationSnapshot, type GlobalOccupationSnapshot, type DispatchInput, type ResourceOrigin } from './phase-e-island-model';

const spot = (changes: Partial<OccupationSnapshot> = {}): OccupationSnapshot => ({
  siteId: 'spot-1', kind: 'king', realmOffers: [...REALM_IDS], ownerWallet: 'operator',
  startsAt: 0n, endsAt: P.occupationSeconds, assignmentId: 'epoch-1', termsId: 'terms-1', ...changes,
});
const snapshot = (spots: readonly OccupationSnapshot[] = [spot()]): GlobalOccupationSnapshot => ({
  jurisdiction: 'global', snapshotId: 'snapshot-1', termsId: 'terms-1',
  vacancyPolicy: 'winning-spots-only', termStartsAt: spots[0]?.startsAt ?? 0n,
  termEndsAt: spots[0]?.endsAt ?? P.occupationSeconds, spots,
});
const dispatch = (changes: Partial<DispatchInput> = {}): DispatchInput => ({
  wallet: 'alice', deedRealms: ['crownlands'], targetRealm: 'crownlands',
  vehicleEligible: true, now: 10n, durationSeconds: 600n, rewardTableVersion: 'r1',
  occupation: snapshot(), ...changes,
});

describe('island amendment PROTOTYPE accounting', () => {
  it('twenty percent tax conserves gross/net/tax at tiny and arbitrarily large bigint values', () => {
    for (const gross of [0n, 1n, 4n, 5n, 9_999n, 10_000n, 2n ** 200n]) {
      for (const carry of [0n, 2_000n, 8_000n]) {
        const r = assessEarnedTax(gross, carry, 'new-earnings');
        expect(r.net + r.tax).toBe(gross);
        expect(r.net >= 0n && r.carry < 10_000n && r.carry >= 0n).toBe(true);
        expect(r.tax * 10_000n + r.carry).toBe(gross * 2_000n + carry);
      }
    }
  });
  it('collecting one unit at a time cannot evade tax through rounding', () => {
    let carry = 0n; let net = 0n; let tax = 0n;
    for (let i = 0; i < 137; i++) {
      const r = assessEarnedTax(1n, carry, 'new-earnings');
      carry = r.carry; net += r.net; tax += r.tax;
    }
    const once = assessEarnedTax(137n, 0n, 'new-earnings');
    expect({ gross: 137n, net, tax, carry }).toEqual(once);
  });
  it.each(['tax-receipt', 'conversion', 'existing-transfer', 'refund'] as ResourceOrigin[])('does not recursively tax %s or reset earned carry', (origin) => {
    expect(assessEarnedTax(100n, 8_000n, origin)).toEqual({ gross: 100n, net: 100n, tax: 0n, carry: 8_000n });
  });
  it('the internal split primitive is invariant to chunked collection at a fixture rate', () => {
    let carry = 0n; let owner = 0n; let remainderRecipient = 0n;
    for (let i = 0; i < 101; i++) {
      const r = splitRevenue(1n, 3_700n, carry);
      carry = r.carry; owner += r.owner; remainderRecipient += r.remainderRecipient;
    }
    expect({ owner, remainderRecipient, carry }).toEqual(splitRevenue(101n, 3_700n, 0n));
    expect(owner + remainderRecipient).toBe(101n);
  });
  it('the internal split primitive conserves extreme rates and rejects invalid basis points', () => {
    expect(splitRevenue(100n, 0n, 0n).owner).toBe(0n);
    expect(splitRevenue(100n, 10_000n, 0n).owner).toBe(100n);
    expect(() => splitRevenue(100n, 10_001n, 0n)).toThrow('invalid share');
  });
  it('net resources fund recipes: 12500 gross SHARDS yield exactly one 10000-SHARDS ingot', () => {
    const r = assessEarnedTax(12_500n, 0n, 'new-earnings');
    expect(r.net).toBe(10_000n); expect(r.tax).toBe(2_500n);
    expect(assessEarnedTax(r.net, r.carry, 'conversion').tax).toBe(0n);
  });
  it('rejects corrupt carries and negative gross values rather than minting negative tax', () => {
    expect(() => assessEarnedTax(-1n, 0n, 'new-earnings')).toThrow('nonnegative');
    expect(() => assessEarnedTax(1n, 10_000n, 'new-earnings')).toThrow('carry');
    expect(() => splitRevenue(1n, 1n, -1n)).toThrow('carry');
  });
});

describe('owner-locked separate earnings/market ledgers', () => {
  const atoms = 1_000_000_000n;
  const resourceCarry = { earned: 0n };
  const miningCarry = { ...resourceCarry, recycleShare: 0n };
  it('resources and SHARDS split 80/20/0 exactly, with all tax to the global equal-spot pool', () => {
    expect(resourceEarningsLedger(100n, resourceCarry)).toEqual({ gross: 100n, net: 80n,
      tax: 20n, islandPool: 20n, developer: 0n, carry: resourceCarry });
  });
  it('98000 gross mining yields 78400 net, 9800 recycled, 9800 island pool and zero developer', () => {
    const r = miningEarningsLedger(98_000n * atoms, miningCarry);
    expect(r.net).toBe(78_400n * atoms); expect(r.recycled).toBe(9_800n * atoms);
    expect(r.islandPool).toBe(9_800n * atoms); expect(r.developer).toBe(0n);
    expect(r.islandPool).toBe(r.tax - r.recycled);
    expect(r.net + r.recycled + r.islandPool + r.developer).toBe(r.gross);
  });
  it('the 5/95 mining split is gross; free players net3920 and deed players net74480 at full funding', () => {
    expect(miningEarningsLedger(4_900n * atoms, miningCarry).net).toBe(3_920n * atoms);
    expect(miningEarningsLedger(93_100n * atoms, miningCarry).net).toBe(74_480n * atoms);
  });
  it('chunking cannot change any resource or mining beneficiary total', () => {
    let rc = resourceCarry; let mc = miningCarry;
    const totals = { rn: 0n, ro: 0n, rd: 0n, mn: 0n, mr: 0n, mo: 0n, md: 0n };
    for (let i = 0; i < 137; i++) {
      const r = resourceEarningsLedger(1n, rc); rc = r.carry;
      const m = miningEarningsLedger(1n, mc); mc = m.carry;
      totals.rn += r.net; totals.ro += r.islandPool; totals.rd += r.developer;
      totals.mn += m.net; totals.mr += m.recycled; totals.mo += m.islandPool; totals.md += m.developer;
      expect(m.net + m.recycled + m.islandPool + m.developer).toBe(1n);
    }
    const r = resourceEarningsLedger(137n, resourceCarry); const m = miningEarningsLedger(137n, miningCarry);
    expect(totals).toEqual({ rn: r.net, ro: r.islandPool, rd: r.developer, mn: m.net, mr: m.recycled,
      mo: m.islandPool, md: m.developer });
    expect(rc).toEqual(r.carry); expect(mc).toEqual(m.carry);
  });
  it('market burns10% permanently; emission recycling and tax proceeds are not that burn', () => {
    expect(marketKeepLedger(100n * atoms)).toEqual({ gross: 100n * atoms, seller: 90n * atoms, burned: 10n * atoms });
    const r = miningEarningsLedger(100n, miningCarry);
    expect(r.recycled).toBe(10n); expect('burned' in r).toBe(false);
  });
  it('retains market per-fill upward burn rounding and minimum rather than inventing carried market dust', () => {
    const gross = P.marketMinFillAtoms + 1n;
    const one = marketKeepLedger(gross); const together = marketKeepLedger(gross * 10n);
    expect(one.burned * 10n >= together.burned).toBe(true);
    expect(one.seller + one.burned).toBe(gross);
    expect(one.burned * 10n >= gross).toBe(true);
    expect(() => marketKeepLedger(P.marketMinFillAtoms - 1n)).toThrow('minimum');
  });
  it.each(['tax-receipt', 'existing-transfer', 'refund', 'conversion'] as ResourceOrigin[])('%s never recursively issues mining tax', (origin) => {
    const r = miningEarningsLedger(100n, miningCarry, origin);
    expect(r.net).toBe(100n); expect(r.tax).toBe(0n);
    expect(r.recycled + r.islandPool + r.developer).toBe(0n);
  });
  it('the permit splits its exact0.01SOL as0.005owner/0.005developer', () => {
    expect(permitRevenueLedger(P.permitLamports)).toEqual({ gross: 10_000_000n,
      owner: 5_000_000n, developer: 5_000_000n });
  });
});

describe('island amendment PROTOTYPE permit and occupation boundaries', () => {
  it('fails closed when the global equal-spot pool snapshot is unavailable', () => {
    expect(() => admitExpedition({ ...dispatch(), occupation: undefined } as unknown as DispatchInput)).toThrow('pool snapshot unavailable');
  });
  it('a valid deed realm needs a vehicle but no paid permit', () => {
    expect(admitExpedition(dispatch()).access).toBe('deed-realm');
    expect(() => admitExpedition(dispatch({ vehicleEligible: false }))).toThrow('vehicle');
  });
  it('a 0.01 SOL permit lasts seven days and covers one wallet and one target realm', () => {
    const permit = purchaseRealmPermit('alice', 'elderwood', 0n, P.permitLamports, 'terms-1');
    expect(permit.expiresAt).toBe(604_800n);
    expect(admitExpedition(dispatch({ targetRealm: 'elderwood', permit })).access).toBe('paid-permit');
    expect(() => admitExpedition(dispatch({ targetRealm: 'sunscar', permit }))).toThrow('access');
    expect(() => admitExpedition(dispatch({ wallet: 'bob', targetRealm: 'elderwood', permit }))).toThrow('access');
    expect(() => purchaseRealmPermit('alice', 'elderwood', 0n, P.permitLamports - 1n, 'terms-1')).toThrow('amount');
  });
  it('a paid permit cannot bypass vehicle restrictions or start before its purchase/at expiry', () => {
    const permit = purchaseRealmPermit('alice', 'elderwood', 10n, P.permitLamports, 'terms-1');
    expect(() => admitExpedition(dispatch({ targetRealm: 'elderwood', permit, vehicleEligible: false }))).toThrow('vehicle');
    expect(() => admitExpedition(dispatch({ targetRealm: 'elderwood', permit, now: 9n }))).toThrow('access');
    expect(() => admitExpedition(dispatch({ targetRealm: 'elderwood', permit, now: permit.expiresAt }))).toThrow('access');
  });
  it('a legal dispatch immediately before permit expiry can return later without repurchase', () => {
    const permit = purchaseRealmPermit('alice', 'elderwood', 0n, P.permitLamports, 'terms-1');
    const trip = admitExpedition(dispatch({ targetRealm: 'elderwood', permit, now: permit.expiresAt - 1n }));
    expect(expeditionDue(trip, trip.returnsAt - 1n)).toBe(false);
    expect(expeditionDue(trip, trip.returnsAt)).toBe(true);
    expect(trip.returnsAt > permit.expiresAt).toBe(true);
    expect(trip.permitTermsId).toBe('terms-1');
  });
  it('occupation turnover cannot invalidate a bought permit; proposed dispatch beneficiary snapshot stays stable', () => {
    const permit = purchaseRealmPermit('alice', 'elderwood', 0n, P.permitLamports, 'permit-terms');
    const occupation = spot({ ownerWallet: 'old-owner' });
    const trip = admitExpedition(dispatch({ targetRealm: 'elderwood', permit,
      now: P.occupationSeconds - 1n, occupation: snapshot([occupation]) }));
    occupation.ownerWallet = 'new-owner';
    expect(trip.occupation.spots[0]?.ownerWallet).toBe('old-owner');
    expect(expeditionDue(trip, trip.returnsAt)).toBe(true);
    const next = { ...occupation, startsAt: P.occupationSeconds, endsAt: 2n * P.occupationSeconds, assignmentId: 'a2' };
    const longPermit = purchaseRealmPermit('alice', 'elderwood', 100n, P.permitLamports, 'permit-terms');
    expect(admitExpedition(dispatch({ targetRealm: 'elderwood', permit: longPermit,
      now: P.occupationSeconds, occupation: snapshot([next]) })).permitTermsId).toBe('permit-terms');
  });
  it('rejects stale occupation assignments instead of quietly paying the departed operator', () => {
    expect(() => admitExpedition(dispatch({ occupation: snapshot(), now: P.occupationSeconds }))).toThrow('global term');
  });
});


describe('100-spot global island model, locked weekly winner denominator', () => {
  const catalogue = balancedSpotCatalogue();
  const occupied = () => catalogue.map((s, i) => spot({ ...s, ownerWallet: `owner-${i}` }));
  it('has20 King/eighty normal spots and a balanced candidate45 offers per realm', () => {
    expect(catalogue).toHaveLength(100);
    expect(catalogue.filter((s) => s.kind === 'king')).toHaveLength(20);
    for (const realm of REALM_IDS) {
      expect(catalogue.filter((s) => s.realmOffers.includes(realm))).toHaveLength(45);
      expect(catalogue.filter((s) => s.kind === 'normal' && s.realmOffers.includes(realm))).toHaveLength(25);
    }
    occupied().forEach((s) => expect(() => validateSpot(s, 1n)).not.toThrow());
  });
  it('all100 spots getequal tax regardlessof King privileges or realm offer count', () => {
    const r = allocateIslandTaxPool(9_800n * 1_000_000_000n, snapshot(occupied()), 1n, 'tax-1');
    expect(r.receipts.every((x) => x.amount === 98n * 1_000_000_000n)).toBe(true);
    expect(r.retained).toBe(0n);
  });
  it('multiple spots aggregate to one owner wallet without collapsing spot shares', () => {
    const sites = occupied(); sites[1]!.ownerWallet = sites[0]!.ownerWallet;
    const r = allocateIslandTaxPool(1_000n, snapshot(sites), 1n, 'tax-1');
    expect(r.wallets.get('owner-0')).toBe(20n); expect(r.wallets.size).toBe(99);
    expect([...r.wallets.values()].reduce((a, b) => a + b, 0n)).toBe(1_000n);
  });
  it('conserves indivisible tax dust and freezes it to the original beneficiary snapshot', () => {
    const sites = occupied(); const snap = snapshot(sites);
    const r = allocateIslandTaxPool(137n, snap, 1n, 'tax-1');
    expect(r.receipts.every((x) => x.amount === 1n)).toBe(true); expect(r.retained).toBe(37n);
    sites[0]!.ownerWallet = 'replacement';
    expect(r.receipts[0]!.ownerWallet).toBe('owner-0');
    expect(r.retainedSnapshotId).toBe('snapshot-1');
    expect(r.receipts[0]!.poolReceiptId).toBe('tax-1');
  });
  it('only weekly winners divide the tax and zero-winner terms hold the entire pool', () => {
    expect(allocateIslandTaxPool(100n, snapshot([spot()]), 1n, 'r').receipts[0]!.amount).toBe(100n);
    expect(allocateIslandTaxPool(100n, snapshot([]), 1n, 'r').retained).toBe(100n);
  });
  it('zero-winner allocation is held and doesnot silentlyauthorize tax-active expeditions', () => {
    expect(allocateIslandTaxPool(100n, snapshot([]), 1n, 'r').held).toBe(true);
    expect(() => admitExpedition(dispatch({ occupation: snapshot([]) }))).toThrow('activation held');
  });
  it('rejects mixed weekly schedules and uses earning time for late historical settlements', () => {
    expect(() => allocateIslandTaxPool(100n, snapshot([spot(), spot({ siteId: 'second',
      startsAt: 1n, endsAt: P.occupationSeconds + 1n })]), 10n, 'r')).toThrow('global term');
    const earnedAt = P.occupationSeconds - 1n; const processedAt = P.occupationSeconds + 100n;
    const old = snapshot([spot({ ownerWallet: 'old-owner' })]);
    expect(processedAt > old.termEndsAt).toBe(true);
    expect(allocateIslandTaxPool(100n, old, earnedAt, 'late-r').receipts[0]!.ownerWallet).toBe('old-owner');
    expect(() => allocateIslandTaxPool(100n, old, processedAt, 'wrong-clock')).toThrow('global term');
  });
  it('small accruals accumulate retaineddust within theirfrozen snapshot instead of losing tax', () => {
    const snap = snapshot(occupied()); let retained = 0n; let distributed = 0n;
    for (let i = 0; i < 137; i++) {
      const r = allocateIslandTaxPool(1n + retained, snap, 1n, `batch-${i}`);
      retained = r.retained; distributed += r.receipts.reduce((sum, x) => sum + x.amount, 0n);
    }
    expect(distributed + retained).toBe(137n); expect(distributed).toBe(100n); expect(retained).toBe(37n);
  });
  it('duplicate spots cannot collecttwice and a21st King cannot enter the pool', () => {
    expect(() => allocateIslandTaxPool(100n, snapshot([spot(), spot()]), 1n, 'r')).toThrow('duplicate spot');
    expect(() => allocateIslandTaxPool(100n, snapshot(Array.from({ length: 21 }, (_, i) => spot({ siteId: `k${i}` }))), 1n, 'r')).toThrow('catalogue');
  });
  it('king must offerall8; normalmust offerfixedunique1to4 validrealms', () => {
    expect(() => validateSpot(spot({ realmOffers: ['crownlands'] }), 1n)).toThrow('offer count');
    expect(() => validateSpot(spot({ kind: 'normal', realmOffers: REALM_IDS.slice(0, 5) }), 1n)).toThrow('offer count');
    expect(() => validateSpot(spot({ kind: 'normal', realmOffers: ['crownlands', 'crownlands'] }), 1n)).toThrow('realm offer');
  });
  it('ten sales acrossdifferent realms exhaustone spot; SOL goesonlyto thatseller/dev', () => {
    const selling = spot(); let counter = { siteId: selling.siteId, utcDay: 0n, sold: 0 };
    for (let i = 0; i < 10; i++) {
      const sale = issueSpotPermit({ spot: selling, counter, wallet: `buyer-${i}`, targetRealm: REALM_IDS[i % 8]!,
        now: 100n, paidLamports: P.permitLamports, purchaseTermsId: 'p1' });
      counter = sale.counter;
      expect(sale.sellerWallet).toBe('operator');
      expect(sale.revenue).toEqual({ gross: 10_000_000n, owner: 5_000_000n, developer: 5_000_000n });
    }
    expect(() => issueSpotPermit({ spot: selling, counter, wallet: 'buyer-11', targetRealm: 'elderwood',
      now: 100n, paidLamports: P.permitLamports, purchaseTermsId: 'p1' })).toThrow('exhausted');
  });
  it('UTC day transition resetscapacity, ownertransition same day doesnot', () => {
    const selling = spot(); const counter = { siteId: selling.siteId, utcDay: 0n, sold: 10 };
    const input = { spot: selling, counter, wallet: 'buyer', targetRealm: 'elderwood' as const,
      now: P.utcDaySeconds, paidLamports: P.permitLamports, purchaseTermsId: 'p1' };
    expect(issueSpotPermit(input).counter.sold).toBe(1);
    expect(() => issueSpotPermit({ ...input, now: 100n, spot: { ...selling, ownerWallet: 'next-owner' } })).toThrow('exhausted');
    expect(() => issueSpotPermit({ ...input, counter: { ...counter, utcDay: 2n } })).toThrow('clock');
  });
  it('a normalspotcannot sellunoffered realm and one spotscountercannot resetanother', () => {
    const selling = spot({ kind: 'normal', realmOffers: ['crownlands'] });
    const input = { spot: selling, counter: { siteId: selling.siteId, utcDay: 0n, sold: 0 },
      wallet: 'buyer', targetRealm: 'elderwood' as const, now: 100n, paidLamports: P.permitLamports, purchaseTermsId: 'p1' };
    expect(() => issueSpotPermit(input)).toThrow('not offered');
    expect(() => issueSpotPermit({ ...input, targetRealm: 'crownlands', counter: { ...input.counter, siteId: 'other' } })).toThrow('counter');
  });
});


describe('global seven-day operation with overlapping next24-hour auction', () => {
  it('incumbent operates allseven days and nextauction only opens onfinal day', () => {
    const boundary = P.occupationSeconds - P.auctionSeconds;
    expect(islandCycleAt(0n, boundary - 1n).nextAuctionOpen).toBe(false);
    const finalDay = islandCycleAt(0n, boundary);
    expect(finalDay.nextAuctionOpen).toBe(true); expect(finalDay.index).toBe(0n);
    expect(finalDay.startsAt).toBe(0n); expect(finalDay.endsAt).toBe(P.occupationSeconds);
    expect(finalDay.nextAuctionEndsAt).toBe(P.occupationSeconds);
  });
  it('nextwinners activateat exactboundary; nonzero origins cannot shift the weekly duration', () => {
    const origin = 123n;
    expect(islandCycleAt(origin, origin + P.occupationSeconds - 1n).index).toBe(0n);
    const next = islandCycleAt(origin, origin + P.occupationSeconds);
    expect(next.index).toBe(1n); expect(next.startsAt).toBe(origin + P.occupationSeconds);
    expect(next.nextAuctionOpen).toBe(false);
    expect(() => islandCycleAt(origin, origin - 1n)).toThrow('origin');
  });
});

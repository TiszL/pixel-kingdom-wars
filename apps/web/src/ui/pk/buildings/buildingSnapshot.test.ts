import { describe, expect, it, vi } from 'vitest';
import { buildingSnapshot, snapshotInfoExtraKind, snapshotShortfall, type BuildingSnapshotFacts } from './buildingSnapshot';
import { upgradePrimaryLook } from './buildingsLogic';

const facts = (patch: Partial<BuildingSnapshotFacts> = {}): BuildingSnapshotFacts => ({
  buildingId: 'tower-1', type: 'archertower', name: 'Archer Tower', level: 4, maxLevel: 10,
  artNow: 'tower-tier-one', artNext: 'tower-tier-two', role: 'Guards the kingdom.', category: 'DEFENCE',
  stats: [{ key: 'HP', now: '340', next: '430' }, { key: 'DMG', now: '90', next: '110' }, { key: 'RNG', now: '5', next: null }],
  canShowUpgrade: true, enabled: true, upgradeCurrency: 'SHARDS', upgradeCost: '521', upgradeCostRaw: '521',
  upgradePriced: true, upgradeTime: '1h 30m', upgradeDetail: 'Server builder detail', paidStep: false, paidOfferReady: false,
  job: null, repair: null, shardsBalance: '900', freeBuilders: 1, totalBuilders: 2, nextBuilderFreeIn: null,
  heroReady: null, wallRow: false, blockedReason: 'Orders are paused here', readOnly: false, constructionBlocked: false,
  busy: false, mine: { mineBuildingId: 'mine-1', accrued: '8,400' }, ...patch,
});
const art = (key: string) => `rendered:${key}`;
const job = { id: 'job-1', kind: 'upgrade', remaining: '1h 12m', freeFinish: false, canReview: true, cancelRefund: null };

describe('buildingSnapshot', () => {
  it("the upgrade chip quotes the current sheet's Shards amount and the next level", () => {
    const ui = buildingSnapshot(facts(), art);
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: '521', status: 'OK' });
    expect(ui.time).toBe('1h 30m'); expect(ui.builders).toBe('1/2 free');
    expect(ui.primary).toMatchObject({ kind: 'UPGRADE', label: 'UPGRADE TO LV 5', sub: 'Server builder detail', state: 'ENABLED' });
    expect(ui.nextLegend).toBe('at LV 5'); expect(ui.name).toBe('ARCHER TOWER');
    expect(ui.headerArt).toBe('rendered:tower-tier-one');
  });

  it('a known balance below the price shows SHORT with the exact shortfall, an unknown balance never does', () => {
    const ui = buildingSnapshot(facts({ shardsBalance: '341' }), art);
    expect(ui.price?.status).toBe('SHORT'); expect(ui.shortfall).toBe('180'); expect(ui.primary.state).toBe('ENABLED');
    const unknown = buildingSnapshot(facts({ shardsBalance: null }), art);
    // WHY: Android MoneyMapperCommon/withCosts (b5df7141) keeps an unknown balance CHECKING;
    // INFO only opens the review, so its navigation stays enabled while the review cannot send.
    expect(unknown.price).toEqual({ currency: 'SHARDS', amount: null, status: 'CHECKING' }); expect(unknown.shortfall).toBeNull();
    expect(unknown.primary.state).toBe('ENABLED'); expect(unknown.primary.reason).toBeNull();
  });

  it('a missing upgrade price is unavailable and the primary says why', () => {
    const ui = buildingSnapshot(facts({ upgradePriced: false }), art);
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
    expect(ui.primary.state).toBe('DISABLED'); expect(ui.primary.reason).toBe('Price unavailable right now');
    const missing = buildingSnapshot(facts({ upgradeCost: null, upgradeCostRaw: null, upgradePriced: false }), art);
    // WHY: b5df7141 requires canonical positive raw cost before the display-cost CHECKING branch.
    expect(missing.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
  });

  it.each([null, '', '-5', 'invalid', '00', '521.0', '+521', ' 521', '521\n'])('holds noncanonical or missing raw cost %s UNAVAILABLE and the INFO primary disabled', (upgradeCostRaw) => {
    for (const upgradeCost of ['521', null]) {
      const ui = buildingSnapshot(facts({ upgradeCostRaw, upgradeCost }), art);
      expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
      expect(ui.primary).toMatchObject({ state: 'DISABLED', reason: 'Price unavailable right now' });
      expect(upgradePrimaryLook('READY', ui.price!, null)).toMatchObject({ kind: 'OFF', sends: false });
    }
  });

  it.each(['', '00', '1.5', '-1', 'invalid', '+900', ' 900', '900\n'])('keeps noncanonical balance %s CHECKING while INFO remains navigation-only', (shardsBalance) => {
    const ui = buildingSnapshot(facts({ shardsBalance }), art);
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'CHECKING' });
    expect(ui.primary).toMatchObject({ kind: 'UPGRADE', state: 'ENABLED', reason: null });
    expect(ui.shortfall).toBeNull();
    expect(upgradePrimaryLook('READY', ui.price!, null)).toMatchObject({ kind: 'WAIT_PRICE', sends: false });
  });

  it('accepts canonical zero balance and compares large integer amounts without rounding', () => {
    const zero = buildingSnapshot(facts({ shardsBalance: '0' }), art);
    expect(zero.price?.status).toBe('SHORT'); expect(zero.shortfall).toBe('521');
    const large = buildingSnapshot(facts({ upgradeCost: '9,007,199,254,740,994', upgradeCostRaw: '9007199254740994', shardsBalance: '9007199254740993' }), art);
    expect(large.price).toEqual({ currency: 'SHARDS', amount: '9,007,199,254,740,994', status: 'SHORT' });
    expect(large.shortfall).toBe('1');
  });

  it('holds a zero quote unavailable because these facts contain no authoritative server-zero verdict', () => {
    for (const [upgradeCost, upgradeCostRaw] of [['0', '0'], ['000.00', '0'], ['521', '0'], ['0', '521']] as const) {
      const ui = buildingSnapshot(facts({ upgradeCost, upgradeCostRaw }), art);
      expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
      expect(ui.shortfall).toBeNull();
    }
  });

  it('a SOL step shows no price on this sheet and still opens the current review', () => {
    const ui = buildingSnapshot(facts({ paidStep: true, paidOfferReady: true, upgradeCurrency: 'SOL' }), art);
    expect(ui.price).toBeNull(); expect(ui.time).toBeNull(); expect(ui.builders).toBeNull();
    expect(ui.primary.state).toBe('ENABLED'); expect(ui.primary.sub).toBe('Paid step · review before paying');
    expect(ui.primary.price).toBeNull();
  });

  it('a running job turns the primary into FINISH without a price pill, on the existing finish path', () => {
    const ui = buildingSnapshot(facts({ job }), art);
    expect(ui.primary).toMatchObject({ kind: 'FINISH', label: 'REVIEW FINISH', state: 'ENABLED', price: null });
    expect(ui.price).toBeNull(); expect(ui.upgrading).toBe(true); expect(ui.stateTag.text).toBe('UPGRADING 1h 12m');
    expect(buildingSnapshot(facts({ job: { ...job, freeFinish: true, canReview: false } }), art).primary.label).toBe('FINISH NOW · FREE');
    expect(buildingSnapshot(facts({ job: { ...job, canReview: false } }), art).primary)
      .toMatchObject({ state: 'DISABLED', reason: 'Finish price unavailable' });
    expect(buildingSnapshot(facts({ job: { ...job, kind: 'build', remaining: null } }), art).stateTag.text).toBe('BUILDING …');
  });

  it("the fifth action is the server's refundable cancel, else the wall row toggle", () => {
    const refundable = facts({ job: { ...job, cancelRefund: '260' } });
    expect(snapshotInfoExtraKind(refundable)).toBe('CANCEL_JOB');
    expect(buildingSnapshot(refundable, art).extra).toMatchObject({ label: 'Cancel upgrade · +260 Shards', art: 'rendered:shape:close' });
    expect(snapshotInfoExtraKind(facts({ job }))).toBeNull();
    expect(snapshotInfoExtraKind(facts({ ...refundable, enabled: false }))).toBeNull();
    expect(buildingSnapshot(facts({ job: { ...job, cancelRefund: '0' } }), art).extra?.label).toBe('Cancel upgrade · +0 Shards');
    const wall = facts({ type: 'wall', category: 'WALL' });
    expect(snapshotInfoExtraKind(wall)).toBe('TOGGLE_ROW');
    expect(buildingSnapshot(wall, art).extra?.label).toBe('Select whole row');
    expect(buildingSnapshot({ ...wall, wallRow: true }, art).extra?.label).toBe('Select single wall');
    expect(snapshotInfoExtraKind({ ...wall, busy: true })).toBeNull();
  });

  it('a spent trap opens its rearm review and max level is a plate, not a button', () => {
    const trap = buildingSnapshot(facts({ repair: { cost: '1,250', time: '2h' }, category: 'TRAP' }), art);
    expect(trap.primary).toMatchObject({ label: 'REARM TRAP', sub: '1,250 Shards · 2h' });
    expect(trap.stateTag).toEqual({ text: 'SPENT', verb: 'RED' }); expect(trap.price).toBeNull();
    const max = buildingSnapshot(facts({ level: 10, canShowUpgrade: false, stats: [{ key: 'HP', now: '900', next: null }] }), art);
    expect(max.primary.kind).toBe('MAX'); expect(max.nextLegend).toBeNull(); expect(max.price).toBeNull();
  });

  it('a blocked base keeps the door visible and says why', () => {
    expect(buildingSnapshot(facts({ enabled: false, readOnly: true }), art).primary)
      .toMatchObject({ kind: 'UPGRADE', state: 'DISABLED', reason: 'Orders are paused here' });
    expect(buildingSnapshot(facts({ type: 'wall', wallRow: true, canShowUpgrade: false }), art).primary.reason).toBe('Use UPGRADE ROW on the bar');
    expect(buildingSnapshot(facts({ canShowUpgrade: false }), art).primary.reason).toBe('Not available now');
  });

  it("stats are the table's values verbatim, a value that does not change is single", () => {
    const ui = buildingSnapshot(facts({ stats: [...facts().stats, { key: 'CAP', now: '20', next: '20' }, { key: 'XYZ', now: null, next: null }] }), art);
    expect(ui.stats.map(row => row.label)).toEqual(['Hitpoints', 'Damage per second', 'Range', 'Capacity', 'XYZ']);
    expect(ui.stats[0]?.next).toBe('430'); expect(ui.stats[3]?.next).toBeNull();
    expect(ui.stats[4]).toMatchObject({ icon: 'shape:info', now: null, art: 'rendered:shape:info' });
  });

  it('preserves unknown builder sides and durations and does not render blank art or invent a builder detail', () => {
    const renderArt = vi.fn(art);
    const ui = buildingSnapshot(facts({ freeBuilders: null, totalBuilders: null, upgradeTime: null, upgradeDetail: null, artNow: '  ', role: ' ' }), renderArt);
    expect(ui.builders).toBe('…/… free'); expect(ui.time).toBe('…'); expect(ui.primary.sub).toBeNull();
    expect(ui.headerArt).toBeNull(); expect(renderArt).not.toHaveBeenCalledWith('  ');
    expect(ui.role).toBe('Field reports on this structure are still being written.');
    expect(buildingSnapshot(facts({ freeBuilders: 0, totalBuilders: null }), art).builders).toBe('0/… free');
  });

  it.each(['GEMS', 'KEEP', 'SOL', 'SKR', 'ITEM', 'UNKNOWN', null])('does not silently relabel an unsupported or unknown %s quote as Shards', (upgradeCurrency) => {
    const ui = buildingSnapshot(facts({ upgradeCurrency }), art);
    expect(ui.price).toBeNull(); expect(ui.time).toBeNull(); expect(ui.builders).toBeNull();
    expect(ui.primary.state).toBe('DISABLED'); expect(ui.primary.reason).toBe('Price unavailable right now');
  });

  it('computes presentation shortfalls with exact decimal digits and treats invalid inputs as unknown', () => {
    expect(snapshotShortfall('9007199254740993.0001', '9007199254740994.0002')).toBe('1.0001');
    expect(snapshotShortfall('0001.50', '2.5')).toBe('1');
    expect(snapshotShortfall('.5', '1')).toBe('0.5');
    expect(snapshotShortfall('1', '1')).toBeNull(); expect(snapshotShortfall('2', '1')).toBeNull();
    for (const value of [null, 'garbage', '-1', 'Infinity', '1,000', '']) expect(snapshotShortfall(value, '521')).toBeNull();
    expect(snapshotShortfall('0', '0')).toBeNull(); expect(snapshotShortfall('0', null)).toBeNull();
  });

  it('retains source category and state precedence without mutating supplied facts', () => {
    const input = facts({ category: 'HERO', heroReady: false }); const before = JSON.stringify(input);
    expect(buildingSnapshot(input, art).stateTag).toEqual({ text: 'RECOVERING', verb: 'GOLD' });
    expect(buildingSnapshot(facts(), art).stateTag).toEqual({ text: 'GUARDING', verb: 'MOSS' });
    expect(buildingSnapshot(facts({ category: 'FEATURE' }), art).stateTag).toEqual({ text: 'READY', verb: 'GREEN' });
    expect(buildingSnapshot(input, art).category).toEqual({ text: 'HERO', verb: 'STONE' });
    expect(JSON.stringify(input)).toBe(before);
  });
});

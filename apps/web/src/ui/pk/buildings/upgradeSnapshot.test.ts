import { describe, expect, it, vi } from 'vitest';
import type { BuildingSnapshotFacts } from './buildingSnapshot';
import { upgradeSnapshot } from './upgradeSnapshot';
import { upgradePrimaryLook } from './buildingsLogic';

const facts = (patch: Partial<BuildingSnapshotFacts> = {}): BuildingSnapshotFacts => ({
  buildingId: 'tower-1', type: 'archertower', name: 'Archer Tower', level: 4, maxLevel: 10,
  artNow: 'tower-tier-one', artNext: 'tower-tier-two', role: null, category: 'DEFENCE',
  stats: [{ key: 'HP', now: '340', next: '430' }, { key: 'DMG', now: '90', next: '110' }, { key: 'RNG', now: '5', next: null }],
  canShowUpgrade: true, enabled: true, upgradeCurrency: 'SHARDS', upgradeCost: '521', upgradeCostRaw: '521', upgradePriced: true,
  upgradeTime: '1h 30m', upgradeDetail: 'Server builder detail', paidStep: false, paidOfferReady: false, job: null, repair: null,
  shardsBalance: '900', freeBuilders: 1, totalBuilders: 2, nextBuilderFreeIn: null, heroReady: null, wallRow: false,
  blockedReason: 'Orders are paused here', readOnly: false, constructionBlocked: false, busy: false,
  mine: { mineBuildingId: 'mine-1', accrued: '8,400' }, ...patch,
});
const art = (key: string) => `rendered:${key}`;

describe('upgradeSnapshot', () => {
  it("a payable Shards upgrade is READY and uses the current sheet's supplied price", () => {
    const ui = upgradeSnapshot(facts(), art)!;
    expect(ui.state).toBe('READY'); expect(ui.price).toEqual({ currency: 'SHARDS', amount: '521', status: 'OK' });
    expect(ui.levelFrom).toBe('LV 4'); expect(ui.levelTo).toBe('LV 5'); expect(ui.name).toBe('ARCHER TOWER');
    expect(ui.newLook).toBe(true); expect(ui.artNow).toBe('rendered:tower-tier-one');
    expect(ui.rows.map(row => row.label)).toEqual(['Hitpoints', 'Damage per second']);
    expect(ui.primaryDetail).toBe('Server builder detail');
  });

  it('money paths and non-upgrades stay on the original owner review', () => {
    const renderArt = vi.fn(art);
    const declined: Partial<BuildingSnapshotFacts>[] = [
      { paidStep: true, paidOfferReady: true }, { repair: { cost: '1,250', time: '2h' } },
      { job: { id: 'job', kind: 'upgrade', remaining: null, freeFinish: false, canReview: true, cancelRefund: null } },
      { canShowUpgrade: false }, { upgradeCost: null },
    ];
    for (const patch of declined) expect(upgradeSnapshot(facts(patch), renderArt)).toBeNull();
    expect(renderArt).not.toHaveBeenCalled();
  });

  it.each(['GEMS', 'SOL', 'KEEP', 'SKR', 'ITEM', 'UNKNOWN', null])('declines %s currency without a Shards fallback or alternate spend route', (upgradeCurrency) => {
    expect(upgradeSnapshot(facts({ upgradeCurrency }), art)).toBeNull();
  });

  it('short of Shards shows the exact shortfall and a navigation-only Mines label', () => {
    const ui = upgradeSnapshot(facts({ shardsBalance: '341' }), art)!;
    expect(ui.state).toBe('SHORT'); expect(ui.price.status).toBe('SHORT'); expect(ui.shortfall).toBe('180');
    expect(ui.bestDoorLabel).toBe('Mines hold 8,400');
    expect(upgradeSnapshot(facts({ shardsBalance: '1', mine: { mineBuildingId: null, accrued: null } }), art)?.bestDoorLabel).toBe('Build a Mine');
    expect(upgradeSnapshot(facts({ shardsBalance: '1', mine: { mineBuildingId: 'mine', accrued: null } }), art)?.bestDoorLabel).toBe('Collect at your Mines');
  });

  it('an unknown balance is never a shortfall and the unchanged owner must still admit the action', () => {
    const ui = upgradeSnapshot(facts({ shardsBalance: null }), art)!;
    // WHY: Android MoneyMapperCommon (b5df7141) returns CHECKING for an unknown balance;
    // the frozen primary look must wait without sending, even if the snapshot state remains READY.
    expect(ui.state).toBe('READY'); expect(ui.shortfall).toBeNull(); expect(ui.bestDoorLabel).toBeNull();
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'CHECKING' });
    expect(upgradePrimaryLook(ui.state, ui.price, ui.reason)).toMatchObject({ kind: 'WAIT_PRICE', sends: false });
  });

  it.each([null, '', '-5', 'invalid', '00', '521.0', '+521', ' 521', '521\n'])('never sends when raw cost %s is missing or noncanonical', (upgradeCostRaw) => {
    const ui = upgradeSnapshot(facts({ upgradeCostRaw }), art)!;
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
    expect(upgradePrimaryLook(ui.state, ui.price, ui.reason)).toMatchObject({ kind: 'OFF', sends: false });
  });

  it.each(['', '00', '1.5', '-1', 'invalid', '+900', ' 900', '900\n'])('keeps a noncanonical balance %s CHECKING with no inferred shortfall or send', (shardsBalance) => {
    const ui = upgradeSnapshot(facts({ shardsBalance }), art)!;
    expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'CHECKING' });
    expect(ui.shortfall).toBeNull(); expect(ui.bestDoorLabel).toBeNull();
    expect(upgradePrimaryLook(ui.state, ui.price, ui.reason)).toMatchObject({ kind: 'WAIT_PRICE', sends: false });
  });

  it('no free builder routes to Builders with the supplied next free time, after the shortage branch', () => {
    const ui = upgradeSnapshot(facts({ freeBuilders: 0, nextBuilderFreeIn: '2h 14m' }), art)!;
    expect(ui.state).toBe('NO_BUILDER'); expect(ui.builderFreeIn).toBe('2h 14m'); expect(ui.builders).toBe('0/2 free');
    const short = upgradeSnapshot(facts({ freeBuilders: 0, shardsBalance: '1' }), art)!;
    expect(short.state).toBe('SHORT'); expect(short.builderFreeIn).toBeNull();
  });

  it("only this sheet's own press reads Starting, any other busy is off with Working", () => {
    const busy = facts({ busy: true, enabled: false });
    expect(upgradeSnapshot(busy, art, { sent: true })?.state).toBe('BUSY');
    expect(upgradeSnapshot(busy, art)).toMatchObject({ state: 'READ_ONLY', reason: 'Working…' });
  });

  it('a paused base or saved construction payment stays off and precedes the busy state', () => {
    expect(upgradeSnapshot(facts({ enabled: false, readOnly: true, busy: true }), art, { sent: true }))
      .toMatchObject({ state: 'READ_ONLY', reason: 'Orders are paused here' });
    expect(upgradeSnapshot(facts({ enabled: false, constructionBlocked: true, blockedReason: 'Check the saved payment first' }), art))
      .toMatchObject({ state: 'READ_ONLY', reason: 'Check the saved payment first' });
  });

  it('holds a locally disabled current guard READ_ONLY without overriding busy or uncertain recovery', () => {
    const disabled = facts({ enabled: false, busy: false, blockedReason: 'This selection is not current.' });
    const ui = upgradeSnapshot(disabled, art)!;
    expect(ui).toMatchObject({ state: 'READ_ONLY', reason: 'This selection is not current.' });
    expect(upgradePrimaryLook(ui.state, ui.price, ui.reason).sends).toBe(false);
    expect(upgradeSnapshot(disabled, art, { outcome: { state: 'REFUSED', reason: 'Refused' } })?.state).toBe('READ_ONLY');
    expect(upgradeSnapshot({ ...disabled, busy: true }, art, { sent: true })?.state).toBe('BUSY');
    expect(upgradeSnapshot(disabled, art, { outcome: { state: 'VERIFYING', reason: null } })?.state).toBe('VERIFYING');
  });

  it('preserves the original controller uncertain outcome as VERIFYING even after busy clears', () => {
    const ui = upgradeSnapshot(facts(), art, { outcome: { state: 'VERIFYING', reason: 'Checking whether the upgrade went through.' } })!;
    expect(ui.state).toBe('VERIFYING'); expect(ui.reason).toBe('Checking whether the upgrade went through.');
    expect(upgradePrimaryLook(ui.state, ui.price, ui.reason)).toMatchObject({ kind: 'VERIFYING', sends: false });
    const held = upgradeSnapshot(facts({ constructionBlocked: true, readOnly: true }), art,
      { outcome: { state: 'VERIFYING', reason: null } })!;
    expect(held.state).toBe('VERIFYING'); expect(held.reason).toBe('Checking the upgrade');
  });

  it('maps ERROR only from an explicit authoritative refusal and keeps stronger snapshot gates', () => {
    const outcome = { state: 'REFUSED', reason: 'Server refused the upgrade.' } as const;
    const refused = upgradeSnapshot(facts(), art, { outcome })!;
    expect(refused.state).toBe('ERROR'); expect(refused.reason).toBe('Server refused the upgrade.');
    expect(upgradeSnapshot(facts({ readOnly: true }), art, { outcome })?.state).toBe('READ_ONLY');
    expect(upgradeSnapshot(facts({ freeBuilders: 0 }), art, { outcome })?.state).toBe('NO_BUILDER');
    expect(upgradeSnapshot(facts({ shardsBalance: '1' }), art, { outcome })?.state).toBe('SHORT');
    expect(upgradeSnapshot(facts(), art)?.state).toBe('READY');
  });

  it('an unavailable price keeps READY for the frozen look helper to draw OFF and never invents zero', () => {
    const ui = upgradeSnapshot(facts({ upgradePriced: false, shardsBalance: '1', freeBuilders: 0 }), art)!;
    expect(ui.state).toBe('READY'); expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
    expect(ui.shortfall).toBeNull(); expect(ui.bestDoorLabel).toBeNull();
  });

  it('never treats a catalogue zero or mismatched zero quote as an explicit free-upgrade verdict', () => {
    for (const [upgradeCost, upgradeCostRaw] of [['0', '0'], ['000.00', '0'], ['521', '0'], ['0', '521']] as const) {
      const ui = upgradeSnapshot(facts({ upgradeCost, upgradeCostRaw }), art)!;
      expect(ui.price).toEqual({ currency: 'SHARDS', amount: null, status: 'UNAVAILABLE' });
      expect(upgradePrimaryLook(ui.state, ui.price, ui.reason)).toMatchObject({ kind: 'OFF', sends: false });
    }
  });

  it('uses unknown ellipses independently and leaves supplied duration and detail strings untouched', () => {
    const ui = upgradeSnapshot(facts({ upgradeTime: null, upgradeDetail: null, freeBuilders: null, totalBuilders: null }), art)!;
    expect(ui.time).toBe('…'); expect(ui.builders).toBe('…/… free'); expect(ui.primaryDetail).toBeNull();
    expect(ui.state).toBe('READY');
    expect(upgradeSnapshot(facts({ upgradeTime: '6d 2h' }), art)?.time).toBe('6d 2h');
  });

  it('compares stable art IDs and retains only changed stats without mutating the facts', () => {
    const input = facts({ artNext: 'tower-tier-one', stats: [{ key: 'CAP', now: '20', next: '20' }, { key: 'XYZ', now: null, next: 'server value' }] });
    const before = JSON.stringify(input);
    const ui = upgradeSnapshot(input, art)!;
    expect(ui.newLook).toBe(false); expect(ui.rows).toEqual([{ icon: 'shape:info', label: 'XYZ', old: null, new: 'server value', unlock: false }]);
    expect(upgradeSnapshot(facts({ artNext: ' ' }), art)).toMatchObject({ newLook: false, artNext: null });
    expect(JSON.stringify(input)).toBe(before);
  });
});

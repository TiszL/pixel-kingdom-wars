import { describe, expect, it } from 'vitest';
import type { ResourceChipUi } from '../hudModel';
import { homeResourceChips, hudResourceFocus, type HomeResourceFeature } from './homeResourceChips';
import type { HudResourceAmount } from './hudResourceAmount';
import type { ResourceDrawerAccount, ResourceDrawerObservation, ResourceDrawerScope } from './resourceDrawerMapper';

const ids = ['shards', 'gems', 'keep', 'skr'] as const;
const wallet = 'wallet-a';
const baseId = 'base-a';
const known = (value: string, decimals = 0, unit: 'BASE_UNITS' | 'DECIMAL' = 'BASE_UNITS'): HudResourceAmount =>
  ({ status: 'known', value, decimals, unit });
const unavailable = { status: 'unavailable', reason: 'private provider detail' } as const;

class Fixture {
  account: ResourceDrawerAccount = { signedIn: true, wallet, selectedBaseId: baseId };
  scopes: Record<string, ResourceDrawerScope> = {
    shards: { wallet, baseId, subject: null }, gems: { wallet, baseId, subject: null },
    keep: { wallet, baseId: null, subject: null },
    skr: { wallet, baseId: null, subject: 'owner-admitted-chain-and-mint' },
  };
  icons: Record<string, string> = Object.fromEntries(ids.map(id => [id, `admitted_${id}_hud_icon`]));
  registry: HomeResourceFeature[] = ['hud.shards', 'hud.gems', 'hud.keep', 'hud.resources'].map(id =>
    ({ id, hostKind: 'HUD', surface: 'HUD_SLOT', visible: true, enabled: true }));
  walletLinked = true;
  row(id: string, amount: HudResourceAmount = known('10')): ResourceDrawerObservation {
    return { id, icon: this.icons[id]!, amount, earnedAt: [], spentAt: [],
      kind: 'SPENDABLE', scope: this.scopes[id]!, coverage: 'COMPLETE' };
  }
  rows: readonly ResourceDrawerObservation[] = ids.map(id => this.row(id));
  replace(id: string, change: (row: ResourceDrawerObservation) => ResourceDrawerObservation): void {
    this.rows = this.rows.map(row => row.id === id ? change(row) : row);
  }
  map(): ResourceChipUi[] {
    return homeResourceChips(this.rows, this.account, this.scopes, this.icons, this.registry, this.walletLinked);
  }
  chip(name: string): ResourceChipUi {
    const found = this.map().filter(chip => chip.name?.toLowerCase() === name.toLowerCase());
    expect(found).toHaveLength(1);
    return found[0]!;
  }
}

/** Native HomeResourceChipsTest's 20 names; two registry cases exercise only the local projection seam. */
describe('HomeResourceChips native parity', () => {
  it('readout identity and ordering remain canonical while every tap belongs to the resource drawer', () => {
    const f = new Fixture(); const ui = f.map();
    expect(ui.map(chip => chip.id)).toEqual(['hud.shards', 'hud.gems', 'hud.keep', 'hud.resources']);
    expect(ui.map(chip => chip.name)).toEqual(['Shards', 'Gems', 'KEEP', 'SKR']);
    expect(ui.map(chip => chip.accent)).toEqual(['SHARDS', 'GEMS', 'KEEP', 'SKR']);
    expect(ui.map(chip => chip.icon)).toEqual(ids.map(id => f.icons[id]));
    expect(ui.map(chip => chip.drawerHandle)).toEqual([false, false, false, true]);
    expect(ui.every(chip => chip.fill === null && !chip.plus && chip.gain === null && chip.badge === null)).toBe(true);
  });

  it('currency slots stay fixed when the old individual feature gate is unavailable', () => {
    const f = new Fixture();
    f.registry = f.registry.map(feature => feature.id === 'hud.gems' ? { ...feature, visible: false, enabled: false } : feature);
    expect(f.map().map(chip => chip.name)).toEqual(['Shards', 'Gems', 'KEEP', 'SKR']);
    expect(f.chip('gems').value).toBe('10');
  });

  it('KEEP needs both an observed linked wallet gate and the current account wallet', () => {
    const f = new Fixture(); f.walletLinked = false;
    expect(f.map().map(chip => chip.name)).toEqual(['Shards', 'Gems', 'SKR']);
    expect(homeResourceChips(f.rows, f.account, f.scopes, f.icons, f.registry).map(chip => chip.name))
      .toEqual(['Shards', 'Gems', 'SKR']);
    f.walletLinked = true;
    for (const account of [{ ...f.account, wallet: null }, { ...f.account, wallet: ' ' }, { ...f.account, signedIn: false }]) {
      f.account = account;
      expect(f.map().map(chip => chip.name)).toEqual(['Shards', 'Gems', 'SKR']);
      expect(f.map().every(chip => chip.value === '…')).toBe(true);
    }
  });

  it('a missing producer is unknown and never an absent account or zero balance', () => {
    const f = new Fixture(); f.rows = [];
    expect(f.map()).toHaveLength(4);
    expect(f.map().every(chip => chip.value === '…')).toBe(true);
  });

  it('only an actual exact-scope absent observation renders the absent mark', () => {
    const f = new Fixture(); f.rows = [f.row('skr', { status: 'absent' })];
    expect(f.chip('skr').value).toBe('—'); expect(f.chip('shards').value).toBe('…');
    f.replace('skr', row => ({ ...row, scope: null })); expect(f.chip('skr').value).toBe('…');
  });

  it('equal or conflicting duplicate eligible producers never select a first balance or sum them', () => {
    const f = new Fixture(); const first = f.row('gems');
    for (const second of [{ ...first }, { ...first, amount: known('50') }, { ...first, coverage: 'PARTIAL' as const }]) {
      f.rows = [first, second]; expect(f.chip('gems').value).toBe('…');
    }
  });

  it('claimable held and progression rows cannot contribute to a spendable readout', () => {
    const f = new Fixture(); const spendable = f.row('keep', known('7'));
    const others = (['CLAIMABLE', 'HELD', 'PROGRESSION'] as const).map(kind => ({ ...spendable, kind, amount: known('1000') }));
    f.rows = [...others, spendable]; expect(f.chip('keep').value).toBe('7');
    f.rows = others; expect(f.chip('keep').value).toBe('…');
  });

  it('wallet base and opaque subject mismatches cannot supply the selected quantity', () => {
    const f = new Fixture();
    f.replace('shards', row => ({ ...row, scope: { ...f.scopes.shards!, baseId: 'other-base' } }));
    f.replace('gems', row => ({ ...row, scope: { ...f.scopes.gems!, wallet: 'other-wallet' } }));
    f.replace('keep', row => ({ ...row, scope: { wallet, baseId, subject: null } }));
    f.replace('skr', row => ({ ...row, scope: { ...f.scopes.skr!, subject: 'other-mint' } }));
    expect(f.map().every(chip => chip.value === '…')).toBe(true);
    f.rows = [f.row('skr'), { ...f.row('skr'), scope: { wallet: 'other-wallet', baseId: null, subject: null } }];
    expect(f.chip('skr').value).toBe('10');
  });

  it('missing expected scope or a matching but foreign expectation cannot certify amounts', () => {
    const f = new Fixture(); delete f.scopes.skr; expect(f.chip('skr').value).toBe('…');
    f.scopes.gems = { wallet: 'other-wallet', baseId, subject: null };
    f.replace('gems', row => ({ ...row, scope: f.scopes.gems! })); expect(f.chip('gems').value).toBe('…');
    for (const expected of [{ wallet, baseId: 'other-base', subject: null }, { wallet, baseId: null, subject: null }]) {
      f.scopes.shards = expected; f.replace('shards', row => ({ ...row, scope: expected }));
      expect(f.chip('shards').value).toBe('…');
    }
  });

  it('partial coverage remains unavailable even when its amount is known zero or absent', () => {
    const f = new Fixture();
    for (const amount of [known('0'), known('12'), { status: 'absent' } as const]) {
      f.replace('skr', row => ({ ...row, amount, coverage: 'PARTIAL' })); expect(f.chip('skr').value).toBe('…');
    }
  });

  it('observed zero is preserved for base units and decimal units', () => {
    const f = new Fixture(); f.replace('gems', row => ({ ...row, amount: known('0') }));
    f.replace('keep', row => ({ ...row, amount: known('0.000000', 6, 'DECIMAL') }));
    expect(f.chip('gems').value).toBe('0'); expect(f.chip('keep').value).toBe('0');
    f.replace('gems', row => ({ ...row, scope: null })); expect(f.chip('gems').value).toBe('…');
  });

  it('amounts larger than Long retain every digit in exact descriptions beside compact values', () => {
    const f = new Fixture(); f.replace('shards', row => ({ ...row, amount: known('18446744073709551615') }));
    f.replace('skr', row => ({ ...row, amount: known('18446744073709551615', 9) }));
    expect(f.chip('shards').value).toBe('18446744T');
    expect(f.chip('shards').exactDescription).toBe('Shards 18,446,744,073,709,551,615');
    expect(f.chip('skr').value).toBe('18.4B');
    expect(f.chip('skr').exactDescription).toBe('SKR 18,446,744,073.709551615');
  });

  it('tiny nonzero quantities remain nonzero and decimal inputs are never scaled twice', () => {
    const f = new Fixture(); f.replace('skr', row => ({ ...row, amount: known('1', 255) }));
    f.replace('keep', row => ({ ...row, amount: known('12.345678', 6, 'DECIMAL') }));
    expect(f.chip('skr').value).toBe('<0.01'); expect(f.chip('skr').exactDescription).toBe(`SKR 0.${'0'.repeat(254)}1`);
    expect(f.chip('keep').value).toBe('12.34'); expect(f.chip('keep').exactDescription).toBe('KEEP 12.345678');
  });

  it('loading retired and malformed amounts remain unknown without exposing provider text', () => {
    const f = new Fixture();
    for (const amount of [{ status: 'loading' } as const, unavailable, known('-1'), known('1.0000001', 6, 'DECIMAL')]) {
      f.replace('skr', row => ({ ...row, amount })); expect(f.chip('skr').value).toBe('…');
      expect(f.chip('skr').exactDescription).toBe('SKR …');
    }
  });

  it('visible slots require explicit admitted icon metadata and never invent a fallback', () => {
    const f = new Fixture(); delete f.icons.skr; expect(() => f.map()).toThrow();
    f.icons.skr = ' '; expect(() => f.map()).toThrow();
    f.icons.skr = 'shape:unknown'; expect(f.chip('skr').icon).toBe('shape:unknown');
    f.walletLinked = false; delete f.icons.keep; expect(f.map()).toHaveLength(3);
  });

  it('focus translation is explicit and does not treat arbitrary feature names as resource IDs', () => {
    expect(['hud.shards', 'hud.gems', 'hud.keep', 'hud.resources'].map(hudResourceFocus)).toEqual(ids);
    for (const id of ['hud.skr', 'profile.skrFaucet', 'hud.profile', '__proto__']) expect(hudResourceFocus(id)).toBeNull();
  });

  it('missing canonical drawer metadata cannot create a replacement feature ID', () => {
    const f = new Fixture(); f.registry = f.registry.filter(row => row.id !== 'hud.resources');
    expect(() => f.map()).toThrow();
  });

  it('mapping snapshots cannot mutate caller rows or retain mutable output aliases', () => {
    const f = new Fixture(); const input = [...f.rows]; f.rows = input;
    const before = [...input]; const ui = f.map(); expect(input).toEqual(before); input.length = 0;
    expect(ui).toHaveLength(4); expect(ui.every(chip => chip.value === '10')).toBe(true);
    expect(Object.isFrozen(ui)).toBe(true); expect(ui.every(Object.isFrozen)).toBe(true);
    expect(() => ui.splice(0)).toThrow();
  });

  it('actual runtime resource getter reevaluates live currentness while mapping causes no dispatch', () => {
    // Projection-boundary adaptation only: the composed PhaseEActivityRegistry is unavailable on 3cbf.
    // Actual getter predicate/disposal/dispatch integration must still be tested by the mount owner.
    const f = new Fixture(); const admitted = f.rows;
    const first = f.map(); f.rows = []; expect(f.map().every(chip => chip.value === '…')).toBe(true);
    f.rows = admitted; expect(f.map().every(chip => chip.value === '10')).toBe(true);
    f.rows = []; expect(f.map().every(chip => chip.value === '…')).toBe(true);
    expect(first.every(chip => chip.value === '10')).toBe(true); // No retained observation cache.
  });

  it('conflicting live runtime producers arrive unavailable rather than being summed by the mapper', () => {
    // Projection-boundary adaptation only; actual registry duplicate folding remains a composed-base test.
    const f = new Fixture(); f.rows = [f.row('keep', unavailable)];
    expect(f.chip('keep').value).toBe('…'); expect(f.chip('keep').exactDescription).toBe('KEEP …');
    f.rows = [f.row('keep', known('10')), f.row('keep', known('20'))];
    expect(f.chip('keep').value).toBe('…');
  });
});

/** Native HomeResourceChipsFormattingTest's seven names, plus explicit leader boundary assertions. */
describe('HomeResourceChips formatting parity', () => {
  function skr(amount: HudResourceAmount): ResourceChipUi {
    const f = new Fixture(); f.rows = [f.row('skr', amount)]; return f.chip('skr');
  }

  it('every exact description includes its real resource name and unabbreviated amount', () => {
    const f = new Fixture(); f.rows = ids.map(id => f.row(id, known('123456789')));
    expect(f.map().map(chip => chip.value)).toEqual(['123.4M', '123.4M', '123.4M', '123.4M']);
    expect(f.map().map(chip => chip.exactDescription)).toEqual([
      'Shards 123,456,789', 'Gems 123,456,789', 'KEEP 123,456,789', 'SKR 123,456,789',
    ]);
  });

  it('compact boundaries truncate while exact descriptions retain all admitted digits', () => {
    // 999,999 is seven glyphs. Both actual kits and the native FormattingTest use 999.9K at six.
    const cases = [
      ['0.004', '<0.01', '0.004'], ['0.009999', '<0.01', '0.009999'], ['0.01', '0.01', '0.01'],
      ['0.129', '0.12', '0.129'], ['12.349', '12.34', '12.349'], ['12.3499', '12.34', '12.3499'],
      ['999', '999', '999'], ['1000', '1,000', '1,000'], ['1234.99', '1,234', '1,234.99'],
      ['99999', '99,999', '99,999'], ['99999.99', '99,999', '99,999.99'], ['100000', '100K', '100,000'],
      ['999999', '999.9K', '999,999'], ['1000000', '1M', '1,000,000'], ['1234567', '1.2M', '1,234,567'],
    ] as const;
    for (const [raw, compact, exact] of cases) {
      const chip = skr(known(raw, 6, 'DECIMAL'));
      expect(chip.value).toBe(compact); expect(chip.value.length).toBeLessThanOrEqual(6);
      expect(chip.exactDescription).toBe(`SKR ${exact}`);
    }
  });

  it('equivalent base-unit and decimal observations are formatted once without rescaling', () => {
    const pairs = [
      [known('312500000', 6), known('312.5', 6, 'DECIMAL')],
      [known('1', 9), known('0.000000001', 9, 'DECIMAL')],
      [known('123456789000000000000', 12), known('123456789', 12, 'DECIMAL')],
    ] as const;
    for (const [baseUnits, decimal] of pairs) expect(skr(baseUnits)).toEqual(skr(decimal));
    expect(skr(pairs[0][0]).value).toBe('312.5');
    expect(skr(pairs[1][0]).exactDescription).toBe('SKR 0.000000001');
    expect(skr(pairs[2][0]).exactDescription).toBe('SKR 123,456,789');
  });

  it('known zero absent and unavailable remain distinct in visible and exact strings', () => {
    const cases: readonly (readonly [HudResourceAmount, string])[] = [
      [known('0', 255), '0'], [known('0.000000', 6, 'DECIMAL'), '0'],
      [{ status: 'absent' }, '—'], [{ status: 'loading' }, '…'], [unavailable, '…'],
    ];
    for (const [amount, text] of cases) {
      const chip = skr(amount); expect(chip.value).toBe(text); expect(chip.exactDescription).toBe(`SKR ${text}`);
    }
  });

  it('strict resource grammar rejects kit-parseable malformed inputs before either format', () => {
    const malformed = ['-1', '+1', '01', ' 1', '1 ', '1\n', '.5', '1.', '1e9', '1,000', '', '9'.repeat(257)]
      .flatMap(raw => [known(raw, 6), known(raw, 6, 'DECIMAL')]);
    malformed.push(known('1', -1), known('1', 256), known('1', 0.5), known('1', NaN), known('1.0000001', 6, 'DECIMAL'));
    for (const amount of malformed) {
      const chip = skr(amount); expect(chip.value).toBe('…'); expect(chip.exactDescription).toBe('SKR …');
    }
  });

  it('rejected provenance never leaks a valid quantity through the exact description', () => {
    const f = new Fixture(); const valid = f.row('skr', known('123456789'));
    const rejected: ResourceDrawerObservation[] = [
      { ...valid, scope: null }, { ...valid, scope: { wallet: 'foreign-wallet', baseId: null, subject: null } },
      { ...valid, scope: { wallet, baseId: null, subject: 'unadmitted-subject' } },
      { ...valid, coverage: 'PARTIAL' }, { ...valid, kind: 'CLAIMABLE' },
    ];
    for (const rows of [...rejected.map(row => [row]), [], [valid, { ...valid }]]) {
      f.rows = rows; expect(f.chip('skr').value).toBe('…'); expect(f.chip('skr').exactDescription).toBe('SKR …');
    }
  });

  it('maximum admitted integer retains every digit beyond the kit suffix range', () => {
    const chip = skr(known('9'.repeat(256)));
    // Existing kit policy exceeds six glyphs above 999T instead of clipping the amount.
    expect(chip.value).toBe(`${'9'.repeat(244)}T`);
    expect(chip.exactDescription).toBe(`SKR 9${',999'.repeat(85)}`);
  });
});

describe('HomeResourceChips current admission safeguards', () => {
  it('each visible currency requires canonical HUD slot metadata and duplicate IDs are refused', () => {
    for (const id of ['hud.shards', 'hud.gems', 'hud.keep', 'hud.resources']) {
      for (const patch of [{ hostKind: 'OTHER' }, { surface: 'OTHER' }]) {
        const f = new Fixture(); f.registry = f.registry.map(row => row.id === id ? { ...row, ...patch } : row);
        expect(() => f.map()).toThrow();
      }
      const f = new Fixture(); f.registry = f.registry.filter(row => row.id !== id); expect(() => f.map()).toThrow();
    }
    const f = new Fixture(); f.registry.push({ ...f.registry[0]! }); expect(() => f.map()).toThrow();
  });

  it('linked wallet cannot admit base scoped custodial KEEP even with a matching owner expectation', () => {
    // Current wallet-only KEEP ruling supersedes the older native chip producer's missing guard.
    const f = new Fixture(); f.scopes.keep = { wallet, baseId, subject: null }; f.rows = [f.row('keep', known('7'))];
    expect(f.chip('keep').value).toBe('…'); expect(f.chip('keep').exactDescription).toBe('KEEP …');
  });

  it('Gems requires the selected base and no SOL or reserve readout is invented', () => {
    const f = new Fixture(); f.scopes.gems = { wallet, baseId: null, subject: null }; f.rows = [f.row('gems')];
    expect(f.chip('gems').value).toBe('…');
    f.account = { ...f.account, selectedBaseId: null }; expect(f.chip('shards').value).toBe('…');
    expect(f.map().map(chip => chip.id)).toEqual(['hud.shards', 'hud.gems', 'hud.keep', 'hud.resources']);
  });
});

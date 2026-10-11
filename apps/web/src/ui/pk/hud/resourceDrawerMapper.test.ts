import { describe, expect, it } from 'vitest';
import type { ResourceDrawerUi, ResourceRowUi } from '../hudModel';
import {
  resourceDrawerUi,
  type ResourceDrawerAccount,
  type ResourceDrawerAmount,
  type ResourceDrawerEntry,
  type ResourceDrawerObservation,
  type ResourceDrawerScope,
  type ResourceDrawerSection,
} from './resourceDrawerMapper';

/** Native ResourceDrawerProducerTest's 18 names and contracts; execution belongs to Cedar3. */
describe('ResourceDrawerProducer parity', () => {
  const wallet = 'resource-owner';
  const base = 'base-a';
  const account: ResourceDrawerAccount = { signedIn: true, wallet, selectedBaseId: base };
  const scope: ResourceDrawerScope = { wallet, baseId: base, subject: null };
  const workshop = 'workshop.refine';
  const metadata: ResourceDrawerSection[] = [
    {
      id: 'everyday', title: 'EVERY DAY', icon: '', note: '', layout: 'WIDE_ROWS',
      entries: [{ id: 'shards', name: 'SHARDS', icon: 'shards', purpose: 'Builds your kingdom.', earnedAt: 'Mine' }],
    },
    {
      id: 'workshop', title: 'WORKSHOP', icon: 'ui:workshop-menu', note: 'refined materials', layout: 'TILE_STRIP',
      entries: [{ id: 'plank', name: 'PLANK', icon: 'admitted:plank', purpose: 'A building material.', earnedAt: 'Workshop' }],
    },
  ];
  const known = (value: string, decimals = 0, unit: 'BASE_UNITS' | 'DECIMAL' = 'BASE_UNITS'): ResourceDrawerAmount =>
    ({ status: 'known', value, decimals, unit });
  const resource = (id = 'plank', amount: ResourceDrawerAmount = known('12')): ResourceDrawerObservation => ({
    id, icon: `admitted:${id}`, amount, earnedAt: [workshop], spentAt: [], scope,
    kind: 'SPENDABLE', coverage: 'COMPLETE',
  });
  interface Options {
    rows?: readonly ResourceDrawerObservation[];
    current?: ResourceDrawerAccount;
    scopes?: Readonly<Record<string, ResourceDrawerScope>>;
    sections?: readonly ResourceDrawerSection[];
    focus?: string | null;
    linked?: boolean;
  }
  const map = (options: Options = {}): ResourceDrawerUi => resourceDrawerUi(
    options.rows ?? [resource()], options.current ?? account,
    options.scopes ?? { shards: scope, plank: scope }, options.sections ?? metadata,
    options.focus ?? null, options.linked ?? false,
  );
  const row = (ui: ResourceDrawerUi, id: string): ResourceRowUi => {
    const matches = ui.groups.flatMap(group => group.rows).filter(value => value.id === id);
    expect(matches).toHaveLength(1);
    return matches[0]!;
  };
  const sectionWith = (entry: ResourceDrawerEntry): ResourceDrawerSection => ({ ...metadata[0]!, entries: [entry] });

  it('maps admitted rows into caller catalogued groups and keeps exact focus', () => {
    const ui = map({ focus: 'plank' });
    expect(ui.groups.map(group => group.id)).toEqual(['everyday', 'workshop']);
    expect(ui.groups.map(group => group.layout)).toEqual(['WIDE_ROWS', 'TILE_STRIP']);
    expect(ui.focusRowId).toBe('plank');
    expect(row(ui, 'plank').value).toBe('12');
    expect(row(ui, 'plank').icon).toBe('admitted:plank');
    expect(row(ui, 'plank').earnedAtFeature).toBe(workshop);
    expect(row(ui, 'shards').value).toBe('…');
  });

  it('missing or unknown observations are never zero or empty', () => {
    for (const amount of [{ status: 'loading' }, { status: 'unavailable' }] as const) {
      const result = row(map({ rows: [resource('plank', amount)] }), 'plank');
      expect(result.value).toBe('…');
      expect(result.empty).toBe(false);
    }
    const missing = row(map({ rows: [] }), 'plank');
    expect(missing.value).toBe('…');
    expect(missing.empty).toBe(false);
  });

  it('observed absence and exact known zero remain distinct', () => {
    const absent = row(map({ rows: [resource('plank', { status: 'absent' })] }), 'plank');
    expect(absent.value).toBe('—');
    expect(absent.empty).toBe(false);
    const zero = row(map({ rows: [resource('plank', known('0', 9))] }), 'plank');
    expect(zero.value).toBe('0');
    expect(zero.empty).toBe(true);
    expect(zero.earnedAtFeature).toBe(workshop);
    expect(row(map({ rows: [resource('plank', known('0.000', 3, 'DECIMAL'))] }), 'plank').empty).toBe(true);
  });

  it('scales base units exactly once without floating point or signed long truncation', () => {
    expect(row(map({ rows: [resource('plank', known('123456789012345678901234567891', 9))] }), 'plank').value)
      .toBe('123,456,789,012,345,678,901.234567891');
    expect(row(map({ rows: [resource('plank', known('0.000000001', 9, 'DECIMAL'))] }), 'plank').value)
      .toBe('0.000000001');
    expect(row(map({ rows: [resource('plank', known('1', 9))] }), 'plank').value).toBe('0.000000001');
    expect(row(map({ rows: [resource('plank', known('123.4500', 4, 'DECIMAL'))] }), 'plank').value).toBe('123.45');
    expect(row(map({ rows: [resource('plank', known('1', 255))] }), 'plank').value).toBe(`0.${'0'.repeat(254)}1`);
  });

  it('invalid quantity syntax or excess precision stays unknown', () => {
    const amounts = [
      known('01'), known('-1'), known('1e9'), known('1.001', 2, 'DECIMAL'),
      known(' 1'), known('1\n'), known('+1'), known('1.' , 1, 'DECIMAL'), known('.1', 1, 'DECIMAL'),
      known('01.0', 1, 'DECIMAL'), known(''), known('1'.repeat(257)),
      known('1', -1), known('1', 256), known('1', 0.5), known('1', Number.NaN),
    ];
    for (const amount of amounts) {
      const result = row(map({ rows: [resource('plank', amount)] }), 'plank');
      expect(result.value).toBe('…');
      expect(result.empty).toBe(false);
    }
  });

  it('duplicate matching producers do not select or add a balance', () => {
    const original = resource();
    for (const duplicate of [{ ...original }, { ...original, amount: known('99') }]) {
      const result = row(map({ rows: [original, duplicate] }), 'plank');
      expect(result.value).toBe('…');
      expect(result.earnedAtFeature).toBeNull();
    }
  });

  it('held claimable progression and partial observations cannot fund a spendable row', () => {
    for (const kind of ['HELD', 'CLAIMABLE', 'PROGRESSION'] as const) {
      expect(row(map({ rows: [{ ...resource(), kind }] }), 'plank').value).toBe('…');
    }
    expect(row(map({ rows: [{ ...resource(), coverage: 'PARTIAL' }] }), 'plank').value).toBe('…');
  });

  it('other wallet base or opaque subject never supplies the requested scope', () => {
    for (const other of [{ ...scope, wallet: 'other' }, { ...scope, baseId: 'other' }, { ...scope, subject: 'held' }]) {
      expect(row(map({ rows: [{ ...resource(), scope: other }] }), 'plank').value).toBe('…');
    }
    expect(row(map({ current: { ...account, selectedBaseId: 'other' } }), 'plank').value).toBe('…');
    expect(row(map({ current: { ...account, signedIn: false } }), 'plank').value).toBe('…');
    expect(row(map({ current: { ...account, wallet: 'other' } }), 'plank').value).toBe('…');
    expect(row(map({ scopes: {} }), 'plank').value).toBe('…');
  });

  it('shards and gems reject wallet only scope', () => {
    const walletOnly = { wallet, baseId: null, subject: null };
    expect(row(map({ rows: [{ ...resource('shards'), scope: walletOnly }], scopes: { shards: walletOnly } }), 'shards').value)
      .toBe('…');
  });

  it('KEEP needs explicitly observed wallet linkage and never a custodial substitute', () => {
    const section = sectionWith({ id: 'keep', name: 'KEEP', icon: 'keep', purpose: 'Wallet token', earnedAt: 'Wallet' });
    const walletScope = { wallet, baseId: null, subject: null };
    const observation = { ...resource('keep', known('7')), scope: walletScope };
    const input = { rows: [observation], scopes: { keep: walletScope }, sections: [section] };
    expect(map(input).groups).toEqual([]);
    expect(row(map({ ...input, linked: true }), 'keep').value).toBe('7');
    expect(map({ ...input, current: { ...account, wallet: null }, linked: true }).groups).toEqual([]);
  });

  it('SOL is excluded even if included by the presentation catalog', () => {
    for (const id of ['sol', 'SOL', 'SoL']) {
      const section = sectionWith({ id, name: 'SOL', icon: 'sol', purpose: 'fee', earnedAt: 'Wallet' });
      expect(map({ rows: [resource(id)], sections: [section] }).groups).toEqual([]);
    }
  });

  it('ambiguous earned destinations do not guess one and no money actions are manufactured', () => {
    const result = row(map({ rows: [{ ...resource(), earnedAt: [workshop, 'building.harvester'] }] }), 'plank');
    expect(result.earnedAtFeature).toBeNull();
    expect(result.action).toBeNull();
    expect(result.actionLabel).toBeNull();
    expect(row(map({ rows: [{ ...resource(), earnedAt: [workshop, workshop] }] }), 'plank').earnedAtFeature).toBe(workshop);
  });

  it('unknown focus falls back through the kit and duplicate metadata is refused', () => {
    expect(map({ focus: 'not-a-row' }).focusRowId).toBeNull();
    expect(() => map({ sections: [...metadata, { ...metadata[1]!, id: 'other' }] })).toThrow();
    expect(() => map({ sections: [...metadata, { ...metadata[1]!, entries: [] }] })).toThrow();
    expect(() => map({ sections: [{ ...metadata[0]!, title: ' ' }] })).toThrow();
    expect(() => map({ sections: [sectionWith({ ...metadata[0]!.entries[0]!, icon: ' ' })] })).toThrow();
  });

  it('output collections detach from mutable caller metadata and observations', () => {
    const rows = [resource()];
    const entries = [...metadata[1]!.entries];
    const sections = [metadata[0]!, { ...metadata[1]!, entries }];
    const ui = map({ rows, sections });
    rows.splice(0); sections.splice(0); entries.splice(0);
    expect(ui.groups).toHaveLength(2);
    expect(row(ui, 'plank').value).toBe('12');
    expect(Object.isFrozen(ui.groups)).toBe(true);
    expect(Object.isFrozen(ui.groups[1]!.rows)).toBe(true);
  });

  it('Gems also requires a selected base scope and partial zero remains unknown', () => {
    const section = sectionWith({ id: 'gems', name: 'GEMS', icon: 'gem', purpose: 'Currency', earnedAt: 'Gold Forge' });
    const walletOnly = { wallet, baseId: null, subject: null };
    expect(row(map({ rows: [{ ...resource('gems'), scope: walletOnly }], scopes: { gems: walletOnly }, sections: [section] }), 'gems').value)
      .toBe('…');
    const partial = { ...resource('plank', known('0')), coverage: 'PARTIAL' as const };
    const result = row(map({ rows: [partial] }), 'plank');
    expect(result.value).toBe('…');
    expect(result.empty).toBe(false);
  });

  it('linked wallet cannot turn base scoped custodial KEEP into wallet KEEP', () => {
    const section = sectionWith({ id: 'keep', name: 'KEEP', icon: 'keep', purpose: 'Wallet', earnedAt: 'Wallet' });
    const input = { rows: [resource('keep')], scopes: { keep: scope }, sections: [section], linked: true };
    const result = row(map(input), 'keep');
    expect(result.value).toBe('…');
    expect(result.earnedAtFeature).toBeNull();
    expect(map({ ...input, current: { ...account, signedIn: false } }).groups).toEqual([]);
  });

  it('group GO and explicit row action preserve only destinations admitted by the resource owner', () => {
    const bid = 'island.seeker.bid';
    const observation = { ...resource('skr'), spentAt: [bid] };
    const section = { ...sectionWith({ id: 'skr', name: 'SKR', icon: 'skr', purpose: 'Bids', earnedAt: 'Seeker Island',
      actionLabel: 'BID', action: bid }), go: workshop };
    const ui = map({ rows: [observation], scopes: { skr: scope }, sections: [section] });
    expect(ui.groups[0]!.go).toBe(workshop);
    expect(row(ui, 'skr').action).toBe(bid);
    expect(row(ui, 'skr').actionLabel).toBe('BID');
  });

  it('presentation metadata alone cannot create a group or row action', () => {
    const invented = 'unadmitted.destination';
    const section = { ...metadata[1]!, go: invented,
      entries: [{ ...metadata[1]!.entries[0]!, action: invented, actionLabel: 'GO' }] };
    for (const rows of [[resource()], []]) {
      const ui = map({ rows, sections: [section] });
      expect(ui.groups[0]!.go).toBeNull();
      expect(row(ui, 'plank').action).toBeNull();
      expect(row(ui, 'plank').actionLabel).toBeNull();
    }
    const blankLabel = { ...metadata[1]!, entries: [{ ...metadata[1]!.entries[0]!, action: workshop, actionLabel: ' ' }] };
    expect(row(map({ sections: [blankLabel] }), 'plank').action).toBeNull();
  });
});

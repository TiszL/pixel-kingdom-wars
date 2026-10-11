import { describe, expect, it } from 'vitest';
import type { EdgeButtonUi, ResourceChipUi } from '../hudModel';
import { homeHudUi, type HomeHudInput, type HudFeatureProjection, type HudHomeSnapshot } from './homeHudMapper';

// Same 20 case names as HomeHudMapperTest.kt. Owner helper outputs are explicit
// local inputs until the composed-base mount adapter is admitted (f315f363).
const now = Date.parse('2026-10-02T12:00:00Z');
const definitions = [
  ['profile', 'portrait', 'PROFILE'], ['leagues', 'trophy', 'LEAGUES'],
  ['builders', 'builder', 'BUILDERS'], ['shield', 'shield', 'SHIELD'],
  ['quests', 'quest', 'QUESTS'], ['dailyCache', 'shape:chest', 'DAILY'],
  ['event', 'ui_banner_event', 'EVENT'], ['mail', 'shape:envelope', 'MAIL'],
  ['chat', 'shape:speech', 'CHAT'], ['attack', 'attack', 'ATTACK'],
  ['army', 'ui_icon_warhorn', 'ARMY'], ['map', 'map', 'MAP'], ['build', 'shape:hammer', 'BUILD'],
] as const;
function registry(): HudFeatureProjection[] {
  return definitions.map(([id, key, title]) => ({
    id: `hud.${id}`, title, hostKind: 'HUD', surface: 'HUD_SLOT',
    icon: { state: key.startsWith('shape:') ? 'SHAPE_CONTRACT' : 'RESOLVED', key },
    visible: true, enabled: !['dailyCache', 'event', 'chat', 'army'].includes(id),
  }));
}
function home(patch: Partial<HudHomeSnapshot> = {}): HudHomeSnapshot {
  return { baseId: 'base-a', player: { wallet: 'wallet-a', keepLevel: 12, trophies: '1284' }, ...patch };
}
function fixture(patch: Partial<HomeHudInput> = {}): HomeHudInput {
  return {
    account: { signedIn: true, wallet: 'wallet-a', selectedBaseId: 'base-a' },
    home: home(), community: null, chat: null, event: null, resources: [], registry: registry(),
    nowMs: now, unreadRaids: null, selectionOpen: false, herald: null, context: null, mirrored: false,
    ...patch,
  };
}
function allow(f: HomeHudInput, ...ids: string[]): void {
  f.registry = f.registry.map(row => ids.includes(row.id) ? { ...row, enabled: true } : row);
}
function event(): EdgeButtonUi {
  return { id: 'hud.event', icon: 'ui_banner_event', label: 'EVENT',
    badge: { text: '!', tone: 'INFO', description: 'An admitted event notice' }, glow: true };
}
function job(startedAt: string, finishesAt: string) { return { startedAt, finishesAt }; }

describe('HomeHudMapper — passive owner projection', () => {
  it('unadmitted snapshots remain unknown and produce no invented badges or pips', () => {
    const ui = homeHudUi(fixture({ home: null }));
    expect(ui.profile.level).toBe('…'); expect(ui.profile.portrait).toBeNull();
    expect(ui.trophies?.value).toBe('…'); expect(ui.builders.value).toBe('…'); expect(ui.shield.value).toBe('…');
    expect(ui.builders.dot).toBe(false); expect(ui.resources).toEqual([]);
    expect(ui.rightEdge).toEqual([]); expect(ui.leftEdge).toEqual([]);
    expect(ui.deck.every(button => button.badge === null && button.pips === null)).toBe(true);
    expect(ui.herald).toBeNull(); expect(ui.context).toBeNull();
  });

  it('profile and trophies retain observed values and their canonical doors', () => {
    const f = fixture(); const ui = homeHudUi(f);
    expect(ui.profile).toMatchObject({ id: 'hud.profile', level: '12', portrait: null, description: 'Profile, Keep level 12' });
    expect(ui.trophies).toMatchObject({ id: 'hud.leagues', icon: 'trophy', value: '1,284' });
    expect(ui.trophies?.description).toContain('1,284');
    for (const [value, expected] of [[null, '…'], ['0', '0'], ['9007199254740993123', '9,007,199,254,740,993,123'], ['1e3', '…'], ['1\n', '…']] as const) {
      f.home = home({ player: { keepLevel: 12, trophies: value } });
      expect(homeHudUi(f).trophies?.value).toBe(expected);
    }
  });

  it('foreign base or contradictory wallet never supplies Home figures or base badges', () => {
    const populated = home({ freeBuilders: 1, builderOverview: { free: 1, owned: 2 },
      energy: { free: 2, max: 3 }, quests: [{ completed: true, claimed: false }], dailyClaimable: true });
    for (const foreign of [{ ...populated, baseId: 'other-base' },
      { ...populated, player: { ...populated.player, wallet: 'other-wallet' } }, null]) {
      const f = fixture({ home: foreign }); allow(f, 'hud.dailyCache');
      const ui = homeHudUi(f);
      expect(ui.profile.level).toBe('…'); expect(ui.builders.value).toBe('…'); expect(ui.trophies?.value).toBe('…');
      expect(ui.rightEdge).toEqual([]); expect(ui.deck[0]?.pips).toBeNull();
    }
    for (const account of [{ signedIn: false, wallet: 'wallet-a', selectedBaseId: 'base-a' },
      { signedIn: true, wallet: '', selectedBaseId: 'base-a' },
      { signedIn: true, wallet: 'wallet-a', selectedBaseId: '' }]) {
      expect(homeHudUi(fixture({ home: populated, account })).profile.level).toBe('…');
    }
  });

  it('already admitted resource chips are copied without reformatting amounts or inventing effects', () => {
    const chip: ResourceChipUi = { id: 'hud.shards', icon: 'shards', value: '12.345', fill: null,
      plus: false, badge: null, name: 'Shards', accent: 'SHARDS', gain: null };
    const input = [chip]; const ui = homeHudUi(fixture({ resources: input })); input.length = 0;
    expect(ui.resources).toEqual([chip]); expect(ui.resources[0]?.plus).toBe(false);
    expect(ui.resources[0]?.gain).toBeNull(); expect(ui.resources[0]?.fill).toBeNull();
    for (const collection of [ui.resources, ui.rightEdge, ui.leftEdge, ui.deck]) expect(Object.isFrozen(collection)).toBe(true);
  });

  it('missing raw freeBuilders or missing catalogue cannot turn the typed default into zero free', () => {
    expect(homeHudUi(fixture()).builders.value).toBe('…');
    // A missing/invalid catalogue yields no owner overview, never a default total.
    for (const snapshot of [home({ freeBuilders: 1 }), home({ builderOverview: { free: 0, owned: 2 } }),
      home({ freeBuilders: 3, builderOverview: { free: 3, owned: 2 } })]) {
      const ui = homeHudUi(fixture({ home: snapshot }));
      expect(ui.builders.value).toBe('…'); expect(ui.builders.dot).toBe(false);
    }
  });

  it('free builder count comes from the existing overview and never from job count', () => {
    const ui = homeHudUi(fixture({ home: home({ freeBuilders: 1, builderOverview: { free: 1, owned: 2 },
      jobs: [job('bad', 'bad')] }) }));
    expect(ui.builders).toMatchObject({ id: 'hud.builders', icon: 'builder', value: '1/2', dot: true,
      description: 'Builders: 1 of 2 free' });
  });

  it('busy builders show the earliest valid existing job countdown using the supplied clock', () => {
    const start = '2026-10-02T11:00:00Z';
    const f = fixture({ home: home({ freeBuilders: 0, builderOverview: { free: 0, owned: 2 }, jobs: [
      job(start, '2026-10-02T12:09:00Z'), job('bad', '2026-10-02T12:01:00Z'),
      job(start, '2026-10-02T12:02:00Z'), job('2026-10-02T13:00:00Z', '2026-10-02T12:01:00Z'),
      job('2026-02-01T11:00:00Z', '2026-02-30T12:01:00Z'),
      job(start, '2026-10-02T12:01:00Z\n'),
    ] }) });
    // D-070 and review 633d49b3 override native zero-unit copy: every web duration uses shared fmtDur.
    expect(homeHudUi(f).builders.value).toBe('2m remaining'); expect(homeHudUi(f).builders.dot).toBe(false);
    f.nowMs = null; expect(homeHudUi(f).builders.value).toBe('…');
  });

  it.each([
    [500, '1s remaining'],
    [1_400, '2s remaining'],
    [59_000, '59s remaining'],
    [60_000, '1m remaining'],
    [3_599_000, '59m 59s remaining'],
    [3_600_000, '1h remaining'],
    [86_399_000, '23h 59m remaining'],
    [86_400_000, '1d remaining'],
  ] as const)('uses the shared D-070 builder duration at %i milliseconds: %s', (remainingMs, expected) => {
    const f = fixture({ home: home({ freeBuilders: 0, builderOverview: { free: 0, owned: 2 },
      jobs: [job('2026-10-02T11:00:00Z', new Date(now + remainingMs).toISOString())] }) });
    expect(homeHudUi(f).builders.value).toBe(expected);
    expect(homeHudUi(f).builders.dot).toBe(false);
    expect(f.home?.freeBuilders).toBe(0);
  });

  it('an elapsed builder timer never fabricates a free builder or completed job', () => {
    const snapshot = home({ freeBuilders: 0, builderOverview: { free: 0, owned: 2 },
      jobs: [job('2026-10-02T10:00:00Z', '2026-10-02T11:00:00Z')] });
    const f = fixture({ home: snapshot }); const ui = homeHudUi(f);
    expect(ui.builders.value).toBe('Finishing…'); expect(ui.builders.dot).toBe(false);
    expect(f.home).toBe(snapshot); expect(snapshot.freeBuilders).toBe(0);
    f.home = { ...snapshot, jobs: [] }; expect(homeHudUi(f).builders.value).toBe('…');
  });

  it('shield preserves missing null suppression and raid precedence from the existing owner helper', () => {
    const f = fixture(); expect(homeHudUi(f).shield.value).toBe('…');
    f.home = home({ shield: null }); expect(homeHudUi(f).shield.value).toBe('—');
    // The adapter supplies the owner's admitted formatting (hudShield on Android).
    f.home = home({ shield: 'SUPP · 1M' }); expect(homeHudUi(f).shield.value).toBe('SUPP · 1M');
    f.unreadRaids = 103; const ui = homeHudUi(f);
    expect(ui.shield).toMatchObject({ id: 'hud.shield', value: 'RAIDED ×103', tone: 'DANGER' });
    expect(ui.shield.description).toContain('103');
  });

  it('attack and army pips use observed free energy and ready points without domain arithmetic', () => {
    const ui = homeHudUi(fixture({ home: home({ energy: { free: 2, max: 5 },
      armyStatus: { readyPts: 3, campCapacityPts: 10 } }) }));
    expect(ui.deck[0]?.pips).toEqual([2, 5]); expect(ui.deck[1]?.pips).toEqual([3, 10]);
  });

  it('missing defaulted or impossible army and energy numbers do not render proved pips', () => {
    for (const snapshot of [home({ energy: { max: 5 }, armyStatus: {} }),
      home({ energy: { free: 6, max: 5 }, armyStatus: { readyPts: 1, campCapacityPts: 0 } }),
      home({ energy: { free: -1, max: 5 }, armyStatus: { readyPts: -1, campCapacityPts: 5 } }),
      home({ energy: { free: 1.5, max: 5 }, armyStatus: { readyPts: NaN, campCapacityPts: 5 } })]) {
      expect(homeHudUi(fixture({ home: snapshot })).deck.every(button => button.pips === null)).toBe(true);
    }
    const ui = homeHudUi(fixture({ home: home({ energy: { free: 0, max: 5 },
      armyStatus: { readyPts: 0, campCapacityPts: 5 } }) }));
    expect(ui.deck.slice(0, 2).map(button => button.pips)).toEqual([[0, 5], [0, 5]]);
  });

  it('quests count only explicit completed unclaimed entries and retain the uncapped description', () => {
    const f = fixture({ home: home({ quests: [...Array.from({ length: 101 }, () => ({ completed: true, claimed: false })),
      { completed: true, claimed: true }, { completed: true }, {}] }) });
    const [edge] = homeHudUi(f).rightEdge;
    expect(edge).toMatchObject({ id: 'hud.quests', icon: 'quest', badge: { text: '99+' } });
    expect(edge?.badge?.description).toContain('101');
    f.home = home(); expect(homeHudUi(f).rightEdge).toEqual([]);
  });

  it('daily cache needs explicit claimability and an available registry gate', () => {
    const f = fixture({ home: home({ dailyClaimable: true }) }); expect(homeHudUi(f).rightEdge).toEqual([]);
    allow(f, 'hud.dailyCache');
    expect(homeHudUi(f).rightEdge).toMatchObject([{ id: 'hud.dailyCache', icon: 'shape:chest', badge: { text: '!' } }]);
    f.home = home({ dailyClaimable: false }); expect(homeHudUi(f).rightEdge).toEqual([]);
  });

  it('mail unread is independent of pending rewards and retains full count semantics', () => {
    const f = fixture({ community: { unread: 0 } }); expect(homeHudUi(f).leftEdge).toEqual([]);
    f.community = { unread: 120 }; const [edge] = homeHudUi(f).leftEdge;
    expect(edge).toMatchObject({ id: 'hud.mail', icon: 'shape:envelope', badge: { text: '99+' } });
    expect(edge?.badge?.description).toContain('120');
    f.community = null; expect(homeHudUi(f).leftEdge).toEqual([]);
  });

  it('enabled admitted chat remains reachable without a badge but never through an unknown gate', () => {
    const f = fixture({ chat: { enabled: true, cursor: '0', unread: 0, mentions: 0 } });
    expect(homeHudUi(f).leftEdge).toEqual([]); allow(f, 'hud.chat');
    expect(homeHudUi(f).leftEdge).toMatchObject([{ id: 'hud.chat', icon: 'shape:speech', badge: null }]);
    f.chat = { enabled: true }; expect(homeHudUi(f).leftEdge[0]?.id).toBe('hud.chat');
    f.chat = { enabled: false }; expect(homeHudUi(f).leftEdge).toEqual([]);
    f.chat = null; expect(homeHudUi(f).leftEdge).toEqual([]);
  });

  it('chat badges retain actual unread and mention counts rather than claiming unloaded zeros', () => {
    const f = fixture({ chat: { enabled: true, cursor: '0', unread: 120, mentions: 3 } }); allow(f, 'hud.chat');
    const badge = homeHudUi(f).leftEdge[0]?.badge;
    expect(badge).toMatchObject({ text: '@3', tone: 'REWARD' });
    expect(badge?.description).toContain('120'); expect(badge?.description).toContain('3');
    f.chat = { enabled: true, unread: 120, mentions: 3 }; expect(homeHudUi(f).leftEdge[0]?.badge).toBeNull();
    f.chat = { enabled: true, cursor: '0', unread: 120 }; expect(homeHudUi(f).leftEdge[0]?.badge).toBeNull();
  });

  it('event presentation comes only from its admitted owner and canonical registry gate', () => {
    const f = fixture({ event: event() }); expect(homeHudUi(f).rightEdge).toEqual([]); allow(f, 'hud.event');
    expect(homeHudUi(f).rightEdge).toEqual([f.event]);
    f.event = { ...event(), badge: null }; expect(homeHudUi(f).rightEdge).toEqual([]);
    f.event = null; expect(homeHudUi(f).rightEdge).toEqual([]);
    f.event = { ...event(), id: 'hud.profile' }; expect(() => homeHudUi(f)).toThrow();
    f.event = { ...event(), icon: 'invented' }; expect(() => homeHudUi(f)).toThrow();
  });

  it('deck keeps canonical order verbs and locked ALWAYS doors for the live owner to explain', () => {
    const f = fixture(); const ui = homeHudUi(f);
    expect(ui.deck.map(button => button.id)).toEqual(['hud.attack', 'hud.army', 'hud.map', 'hud.build']);
    expect(ui.deck.map(button => button.verb)).toEqual(['RED', 'CHARCOAL', 'BLUE', 'GREEN']);
    expect(ui.deck.map(button => button.primary)).toEqual([true, false, false, true]);
    expect(ui.deck.map(button => button.icon)).toEqual(['attack', 'ui_icon_warhorn', 'map', 'shape:hammer']);
    expect(f.registry.find(row => row.id === 'hud.army')?.enabled).toBe(false);
    expect(ui.deck.every(button => button.badge === null)).toBe(true);
  });

  it('selection preserves animation content while the owner flags deck and mirrored layout', () => {
    const f = fixture({ home: home({ quests: [{ completed: true, claimed: false }] }),
      herald: { key: 'notice', icon: 'builder', text: 'An admitted notice', target: 'hud.builders' },
      context: { id: 'hud.map', icon: 'map', what: 'An admitted place', where: 'Seeker' } });
    const rest = homeHudUi(f); f.selectionOpen = true; f.mirrored = true; const selected = homeHudUi(f);
    expect(selected.deckVisible).toBe(false); expect(selected.mirrored).toBe(true);
    expect(selected.deck).toEqual(rest.deck); expect(selected.rightEdge).toEqual(rest.rightEdge);
    expect(selected.herald).toBe(f.herald); expect(selected.context).toBe(f.context);
    expect(selected.resources).toEqual(rest.resources);
  });

  it('mapping consumes registry metadata without mutating inputs or inventing unresolved art', () => {
    const f = fixture(); const originalHome = f.home;
    f.registry = f.registry.map(row => row.id === 'hud.builders' ? { ...row, icon: { state: 'RESOLVED', key: 'admitted-builder' } } : row);
    const before = JSON.stringify(f.registry);
    expect(homeHudUi(f).builders.icon).toBe('admitted-builder');
    expect(f.home).toBe(originalHome); expect(JSON.stringify(f.registry)).toBe(before);
    f.registry = f.registry.map(row => row.id === 'hud.builders' ? { ...row, icon: { state: 'UNRESOLVED', key: null } } : row);
    expect(() => homeHudUi(f)).toThrow();
  });

  it('rejects ambiguous or misplaced required metadata and excess resource rows', () => {
    const f = fixture(); const first = f.registry[0]!;
    f.registry = [...f.registry, first]; expect(() => homeHudUi(f)).toThrow();
    for (const patch of [{ visible: false }, { hostKind: 'OTHER' }, { surface: 'OTHER' }]) {
      f.registry = registry().map(row => row.id === 'hud.profile' ? { ...row, ...patch } : row);
      expect(() => homeHudUi(f)).toThrow();
    }
    f.registry = registry().filter(row => row.id !== 'hud.profile'); expect(() => homeHudUi(f)).toThrow();
    f.registry = registry(); f.resources = Array.from({ length: 5 }, () => ({
      id: 'hud.shards', icon: 'shards', value: '…', fill: null, plus: false, badge: null,
    }));
    expect(() => homeHudUi(f)).toThrow();
  });
});

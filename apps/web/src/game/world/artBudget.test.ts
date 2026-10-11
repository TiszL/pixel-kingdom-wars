import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  v2DirewyvernCoreAtlasGroups, v2LocomotionAtlasGroup,
  v2TroopFallbackFxAtlasGroups, v2GloamfangCombatAtlasGroup,
} from '@shardkeep/shared';
import {
  admitAtlasCandidates, basePatrolFirstCandidates, defenseCombatFirstCandidates,
  deployedTroopTypes,
  ON_DEMAND_ART_BUDGET_BYTES,
  prioritizeRequiredWalkers,
} from './artBudget';

const packedMeta = JSON.parse(readFileSync(
  new URL('../../../public/atlas/meta.json', import.meta.url),
  'utf8',
)) as { atlasBytes: Record<string, number> };

describe('admitAtlasCandidates', () => {
  it('reserves combat towers before passive enhancement regardless of snapshot order', () => {
    expect(defenseCombatFirstCandidates(
      [{ id: 'ware:laser', groups: ['laser'] }, { id: 'ware:archer', groups: ['archer'] }],
      [{ id: 'ware:wall', groups: ['wall'] }, { id: 'ware:barracks', groups: ['barracks'] }],
    ).map((candidate) => candidate.id)).toEqual([
      'ware:archer', 'ware:laser', 'ware:barracks', 'ware:wall',
    ]);
  });

  it('admits atomic sets in priority order and counts shared groups once', () => {
    // WHY: every troop set includes v2fx. Charging that shared sheet once per
    // unit would reject valid art; admitting only a body without it would make
    // projectiles disappear.
    const result = admitAtlasCandidates(
      { v2fx: 10, bowman: 30, mage: 40 },
      0,
      new Set(),
      new Set(),
      [
        { id: 'bowman', groups: ['v2fx', 'bowman'] },
        { id: 'mage', groups: ['v2fx', 'mage'] },
      ],
      80,
    );
    expect([...result.accepted]).toEqual(['bowman', 'mage']);
    expect(result.reservedBytes).toBe(80);
  });

  it('fits defensive projectiles plus the compact current Gloam rend shard', () => {
    const groups = [
      'v2bld_cannon_t4', 'v2bld_mortar_t4', 'v2fx',
      v2LocomotionAtlasGroup('gloamfang', 4), v2GloamfangCombatAtlasGroup(4),
    ];
    const admission = admitAtlasCandidates(
      packedMeta.atlasBytes, 0, new Set(), new Set(), [{ id: 'combat-core', groups }],
    );
    expect(admission.accepted.has('combat-core')).toBe(true);
    expect(admission.reservedBytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
  });

  it('admits every legal mixed Cannon/Mortar tier plus its projectile sheet', () => {
    const groups = ['v2fx', ...[1, 2, 3, 4].flatMap((tier) => [
      `v2bld_cannon_t${tier}`, `v2bld_mortar_t${tier}`,
    ])];
    const admission = admitAtlasCandidates(
      packedMeta.atlasBytes, 0, new Set(), new Set(), [{ id: 'all-defences', groups }],
    );
    expect(admission.accepted.has('all-defences')).toBe(true);
    expect(admission.reservedBytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
  });

  it('accounts for resident and in-flight art and rejects overflow atomically', () => {
    const result = admitAtlasCandidates(
      { v2fx: 10, dragon: 45, mage: 30 },
      25,
      new Set(['v2fx']),
      new Set(['dragon']),
      [
        { id: 'dragon', groups: ['v2fx', 'dragon'] },
        { id: 'mage', groups: ['v2fx', 'mage'] },
      ],
      80,
    );
    expect([...result.accepted]).toEqual(['dragon']);
    expect([...result.reservedGroups]).toEqual(['dragon']);
    expect(result.reservedBytes).toBe(70);
  });

  it('fails closed when generated size metadata is missing', () => {
    const result = admitAtlasCandidates(
      { v2fx: 10 },
      0,
      new Set(),
      new Set(),
      [{ id: 'bowman', groups: ['v2fx', 'bowman'] }],
      100,
    );
    expect(result.accepted.size).toBe(0);
    expect(result.reservedGroups.size).toBe(0);
  });

  it('protects actual Dire core, then admits practical walkers in deterministic order', () => {
    // Model BattleScene's priority after Cannon/Mortar: a rendered Dire core
    // first, then each actually rendered compact family in replay order. An
    // impossible later root may degrade, but optional rich art cannot evict the
    // core or the ordinary Bowman/Troll/Plunderer movement already admitted.
    const MiB = 1024 * 1024;
    const core = v2DirewyvernCoreAtlasGroups(1);
    const walkers = ['bowman', 'troll', 'plunderer'] as const;
    const sizes: Record<string, number> = { v2fx: 16 * MiB, impossibleLate: 30 * MiB };
    core.forEach((group, index) => { sizes[group] = (index === 0 ? 16 : 11) * MiB; });
    walkers.forEach((unit) => { sizes[v2LocomotionAtlasGroup(unit, 1)] = 3 * MiB; });
    walkers.forEach((unit) => { sizes[`v2trp_${unit}_t1`] = 38 * MiB; });

    const admission = admitAtlasCandidates(
      sizes, 20 * MiB, new Set(), new Set(), [
        { id: 'dire-core', groups: core },
        ...walkers.map((unit) => ({
          id: `${unit}-compact`, groups: [v2LocomotionAtlasGroup(unit, 1)],
        })),
        { id: 'impossible-late-root', groups: ['impossibleLate'] },
        ...walkers.map((unit) => ({
          id: `${unit}-rich`,
          groups: [v2LocomotionAtlasGroup(unit, 1), 'v2fx', `v2trp_${unit}_t1`],
        })),
      ],
    );

    expect([...admission.accepted]).toEqual([
      'dire-core', 'bowman-compact', 'troll-compact', 'plunderer-compact',
    ]);
    expect(core.every((group) => admission.reservedGroups.has(group))).toBe(true);
    expect(walkers.every((unit) =>
      admission.reservedGroups.has(v2LocomotionAtlasGroup(unit, 1)),
    )).toBe(true);
  });

  it('keeps Bowman, Troll, and Plunderer walking in a real worst-order mixed raid', () => {
    // WHY: these are the three concrete walking regressions reported by the
    // owner. With real generated bytes, event order Dire→Dragon→Bowman→Troll→
    // Plunderer used to spend 95.77 MiB before Plunderer and freeze its legs.
    // Their compact sheets now reserve first; Dragon keeps its tiny CURRENT FX
    // but its optional locomotion may honestly degrade at the 96 MiB wall.
    const walkers = prioritizeRequiredWalkers([
      'direwyvern', 'dragon', 'bowman', 'troll', 'plunderer',
    ]).filter((troop): troop is 'bowman' | 'troll' | 'plunderer' =>
      ['bowman', 'troll', 'plunderer'].includes(troop));
    const candidates = [
      { id: 'defences', groups: ['v2fx', 'v2bld_cannon_t1', 'v2bld_mortar_t1'] },
      { id: 'dire-core', groups: v2DirewyvernCoreAtlasGroups(1) },
      ...walkers.map((troop) => ({
        id: `${troop}-compact`,
        groups: [v2LocomotionAtlasGroup(troop, 1)],
      })),
      { id: 'dragon-current-fx', groups: v2TroopFallbackFxAtlasGroups('dragon', 1) },
      { id: 'dragon-compact', groups: [v2LocomotionAtlasGroup('dragon', 1)] },
    ];
    const admission = admitAtlasCandidates(
      packedMeta.atlasBytes, 0, new Set(), new Set(), candidates,
    );

    expect([...admission.accepted]).toEqual([
      'defences', 'dire-core',
      'bowman-compact', 'troll-compact', 'plunderer-compact',
      'dragon-current-fx',
    ]);
    expect(admission.reservedBytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
  });

  it.each([1, 2, 3, 4])(
    'admits the mandatory T%i Nest/Hatchling lifecycle before every attacker family',
    (tier) => {
      const units = [
        'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider',
        'plunderer', 'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
        'gloamfang', 'direwyvern', 'hexbarrow', 'barrowling',
      ] as const;
      const nest = {
        id: `nest:t${tier}`,
        groups: [`ware_dragonnest_${tier}`, `ware_hatchling_${tier}`, 'warefx'],
      };
      const attackers = units.map((unit) => ({
        id: `attacker:${unit}`,
        groups: [v2LocomotionAtlasGroup(unit, tier)],
      }));
      const occupied = ['v2bld_cannon_t4'];
      // Model a real sleeping-home texture already charged to the on-demand
      // wall. The combat Nest and every rendered attacker still reserve before
      // the chronological optional defender candidate below.
      const occupiedBytes = occupied.reduce(
        (sum, group) => sum + packedMeta.atlasBytes[group]!, 0,
      );
      const admission = admitAtlasCandidates(
        packedMeta.atlasBytes, occupiedBytes, new Set(occupied), new Set(), [
          nest,
          ...attackers,
          { id: 'optional-defender', groups: [`ware_archertower_${tier}`, 'warefx'] },
        ],
      );

      expect(admission.accepted.has(nest.id)).toBe(true);
      expect(attackers.every(({ id }) => admission.accepted.has(id))).toBe(true);
      expect(admission.reservedBytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
    },
  );

  it('requires sleeping home towers to yield before a cross-tier Dire battle', () => {
    // WHY: TextureManager residency is game-global. A sleeping t4 home Cannon +
    // Mortar used to remain charged while the defender's t1 pair and v2fx were
    // admitted, making Dire's 49 MiB functional core impossible. BaseScene now
    // re-keys/hides those sleeping sprites and releases these exact groups first.
    const home = ['v2bld_cannon_t4', 'v2bld_mortar_t4'];
    const homeBytes = home.reduce((sum, group) => sum + packedMeta.atlasBytes[group]!, 0);
    const candidates = [
      { id: 'defences', groups: ['v2fx', 'v2bld_cannon_t1', 'v2bld_mortar_t1'] },
      { id: 'dire-core', groups: v2DirewyvernCoreAtlasGroups(1) },
    ];

    const leakedHome = admitAtlasCandidates(
      packedMeta.atlasBytes,
      homeBytes,
      new Set(home),
      new Set(),
      candidates,
    );
    expect(leakedHome.accepted.has('dire-core')).toBe(false);

    const reclaimedHome = admitAtlasCandidates(
      packedMeta.atlasBytes, 0, new Set(), new Set(), candidates,
    );
    expect([...reclaimedHome.accepted]).toEqual(['defences', 'dire-core']);
    expect(reclaimedHome.reservedBytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
  });
});

describe('basePatrolFirstCandidates', () => {
  it('keeps every compact current patrol moving before rich tower enhancement spend', () => {
    // All 15 rendered V2 roots at one tier are a real ~69 MiB set. Reversing
    // both database-shaped inputs proves admission is driven by stable identity,
    // not row order; >1 frame per group is pinned in patrol.test.ts.
    const units = [
      'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider',
      'plunderer', 'giant', 'troll', 'dragon', 'mage', 'bilgewraith',
      'gloamfang', 'direwyvern', 'hexbarrow', 'barrowling',
    ] as const;
    const patrol = [...units].reverse().map((unit) => ({
      id: `troop:${unit}`,
      groups: [v2LocomotionAtlasGroup(unit, 1)],
    }));
    const enhancements = [1, 2, 3, 4].flatMap((tier) => [
      { id: `building:cannon:t${tier}`, groups: [`v2bld_cannon_t${tier}`] },
      { id: `building:mortar:t${tier}`, groups: [`v2bld_mortar_t${tier}`] },
    ]).reverse();
    const candidates = basePatrolFirstCandidates(patrol, enhancements);
    const admission = admitAtlasCandidates(
      packedMeta.atlasBytes, 0, new Set(), new Set(), candidates,
    );

    expect(candidates.slice(0, units.length).map(({ id }) => id))
      .toEqual(units.map((unit) => `troop:${unit}`).sort());
    expect(units.every((unit) => admission.accepted.has(`troop:${unit}`))).toBe(true);
    const compactBytes = units.reduce(
      (sum, unit) => sum + packedMeta.atlasBytes[v2LocomotionAtlasGroup(unit, 1)]!, 0,
    );
    expect(compactBytes).toBeLessThan(ON_DEMAND_ART_BUDGET_BYTES);
    expect(admission.reservedBytes).toBeLessThanOrEqual(ON_DEMAND_ART_BUDGET_BYTES);
    expect(enhancements.some(({ id }) => !admission.accepted.has(id))).toBe(true);
  });
});

describe('prioritizeRequiredWalkers', () => {
  it('is independent of deploy order and preserves all other relative order', () => {
    expect(prioritizeRequiredWalkers([
      'direwyvern', 'dragon', 'plunderer', 'bowman', 'mage', 'troll',
    ])).toEqual([
      'bowman', 'troll', 'plunderer', 'direwyvern', 'dragon', 'mage',
    ]);
  });
});

describe('deployedTroopTypes', () => {
  it('loads unique deployed and simulator-spawned units while excluding hero donors', () => {
    // WHY: owning eleven troop types must not allocate eleven atlases. Replays
    // and live orders both reveal the exact rendered set in their deploy log.
    expect(deployedTroopTypes([
      { e: 'deploy', troop: 'bowman' },
      { e: 'hit', troop: 'dragon' },
      { e: 'deploy', troop: 'bowman' },
      { e: 'deploy', troop: 'highlander', hero: 'vex' },
      { e: 'deploy', troop: 'mage' },
      { e: 'troopSpawn', troop: 'barrowling', from: 9 },
      { e: 'troopSpawn', troop: 'barrowling', from: 9 },
    ])).toEqual(['bowman', 'mage', 'barrowling']);
  });
});

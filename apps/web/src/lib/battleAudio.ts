import {
  AUDIO_RUNTIME, attackRunCycleStarts, type AttackRunEvent, type TroopType,
} from '@shardkeep/shared';

import type { LegacySfx, ProductionSfx, SfxPlayOptions } from './audio';
import { resolveSfxFamily } from './audio';

const TICK_MS = 100;

export type ReplayEvent = Record<string, unknown> & { t: number; e: string };

export interface PlannedBattleSfx {
  atMs: number;
  family: string;
  variantKey: string;
  fallback?: LegacySfx;
  opts?: SfxPlayOptions;
  /** Actor-scoped loops and the Keg's visual prime are started by their scene
   * handlers so the same actor can stop them. They still belong in the exact
   * preload bank, but must not also be scheduled as ordinary one-shots. */
  dispatch?: 'actorLoop' | 'kegPrime';
}

interface ActorIdentity { troop: TroopType; hero?: 'vex' | 'theodor' }
interface BuildingIdentity { id: string; type: string }

const DEPLOY_FAMILY: Readonly<Record<TroopType, string>> = {
  highlander: 'sfx_troop_highlander_deploy',
  bowman: 'sfx_troop_bowman_deploy',
  kegrunner: 'sfx_troop_kegrunner_deploy_ignite',
  tunneler: 'sfx_troop_tunneler_deploy',
  turrider: 'sfx_troop_turrider_deploy',
  plunderer: 'sfx_troop_plunderer_deploy',
  giant: 'sfx_troop_giant_deploy',
  troll: 'sfx_troop_troll_deploy',
  dragon: 'sfx_troop_dragon_deploy',
  mage: 'sfx_troop_mage_deploy',
  bilgewraith: 'sfx_troop_bilgewraith_deploy',
  gloamfang: 'sfx_troop_gloamfang_deploy',
  direwyvern: 'sfx_troop_direwyvern_deploy',
  hexbarrow: 'sfx_troop_hexbarrow_deploy',
  barrowling: 'sfx_troop_barrowling_spawn',
  wyrmling: 'sfx_troop_wyrmling_spawn',
};

export function troopDeploySfxFamily(
  troop: TroopType,
  hero?: 'vex' | 'theodor',
): string {
  return hero ? `sfx_hero_${hero}_deploy` : DEPLOY_FAMILY[troop];
}

const DEATH_FAMILY: Readonly<Record<TroopType, string>> = Object.fromEntries(
  (Object.keys(DEPLOY_FAMILY) as TroopType[]).map((troop) => [troop, `sfx_troop_${troop}_death`]),
) as Record<TroopType, string>;

const HERO_SKILL_FAMILY: Readonly<Record<string, string>> = {
  crimsonDash: 'sfx_hero_vex_crimson_dash',
  moonsunderWave: 'sfx_hero_vex_moonsunder_wave',
  degenAwakening: 'sfx_hero_vex_degen_awakening',
  doubleOrNothingHeads: 'sfx_hero_vex_double_or_nothing_heads',
  doubleOrNothingTails: 'sfx_hero_vex_double_or_nothing_tails',
  omegaShardstorm: 'sfx_hero_vex_omega_shardstorm',
  cheekQuake: 'sfx_hero_theodor_cheek_quake',
  snotRocket: 'sfx_hero_theodor_snot_rocket',
  cannonball: 'sfx_hero_theodor_cannonball',
  skillIssue: 'sfx_hero_theodor_skill_issue',
  bellyBounce: 'sfx_hero_theodor_belly_bounce',
  brownNote: 'sfx_hero_theodor_brown_note',
  rageQuit: 'sfx_hero_theodor_rage_quit',
  rageQuitWake: 'sfx_hero_theodor_rage_quit_wake',
  silentButDeadly: 'sfx_hero_theodor_silent_but_deadly',
};

function add(
  cues: PlannedBattleSfx[], atMs: number, family: string, variantKey: string,
  fallback?: LegacySfx, opts?: SfxPlayOptions,
  dispatch?: PlannedBattleSfx['dispatch'],
): void {
  cues.push({
    atMs, family, variantKey,
    ...(fallback ? { fallback } : {}),
    ...(opts ? { opts } : {}),
    ...(dispatch ? { dispatch } : {}),
  });
}

function addAttackRun(cues: PlannedBattleSfx[], event: ReplayEvent): void {
  const run = event as unknown as AttackRunEvent;
  let starts: number[];
  try { starts = attackRunCycleStarts(run); } catch { return; }
  for (const start of starts) {
    const releaseMs = start * TICK_MS + run.releaseOffsetMs;
    const impact = (family: string, fallback?: LegacySfx): void => {
      run.impactOffsetsTicks.forEach((offset, index) => add(
        cues, (start + offset) * TICK_MS, family,
        `${run.id}:${start}:impact:${index}`, fallback,
      ));
    };
    const release = (family: string, fallback?: LegacySfx): void =>
      add(cues, releaseMs, family, `${run.id}:${start}:release`, fallback);
    switch (run.troop) {
      case 'highlander': release('sfx_troop_highlander_attack', 'sfx_sword_hit'); break;
      case 'bowman':
        release('sfx_troop_bowman_release', 'sfx_bow_shot');
        impact('sfx_troop_bowman_impact', 'sfx_arrow_hit');
        break;
      case 'kegrunner': break; // the exact `detonate` event owns its blast
      case 'tunneler': release('sfx_troop_tunneler_pick_contact', 'sfx_sword_hit'); break;
      case 'turrider': release('sfx_troop_turrider_horn_gore', 'sfx_sword_hit'); break;
      case 'plunderer': release('sfx_troop_plunderer_sack_attack', 'sfx_sword_hit'); break;
      case 'giant':
        if (run.technique === 'boulder') {
          release('sfx_troop_giant_boulder_release', 'sfx_mortar_thunk');
          impact('sfx_troop_giant_boulder_impact', 'sfx_explosion_big');
        } else release('sfx_troop_giant_melee', 'sfx_sword_hit');
        break;
      case 'troll':
        release(run.targetKind === 'building'
          ? 'sfx_troop_troll_building_pound' : 'sfx_troop_troll_sweep', 'sfx_sword_hit');
        break;
      case 'dragon':
        release('sfx_troop_dragon_breath', 'sfx_bow_shot');
        impact('sfx_troop_dragon_breath_contact', 'sfx_arrow_hit');
        break;
      case 'mage':
        release('sfx_troop_mage_release', 'sfx_bow_shot');
        impact('sfx_troop_mage_impact', 'sfx_arrow_hit');
        break;
      case 'bilgewraith': release('sfx_troop_bilgewraith_chain_attack', 'sfx_sword_hit'); break;
      case 'gloamfang':
        release('sfx_troop_gloamfang_rend', 'sfx_sword_hit');
        impact('sfx_troop_gloamfang_contact');
        break;
      case 'direwyvern':
        if (run.technique === 'maul') impact('sfx_troop_direwyvern_contact', 'sfx_sword_hit');
        break; // firestorm has no fake impact; troopAbility owns its cast bed
      case 'hexbarrow':
        release('sfx_troop_hexbarrow_hexshot_release', 'sfx_bow_shot');
        impact('sfx_troop_hexbarrow_hex_impact', 'sfx_arrow_hit');
        break;
      case 'barrowling': release('sfx_troop_barrowling_attack', 'sfx_sword_hit'); break;
      case 'wyrmling':
        release('sfx_troop_wyrmling_breath', 'sfx_bow_shot');
        impact('sfx_troop_wyrmling_flame_contact', 'sfx_arrow_hit');
        break;
    }
  }
}

function addLegacyAttack(
  cues: PlannedBattleSfx[], event: ReplayEvent, actor: ActorIdentity | undefined,
): void {
  if (!actor) return;
  const at = event.t * TICK_MS;
  const key = `${String(event.id)}:${event.t}:legacy`;
  if (actor.hero) {
    add(cues, at, `sfx_hero_${actor.hero}_primary`, key, 'sfx_sword_hit');
    return;
  }
  const fakeRun = {
    ...event,
    e: 'attackRun', side: 'attacker', troop: actor.troop,
    targetKind: event.targetKind ?? 'building', target: event.target ?? '',
    ix: event.ix ?? 0, iy: event.iy ?? 0,
    mode: event.proj === 'boulder' ? 'projectile' : 'melee',
    technique: event.proj === 'boulder' ? 'boulder' : actor.troop === 'gloamfang' ? 'rend' : 'strike',
    cycleMs: 100, releaseOffsetMs: 0, cycleTicks: 1, releaseOffsetTicks: 0,
    impactOffsetsTicks: [0], cadenceTicks: 1, count: 1,
  } as ReplayEvent;
  addAttackRun(cues, fakeRun);
}

/** SIM9 retains old per-cycle verbs beside a bounded attackRun for rolling
 * clients. One exact actor/tick key must have one audio owner, matching the
 * scene's visual suppression while preserving genuinely legacy-only attacks. */
export function attackRunLegacyCueKeys(events: readonly ReplayEvent[]): Set<string> {
  const keys = new Set<string>();
  for (const event of events) {
    if (event.e !== 'attackRun') continue;
    const run = event as unknown as AttackRunEvent;
    let starts: number[];
    try { starts = attackRunCycleStarts(run); } catch { continue; }
    const verb = run.mode === 'projectile' || run.mode === 'stream'
      ? 'troopFire'
      : run.mode === 'melee' ? 'troopAttack' : null;
    if (!verb) continue;
    for (const tick of starts) keys.add(`${run.id}:${tick}:${verb}`);
  }
  return keys;
}

/** Pure replay-to-audio plan. It never mutates sim events or synthesizes an
 * event that is absent; dormant/future catalog families therefore stay silent. */
export function planBattleSfx(
  events: readonly ReplayEvent[],
  buildings: readonly BuildingIdentity[],
): PlannedBattleSfx[] {
  const cues: PlannedBattleSfx[] = [];
  const actors = new Map<number, ActorIdentity>();
  const buildingTypes = new Map(buildings.map((building) => [building.id, building.type]));
  const authoritativeAttackCues = attackRunLegacyCueKeys(events);
  for (const event of events) {
    const at = event.t * TICK_MS;
    const id = typeof event.id === 'number' ? event.id : -1;
    const key = `${String(event.id ?? event.e)}:${event.t}:${event.e}`;
    if (event.e === 'deploy') {
      const troop = event.troop as TroopType;
      const hero = event.hero === 'vex' || event.hero === 'theodor' ? event.hero : undefined;
      actors.set(id, { troop, ...(hero ? { hero } : {}) });
      add(cues, at, hero ? `sfx_hero_${hero}_deploy` : DEPLOY_FAMILY[troop], key,
        hero === 'vex' ? 'sfx_hero_deploy_vex' : hero === 'theodor'
          ? 'sfx_hero_deploy_theo' : 'sfx_deploy_pop');
      if (!hero && troop === 'kegrunner') {
        add(cues, at, 'sfx_troop_kegrunner_fuse_loop', `${key}:fuse`,
          'sfx_keg_fuse', { loop: true, volume: 0.6 }, 'actorLoop');
      }
      continue;
    }
    if (event.e === 'spawn') {
      const troop = event.troop as TroopType;
      actors.set(id, { troop });
      add(cues, at, DEPLOY_FAMILY[troop], key, 'sfx_deploy_pop');
      if (troop === 'wyrmling') add(cues, at, 'sfx_defense_dragonnest_launch', `${key}:nest`);
      continue;
    }
    if (event.e === 'troopSpawn') {
      actors.set(id, { troop: 'barrowling' });
      add(cues, at, 'sfx_troop_barrowling_spawn', key, 'sfx_deploy_pop');
      continue;
    }
    if (event.e === 'attackRun') { addAttackRun(cues, event); continue; }
    if (event.e === 'troopFire' || event.e === 'troopAttack') {
      if (!authoritativeAttackCues.has(`${String(event.id)}:${event.t}:${event.e}`)) {
        addLegacyAttack(cues, event, actors.get(id));
      }
      continue;
    }
    if (event.e === 'heroAttack') {
      const hero = event.hero as 'vex' | 'theodor';
      add(cues, at, `sfx_hero_${hero}_primary`, key, 'sfx_sword_hit');
      continue;
    }
    if (event.e === 'heroSkill') {
      const skill = String(event.skill);
      const phase = String(event.phase);
      if ((skill === 'cannonball' && phase !== 'impact')
        || (skill === 'silentButDeadly' && phase !== 'impact')) continue;
      const family = HERO_SKILL_FAMILY[skill];
      if (family) add(cues, at, family, key,
        skill === 'crimsonDash' ? 'sfx_hero_dash'
          : skill === 'cheekQuake' ? 'sfx_hero_quake' : undefined);
      continue;
    }
    if (event.e === 'troopAbility') {
      const ability = String(event.ability);
      const family: Record<string, string> = {
        howl: 'sfx_troop_gloamfang_howl',
        leap: 'sfx_troop_gloamfang_lunge',
        lunge: 'sfx_troop_gloamfang_lunge',
        firestorm: 'sfx_troop_direwyvern_firestorm',
        maul: 'sfx_troop_direwyvern_maul',
        disgorge: 'sfx_troop_hexbarrow_disgorge',
      };
      if (family[ability]) add(cues, at, family[ability]!, key);
      continue;
    }
    if (event.e === 'fire') {
      const type = buildingTypes.get(String(event.id));
      const impactAt = at + (Number(event.impactOffsetTicks) || 0) * TICK_MS;
      const families: Record<string, [string, string]> = {
        cannon: ['sfx_defense_cannon_fire', 'sfx_defense_cannon_impact'],
        archertower: ['sfx_defense_archertower_fire', 'sfx_defense_archertower_impact'],
        mortar: ['sfx_defense_mortar_launch', 'sfx_defense_mortar_impact'],
        electrictower: ['sfx_defense_electrictower_fire', 'sfx_defense_electrictower_impact'],
        magetower: ['sfx_defense_magetower_fire', 'sfx_defense_magetower_impact'],
        lasertower: ['sfx_defense_lasertower_fire', 'sfx_defense_lasertower_impact'],
      };
      const pair = type ? families[type] : undefined;
      if (pair) {
        add(cues, at + (Number(event.releaseOffsetMs) || 0), pair[0], `${key}:fire`,
          type === 'cannon' ? 'sfx_cannon_fire' : type === 'mortar' ? 'sfx_mortar_thunk'
            : type === 'archertower' ? 'sfx_bow_shot' : undefined);
        add(cues, impactAt, pair[1], `${key}:impact`, type === 'cannon'
          ? 'sfx_explosion_big' : type === 'archertower' ? 'sfx_arrow_hit' : undefined);
        if (type === 'mortar') add(cues, at, 'sfx_defense_mortar_whistle', `${key}:whistle`, 'sfx_shell_whistle');
      }
      continue;
    }
    if (event.e === 'troopDeath') {
      const actor = actors.get(id);
      if (actor) add(cues, at, actor.hero
        ? `sfx_hero_${actor.hero}_death` : DEATH_FAMILY[actor.troop], key);
      continue;
    }
    if (event.e === 'detonate') {
      add(cues, at, 'sfx_troop_kegrunner_plant_brace', `${key}:prime`,
        undefined, undefined, 'kegPrime');
      add(cues, at, 'sfx_troop_kegrunner_detonation', key, 'sfx_explosion_big');
      continue;
    }
    if (event.e === 'burrow') {
      const troop = actors.get(id)?.troop;
      if (troop === 'tunneler' || troop === 'bilgewraith') {
        add(cues, at, `sfx_troop_${troop}_burrow_loop`, key,
          'sfx_burrow_loop', { loop: true, volume: 0.5 }, 'actorLoop');
      }
      continue;
    }
    if (event.e === 'emerge') {
      const troop = actors.get(id)?.troop;
      if (troop === 'tunneler' || troop === 'bilgewraith') {
        add(cues, at, `sfx_troop_${troop}_emerge`, key, 'sfx_emerge_pop');
      }
      continue;
    }
    if (event.e === 'destroyed') {
      add(cues, at, 'sfx_base_rubble_collapse', key, 'sfx_rubble_crash');
      continue;
    }
    if (event.e === 'trap') {
      add(cues, at, 'sfx_defense_spiketrap_snap', key, 'sfx_trap_snap');
      continue;
    }
    if (event.e === 'rally') {
      add(cues, at, 'sfx_battle_rally', key, 'sfx_rally_horn', { priority: 'critical' });
      continue;
    }
    if (event.e === 'star') {
      const star = Math.max(1, Math.min(3, Number(event.n))) as 1 | 2 | 3;
      add(cues, at, `sfx_battle_star_${star}`, key, `sfx_star_${star}`, { priority: 'critical' });
    }
  }
  return cues.sort((a, b) => a.atMs - b.atMs || a.family.localeCompare(b.family)
    || a.variantKey.localeCompare(b.variantKey));
}

/** Exact promoted files used by this replay; variants are selected with the
 * same family/key hash used at playback. */
export function productionBankForPlan(plan: readonly PlannedBattleSfx[]): ProductionSfx[] {
  return [...new Set(plan.flatMap((cue) => {
    const id = resolveSfxFamily(cue.family, cue.variantKey, cue.opts?.loop === true);
    return id ? [id] : [];
  }))];
}

export function legacyFallbackBankForPlan(plan: readonly PlannedBattleSfx[]): LegacySfx[] {
  return [...new Set(plan.flatMap((cue) => cue.fallback ? [cue.fallback] : []))];
}

export interface ProductionBattleBankWindow {
  startMs: number;
  cues: ProductionSfx[];
}

/** Six-second rolling decode slices keep a 90-second heterogeneous replay from
 * pinning every selected variant for its whole lifetime. Event timing—not
 * roster size—determines the active mobile working set. */
export function productionBankWindowsForPlan(
  plan: readonly PlannedBattleSfx[],
): ProductionBattleBankWindow[] {
  interface AdmissionRank { fallback: boolean; atMs: number; priority: number }
  const windows = new Map<number, Map<ProductionSfx, AdmissionRank>>();
  for (const cue of plan) {
    const id = resolveSfxFamily(cue.family, cue.variantKey, cue.opts?.loop === true);
    if (!id) continue;
    const startMs = Math.floor(cue.atMs / AUDIO_RUNTIME.battleBankWindowMs)
      * AUDIO_RUNTIME.battleBankWindowMs;
    const ids = windows.get(startMs) ?? new Map<ProductionSfx, AdmissionRank>();
    const priority = cue.opts?.priority === 'critical' ? 2
      : cue.opts?.priority === 'ambient' ? 0 : 1;
    const candidate = { fallback: cue.fallback !== undefined, atMs: cue.atMs, priority };
    const prior = ids.get(id);
    if (!prior || Number(candidate.fallback) < Number(prior.fallback)
      || (candidate.fallback === prior.fallback && candidate.atMs < prior.atMs)
      || (candidate.fallback === prior.fallback && candidate.atMs === prior.atMs
        && candidate.priority > prior.priority)) ids.set(id, candidate);
    windows.set(startMs, ids);
  }
  return [...windows].sort((a, b) => a[0] - b[0]).map(([startMs, ids]) => ({
    startMs,
    // A cue without a compatibility fallback must win scarce decoded capacity;
    // within each class, playback chronology wins and stable ID breaks ties.
    cues: [...ids].sort((a, b) => Number(a[1].fallback) - Number(b[1].fallback)
      || a[1].atMs - b[1].atMs || b[1].priority - a[1].priority
      || a[0].localeCompare(b[0]))
      .map(([id]) => id),
  }));
}
